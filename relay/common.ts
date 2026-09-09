/**
 * Shared relay plumbing (pattern: agent-only-wallet/relay/common.mjs, retargeted to Zero One):
 * deployment record, chain and RPC client, sponsor key and policy, ABIs, JSON and atomic writes.
 * Every chain-specific constant derives from the deployment file (`ZERO_ONE_DEPLOYMENT`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, defineChain, fallback, getAddress, http, isAddress, type Abi, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import { loadBaalArtifact, loadLocalAbi, loadLocalArtifact, type WriteContext } from "../src/baal.js";
import { SETTLEMENT_UNIT, UNIT } from "../src/zeroOne.js";

export { SETTLEMENT_UNIT, UNIT };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The deployment record written by scripts/deploy-local.ts (and, later, the Base deploy script). */
export interface Deployment {
  rpcUrl?: string;
  chainId: number;
  deployer: Address;
  founder: Address;
  settlement: Address;
  safe: Address;
  baal: Address;
  shares: Address;
  loot: Address;
  depositShaman: Address;
  workManager: Address;
  /** CREATE2 TemplateFactory (decision.md phase 2b ruling 2). */
  templateFactory: Address;
  treasuryLedger?: Address;
  templateDeployers?: [Address, Address, Address, Address];
  intentAccount: Address;
  constitution: { address: Address; textHash: Hex; textUrl: string; text?: string };
  singletons?: { multiSend?: Address };
  governance: { votingPeriod: number; gracePeriod: number; proposalOffering: string; quorumPercent: string; sponsorThreshold: string; minRetentionPercent: string };
  genesis?: { depositUsdc6: string; sharesMinted: string; approveHash: Hex; depositHash: Hex };
  /** Block at which the DAO was deployed; log scans start here (default 0). */
  startBlock?: number;
}

const ADDRESS_FIELDS = ["settlement", "safe", "baal", "shares", "loot", "depositShaman", "workManager", "templateFactory", "intentAccount"] as const;

/**
 * Read and validate a deployment record.
 *
 * @param file Path of the JSON record (default env ZERO_ONE_DEPLOYMENT, else deployments/local.json).
 * @returns The parsed record with checksummed addresses.
 * @throws Error if a required address is missing or malformed.
 */
export function loadDeployment(file: string = process.env.ZERO_ONE_DEPLOYMENT ?? path.join(ROOT, "deployments", "local.json")): Deployment {
  const parsed = JSON.parse(readFileSync(path.resolve(ROOT, file), "utf8")) as Deployment;
  for (const field of ADDRESS_FIELDS) {
    const value = parsed[field];
    if (typeof value !== "string" || !isAddress(value)) throw new Error(`deployment ${file}: ${field} is not an address`);
    parsed[field] = getAddress(value);
  }
  if (!isAddress(parsed.constitution?.address ?? "")) throw new Error(`deployment ${file}: constitution.address missing`);
  parsed.constitution.address = getAddress(parsed.constitution.address);
  if (!Number.isSafeInteger(parsed.chainId) || parsed.chainId < 1) throw new Error(`deployment ${file}: chainId missing`);
  return parsed;
}

/** Relay sponsor policy per chain (mainnet caps are hard; test chains get a settlement faucet). */
export interface Policy {
  mainnet: boolean;
  /** Daily gas sponsorship cap in wei (worst-case reservation per request, persisted before broadcast). */
  dailyWei: bigint;
  /** Sponsor balance that must remain after reserving a request. */
  floorWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Test chains only: the relay tops the member's settlement (USDC-mock) up to the deposit amount from the sponsor's own balance. */
  faucet: boolean;
  /** Daily faucet cap in settlement units. */
  faucetDailyUnits: bigint;
  explorer: string;
  name: string;
}

/**
 * Sponsor policy for a chain id.
 *
 * @param chainId The deployment chain id.
 * @returns The policy (Base mainnet: no faucet, tight caps; Base Sepolia and local anvil: faucet on).
 */
