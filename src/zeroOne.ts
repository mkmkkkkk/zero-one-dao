/** Stand up the whole Zero One DAO (Baal + Safe + tokens + shamans + constitution) on a connected chain. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, parseAbiItem, zeroAddress, type Address, type Hex } from "viem";

import {
  createBaalProxy,
  createSafeProxy,
  deployBaalInfrastructure,
  initializeSafeAndBaal,
  loadBaalArtifact,
  loadLocalArtifact,
  type BaalInfrastructure,
  type GovernanceConfig,
  type WriteContext,
} from "./baal.js";
import { assertInvariant, deployLocal, writeAndWait } from "./onchain.js";

export const UNIT = 10n ** 18n;
/** One settlement unit: USDC has 6 decimals (mirror TestToken "USDC-mock" matches). */
export const SETTLEMENT_UNIT = 10n ** 6n;
/** Base mainnet USDC; documented in docs/PARAMETERS.md, not deployed to or used anywhere yet. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const HOUR = 60 * 60;
/** The constitution text whose keccak256 is the immutable hash of the deployment (DESIGN.md §10). */
export const CONSTITUTION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "CONSTITUTION.md");
/** Where the text can be read; the hash, not the URL, is the authority. Mainnet value: docs/PARAMETERS.md (DECIDE). */
export const CONSTITUTION_TEXT_URL = "docs/CONSTITUTION.md";

/**
 * keccak256 over the exact bytes of docs/CONSTITUTION.md (no normalization of any kind).
 *
 * @param file Path of the constitution text (default CONSTITUTION_PATH).
 * @returns The 32-byte hash as hex.
 * @throws Error if the file is missing or empty.
 */
export function constitutionHash(file: string = CONSTITUTION_PATH): Hex {
  const bytes = readFileSync(file);
  if (bytes.length === 0) throw new Error(`constitution text is empty: ${file}`);
  return keccak256(bytes);
}
/** Genesis deposit by the founder: 50 USDC -> 50e18 shares, the only thing minted at genesis (DESIGN.md §6). */
export const GENESIS_DEPOSIT = 50n * SETTLEMENT_UNIT;

/** Initial governance parameters (DESIGN.md §3); every one is changeable by proposal. */
export const INITIAL_GOVERNANCE: GovernanceConfig = {
  votingPeriod: 6 * HOUR,
  gracePeriod: 6 * HOUR,
  proposalOffering: 0n,
  quorumPercent: 0n,
  sponsorThreshold: 1n * UNIT,
  minRetentionPercent: 66n,
};

export interface ZeroOneParams {
  /** The deployer; an ordinary member whose only shares come from deposits at NAV or voted work. */
  founder: Address;
  shareName: string;
  shareSymbol: string;
  governance: GovernanceConfig;
  /** Existing settlement ERC-20 (Base: BASE_USDC); when absent a 6-dec "USDC-mock" TestToken is deployed and held by the deployer. */
  settlement?: Address;
  /** Fixed supply of the mirror USDC-mock, in 6-decimal units. */
  testSettlementSupply: bigint;
  salt: bigint;
}

export const DEFAULT_PARAMS: Omit<ZeroOneParams, "founder"> = {
  shareName: "Zero One Shares",
  shareSymbol: "ZERO1",
  governance: INITIAL_GOVERNANCE,
  testSettlementSupply: 100_000_000n * SETTLEMENT_UNIT,
  salt: 1n,
};

export interface ZeroOneDao {
  infrastructure: BaalInfrastructure;
  settlement: Address;
  safe: Address;
  baal: Address;
  shares: Address;
  loot: Address;
  depositShaman: Address;
  workManager: Address;
  /** CREATE2 template factory (decision.md phase 2b ruling 2); the intent account's op 0 deploys through it. */
  templateFactory: Address;
  /** Per-template CREATE2 deployers the factory dispatches to: [Payment, Strategy, Project, Config]. */
  templateDeployers: [Address, Address, Address, Address];
  intentAccount: Address;
  /** Constitution contract: immutable keccak256 of docs/CONSTITUTION.md + text URL, no setter. */
  constitution: Address;
  constitutionHash: Hex;
  constitutionTextUrl: string;
  params: ZeroOneParams;
  txHashes: Record<string, Hex>;
}

/**
 * Deploy Zero One: vendored Baal/Safe singletons, Safe + Baal proxies, NavShareToken, LootToken,
 * DepositShaman, WorkManager, the four CREATE2 template deployers + TemplateFactory, the 7702 intent
 * adapter (bound to the factory), the Constitution (hash of docs/CONSTITUTION.md, immutable), then
 * initialize Baal and the Safe. The only two manager shamans are DepositShaman and
 * WorkManager; nothing is minted here (see genesisDeposit).
 *
 * @param deployer Signer that pays for every deployment; becomes `params.founder` by convention.
 * @param params Names, governance config, settlement token and create2 salt.
 * @returns Every address and transaction hash of the deployment.
 * @throws Error if any post-initialization invariant fails or totalShares != 0 after setup.
 */
export async function deployZeroOne(deployer: WriteContext, params: ZeroOneParams): Promise<ZeroOneDao> {
  const txHashes: Record<string, Hex> = {};
  const infrastructure = await deployBaalInfrastructure(deployer);
  ["Baal", "ModuleProxyFactory", "GnosisSafe", "GnosisSafeProxyFactory", "MultiSend"].forEach((name, index) => {
    txHashes[`singleton:${name}`] = infrastructure.deploymentTransactions[index]!;
  });

  let settlement: Address;
  if (params.settlement !== undefined) {
    settlement = getAddress(params.settlement);
  } else {
    const token = await deployLocal(deployer, "TestToken", ["USDC-mock", "USDC", params.testSettlementSupply]);
    settlement = token.address;
    txHashes["TestToken"] = token.hash;
  }

  const safeProxy = await createSafeProxy(deployer, infrastructure, params.salt * 2n);
  const baalProxy = await createBaalProxy(deployer, infrastructure, params.salt * 2n + 1n);
  txHashes["SafeProxy"] = safeProxy.hash;
  txHashes["BaalProxy"] = baalProxy.hash;
  const safe = safeProxy.safe;
  const baal = baalProxy.baal;

  const shares = await deployLocal(deployer, "NavShareToken", [params.shareName, params.shareSymbol, baal, safe, settlement]);
  const loot = await deployLocal(deployer, "LootToken", [`${params.shareName} Loot`, `${params.shareSymbol}-LOOT`, baal]);
  const depositShaman = await deployLocal(deployer, "DepositShaman", [baal, shares.address]);
  const workManager = await deployLocal(deployer, "WorkManager", [baal, shares.address]);
  const paymentDeployer = await deployLocal(deployer, "PaymentDeployer", [safe, settlement]);
  const strategyDeployer = await deployLocal(deployer, "StrategyDeployer", [safe, settlement]);
  const projectDeployer = await deployLocal(deployer, "ProjectDeployer", [safe, settlement]);
  const configDeployer = await deployLocal(deployer, "ConfigDeployer", [safe, settlement, baal]);
  const templateDeployers: [Address, Address, Address, Address] = [paymentDeployer.address, strategyDeployer.address, projectDeployer.address, configDeployer.address];
  const templateFactory = await deployLocal(deployer, "TemplateFactory", [safe, settlement, baal, templateDeployers]);
  const intentAccount = await deployLocal(deployer, "ZeroOneIntentAccount", [baal, depositShaman.address, workManager.address, templateFactory.address]);
  txHashes["NavShareToken"] = shares.hash;
  txHashes["LootToken"] = loot.hash;
  txHashes["DepositShaman"] = depositShaman.hash;
  txHashes["WorkManager"] = workManager.hash;
  txHashes["PaymentDeployer"] = paymentDeployer.hash;
  txHashes["StrategyDeployer"] = strategyDeployer.hash;
  txHashes["ProjectDeployer"] = projectDeployer.hash;
  txHashes["ConfigDeployer"] = configDeployer.hash;
  txHashes["TemplateFactory"] = templateFactory.hash;
  txHashes["ZeroOneIntentAccount"] = intentAccount.hash;
  for (const [index, name] of ["Payment", "Strategy", "Project", "Config"].entries()) {
    const reported = (await deployer.publicClient.readContract({ address: templateFactory.address, abi: templateFactory.artifact.abi, functionName: "templateName", args: [index] })) as string;
    assertInvariant(reported === name, `TemplateFactory template ${index} is ${name}`);
  }
  const textHash = constitutionHash();
  const constitution = await deployLocal(deployer, "Constitution", [textHash, CONSTITUTION_TEXT_URL]);
  txHashes["Constitution"] = constitution.hash;
  const onChainHash = (await deployer.publicClient.readContract({ address: constitution.address, abi: constitution.artifact.abi, functionName: "textHash" })) as Hex;
  assertInvariant(onChainHash === textHash, "Constitution.textHash equals keccak256(docs/CONSTITUTION.md)");

  const initialized = await initializeSafeAndBaal(deployer, infrastructure, {
    safe,
    baal,
    shares: shares.address,
    loot: loot.address,
    managerShamans: [depositShaman.address, workManager.address],
    governance: params.governance,
  });
  txHashes["Safe.setup"] = initialized.safeSetupHash;
  txHashes["Baal.setUp"] = initialized.baalSetupHash;

  const baalAbi = loadBaalArtifact("Baal").abi;
  const totalShares = await deployer.publicClient.readContract({ address: baal, abi: baalAbi, functionName: "totalShares" });
  assertInvariant(totalShares === 0n, "genesis must start with zero shares; every share comes from a shaman");

  return {
    infrastructure,
    settlement,
    safe,
    baal,
    shares: shares.address,
    loot: loot.address,
    depositShaman: depositShaman.address,
    workManager: workManager.address,
    templateFactory: templateFactory.address,
    templateDeployers,
    intentAccount: intentAccount.address,
    constitution: constitution.address,
    constitutionHash: textHash,
    constitutionTextUrl: CONSTITUTION_TEXT_URL,
    params,
    txHashes,
  };
}