export function policyFor(chainId: number): Policy {
  if (chainId === 8453) {
    return { mainnet: true, dailyWei: 2_000_000_000_000_000n, floorWei: 3_000_000_000_000_000n, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n, faucet: false, faucetDailyUnits: 0n, explorer: "https://basescan.org", name: "Base" };
  }
  if (chainId === 84532) {
    // Base Sepolia base fee sits near 0.005 gwei (observed 2026-09-08); a 3 gwei ceiling reserved 500x the
    // real cost per request and starved a 0.01 ETH sponsor after three proposals (503). 0.05 gwei keeps 10x headroom.
    return { mainnet: false, dailyWei: 30_000_000_000_000_000n, floorWei: 500_000_000_000_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 5_000_000n, faucet: true, faucetDailyUnits: 10_000n * SETTLEMENT_UNIT, explorer: "https://sepolia.basescan.org", name: "Base Sepolia" };
  }
  return { mainnet: false, dailyWei: 10n ** 21n, floorWei: 10n ** 18n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, faucet: true, faucetDailyUnits: 100_000n * SETTLEMENT_UNIT, explorer: "", name: "local mirror" };
}

/** Public RPC alternates per chain: the load-balanced primary rate-limits bursts ("over rate limit"), so reads and sends fall back. */
export const RPC_ALTERNATES: Record<number, string[]> = {
  84532: ["https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org", "https://base-sepolia.gateway.tenderly.co"],
  8453: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
};

/**
 * Transport for a chain: the chain's default RPC first, then the public alternates (viem `fallback`),
 * each retried with a short delay; a local mirror has a single endpoint.
 *
 * @param chain The chain definition (default RPC bound).
 * @returns The transport.
 */
export function transportFor(chain: Chain): Transport {
  const primary = chain.rpcUrls.default.http[0]!;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(primary).hostname);
  const alternates = (local ? [] : RPC_ALTERNATES[chain.id] ?? []).filter((url) => url !== primary);
  const options = { retryCount: 3, retryDelay: 1_200, timeout: 60_000 };
  if (alternates.length === 0) return http(primary, options);
  return fallback([http(primary, options), ...alternates.map((url) => http(url, options))], { rank: false, retryCount: 1 });
}

/**
 * viem chain for a deployment: Base, Base Sepolia, or a local anvil chain defined from the record.
 *
 * @param deployment The deployment record.
 * @returns The chain definition whose default RPC is `ZERO_ONE_RPC_URL`, else the record's rpcUrl, else the public default.
 * @throws Error if a local chain has no rpcUrl.
 */