/**
 * Genesis: the founder deposits `amount` of the settlement asset through the DepositShaman and
 * receives shares at the empty-treasury price (1 USDC -> 1e18 shares). Nothing else is minted.
 *
 * @param founder Signer holding at least `amount` of the settlement asset.
 * @param dao The deployed DAO (from deployZeroOne).
 * @param amount Settlement units to deposit (default GENESIS_DEPOSIT = 50 USDC).
 * @returns The approve and deposit hashes and the shares minted to the founder.
 * @throws Error if the treasury or supply is non-zero before the deposit, or the mint is not exactly amount x 1e18 / 1e6.
 */
export async function genesisDeposit(
  founder: WriteContext,
  dao: ZeroOneDao,
  amount: bigint = GENESIS_DEPOSIT,
): Promise<{ approveHash: Hex; depositHash: Hex; sharesMinted: bigint }> {
  const settlementAbi = loadLocalArtifact("TestToken").abi;
  const sharesAbi = loadLocalArtifact("NavShareToken").abi;
  const depositAbi = loadLocalArtifact("DepositShaman").abi;
  const readShares = (functionName: string, args: readonly unknown[] = []) =>
    founder.publicClient.readContract({ address: dao.shares, abi: sharesAbi, functionName, args } as never);

  assertInvariant((await readShares("totalSupply")) === 0n, "genesis deposit requires totalSupply == 0");
  assertInvariant((await readShares("treasuryValue")) === 0n, "genesis deposit requires an empty treasury (never pre-fund the Safe)");

  const approve = await founder.publicClient.simulateContract({
    address: dao.settlement,
    abi: settlementAbi,
    functionName: "approve",
    args: [dao.depositShaman, amount],
    account: founder.account,
  } as never);
  const { hash: approveHash } = await writeAndWait(founder, approve.request as unknown as Record<string, unknown>);

  const deposit = await founder.publicClient.simulateContract({
    address: dao.depositShaman,
    abi: depositAbi,
    functionName: "deposit",
    args: [amount],
    account: founder.account,
  } as never);
  const { hash: depositHash } = await writeAndWait(founder, deposit.request as unknown as Record<string, unknown>);

  const sharesMinted = (await readShares("balanceOf", [founder.account.address])) as bigint;
  const expected = (amount * UNIT) / SETTLEMENT_UNIT;
  assertInvariant(sharesMinted === expected, `genesis minted ${sharesMinted} shares, expected ${expected}`);
  assertInvariant((await readShares("totalSupply")) === expected, "genesis: founder holds 100% of supply");
  return { approveHash, depositHash, sharesMinted };
}

export interface ShamanPermission {
  shaman: Address;
  permission: bigint;
}

/**
 * Enumerate every address Baal has ever granted a shaman permission (from ShamanSet logs since
 * block 0) with its current permission, so a scenario can assert that DepositShaman and WorkManager
 * are the only manager (mint) shamans. Baal.mintShares is `baalOrManagerOnly`: besides managers,
 * only the avatar (the Safe, i.e. a passed proposal) may mint.
 *
 * @param context Any connected client.
 * @param baal The Baal address.
 * @returns Every address ever named in a ShamanSet event with its live permission from `shamans(address)`.
 */
export async function enumerateShamans(context: WriteContext, baal: Address): Promise<ShamanPermission[]> {
  const logs = await context.publicClient.getLogs({
    address: baal,
    event: parseAbiItem("event ShamanSet(address indexed shaman, uint256 permission)"),
    fromBlock: 0n,
    toBlock: "latest",
  });
  const baalAbi = loadBaalArtifact("Baal").abi;
  const seen = new Set<Address>();
  const result: ShamanPermission[] = [];
  for (const log of logs) {
    const shaman = getAddress(log.args.shaman ?? zeroAddress);
    if (seen.has(shaman)) continue;
    seen.add(shaman);
    const permission = (await context.publicClient.readContract({ address: baal, abi: baalAbi, functionName: "shamans", args: [shaman] })) as bigint;
    result.push({ shaman, permission });
  }
  return result;
}