export function chainFor(deployment: Deployment): Chain {
  const override = process.env.ZERO_ONE_RPC_URL;
  if (deployment.chainId === 8453 || deployment.chainId === 84532) {
    const known = deployment.chainId === 8453 ? base : baseSepolia;
    const url = override ?? deployment.rpcUrl ?? known.rpcUrls.default.http[0];
    return { ...known, rpcUrls: { default: { http: [url] } } };
  }
  const url = override ?? deployment.rpcUrl;
  if (url === undefined) throw new Error("local deployment has no rpcUrl and ZERO_ONE_RPC_URL is unset");
  return defineChain({ id: deployment.chainId, name: "Zero One local mirror", nativeCurrency: { name: "test ETH", symbol: "TETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
}

/** Everything a relay process or a beacon build needs to talk to one deployment. */
export interface Env {
  deployment: Deployment;
  chain: Chain;
  policy: Policy;
  publicClient: PublicClient;
  abi: {
    baal: Abi;
    safe: Abi;
    multiSend: Abi;
    shares: Abi;
    settlement: Abi;
    deposit: Abi;
    work: Abi;
    constitution: Abi;
    account: Abi;
    factory: Abi;
    ledger: Abi;
    proposal: Abi;
    payment: Abi;
    strategy: Abi;
    project: Abi;
    config: Abi;
    dex: Abi;
  };
  stateDir: string;
}

/**
 * Connect to the deployment's chain (read-only).
 *
 * @param deployment The deployment record (default: loadDeployment()).
 * @returns Chain, policy, public client, ABIs and the relay state directory.
 */
export function connect(deployment: Deployment = loadDeployment()): Env {
  const chain = chainFor(deployment);
  const publicClient = createPublicClient({ chain, transport: transportFor(chain), cacheTime: 0 });
  const stateDir = path.resolve(ROOT, process.env.RELAY_STATE_DIR ?? path.join("state", "relay"));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    deployment,
    chain,
    policy: policyFor(deployment.chainId),
    publicClient,
    abi: {
      baal: loadBaalArtifact("Baal").abi,
      safe: loadBaalArtifact("GnosisSafe").abi,
      multiSend: loadBaalArtifact("MultiSend").abi,
      shares: loadLocalArtifact("NavShareToken").abi,
      settlement: loadLocalArtifact("TestToken").abi,
      deposit: loadLocalArtifact("DepositShaman").abi,
      work: loadLocalArtifact("WorkManager").abi,
      constitution: loadLocalArtifact("Constitution").abi,
      account: loadLocalArtifact("ZeroOneIntentAccount").abi,
      factory: loadLocalArtifact("TemplateFactory").abi,
      ledger: loadLocalArtifact("TreasuryLedger").abi,
      proposal: loadLocalAbi("ProposalBase"),
      payment: loadLocalArtifact("PaymentProposal").abi,
      strategy: loadLocalArtifact("StrategyProposal").abi,
      project: loadLocalArtifact("ProjectProposal").abi,
      config: loadLocalArtifact("ConfigProposal").abi,
      dex: loadLocalArtifact("MockDex").abi,
    },
    stateDir,
  };
}

/**
 * The sponsor key: `RELAY_SPONSOR_KEY` in the environment, else the `RELAY_SPONSOR_KEY=` line of
 * `RELAY_ENV_FILE` (default `.env`). Never committed; never logged.
 *
 * @returns The sponsor account.
 * @throws Error if no key is configured.
 */
export function sponsorAccount(): PrivateKeyAccount {
  let key = process.env.RELAY_SPONSOR_KEY;
  if (key === undefined) {
    const file = path.resolve(ROOT, process.env.RELAY_ENV_FILE ?? ".env");
    const line = readFileSync(file, "utf8").split(/\r?\n/u).find((candidate) => /^RELAY_SPONSOR_KEY\s*=/u.test(candidate));
    if (line === undefined) throw new Error(`sponsor credential missing: set RELAY_SPONSOR_KEY or add it to ${file}`);
    key = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/gu, "");
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error("RELAY_SPONSOR_KEY must be a 0x-prefixed 32-byte hex key");
  return privateKeyToAccount(key as Hex);
}

/**
 * A write context for the sponsor on the deployment's chain.
 *
 * @param env The connected environment.
 * @param account The sponsor account (default sponsorAccount()).
 * @returns Public + wallet clients bound to the sponsor.
 */
export function sponsorContext(env: Env, account: PrivateKeyAccount = sponsorAccount()): WriteContext {
  const walletClient: WalletClient = createWalletClient({ account, chain: env.chain, transport: transportFor(env.chain) });
  return { publicClient: env.publicClient, walletClient, account, chain: env.chain };
}

/** JSON with bigints as decimal strings, two-space indented, newline-terminated. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;
}

/** Write `data` as JSON to `file` atomically (write .new, rename), mode 0600. */
export function atomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.new`;
  writeFileSync(temporary, json(data), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Zero bytes32 and zero address. */
export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/** Explicit gas for Baal.processProposal (DESIGN.md §7; PARAMETERS "Execution gas"): never the estimate. */
export const PROCESS_GAS = 5_000_000n;

/** Human formatting helpers (6-dec settlement, 18-dec shares). */
export function fmtUsdc(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SETTLEMENT_UNIT;
  const frac = (abs % SETTLEMENT_UNIT).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function fmtShares(value: bigint): string {
  const whole = value / UNIT;
  const frac = (value % UNIT).toString().padStart(18, "0").replace(/0+$/u, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}
