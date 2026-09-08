/**
 * Baal (Moloch v3) + Safe deployment helpers for the Zero One mirror.
 * Copied from agent-only-wallet/exit/src/baal.ts; initializeSafeAndBaal is re-shaped for
 * Baal-native governance: Baal is the only Safe module, two manager shamans, governance config
 * set in the setUp multisend, admin locked (tokens cannot be paused), manager/governor unlocked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  numberToHex,
  size,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";

import { awaitRead, simulateSettled } from "./onchain.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BAAL_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@daohaus", "baal-contracts");

export const BAAL_PACKAGE_VERSION = "1.2.18";

export interface ContractArtifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode?: Hex;
  sourceName?: string;
  sourcePath?: string;
}

export interface WriteContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
  chain: Chain;
}

export interface BaalInfrastructure {
  baalSingleton: Address;
  moduleProxyFactory: Address;
  safeSingleton: Address;
  safeProxyFactory: Address;
  multiSend: Address;
  deploymentTransactions: Hex[];
}

/** Baal governance parameters, all changeable later by proposal via setGovernanceConfig. */
export interface GovernanceConfig {
  votingPeriod: number;
  gracePeriod: number;
  proposalOffering: bigint;
  quorumPercent: bigint;
  sponsorThreshold: bigint;
  minRetentionPercent: bigint;
}

const PACKAGE_ARTIFACTS = {
  Baal: "export/artifacts/contracts/Baal.sol/Baal.json",
  ModuleProxyFactory:
    "export/artifacts/@gnosis.pm/zodiac/contracts/factory/ModuleProxyFactory.sol/ModuleProxyFactory.json",
  GnosisSafe:
    "export/artifacts/@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol/GnosisSafe.json",
  GnosisSafeProxy: "export/artifacts/@gnosis.pm/safe-contracts/contracts/proxies/GnosisSafeProxy.sol/GnosisSafeProxy.json",
  GnosisSafeProxyFactory:
    "export/artifacts/@gnosis.pm/safe-contracts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json",
  MultiSend:
    "export/artifacts/@gnosis.pm/safe-contracts/contracts/libraries/MultiSend.sol/MultiSend.json",
} as const;

function parseArtifact(file: string): ContractArtifact {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ContractArtifact>;
  if (
    typeof parsed.contractName !== "string" ||
    !Array.isArray(parsed.abi) ||
    typeof parsed.bytecode !== "string" ||
    !/^0x[0-9a-f]*$/iu.test(parsed.bytecode) ||
    parsed.bytecode === "0x"
  ) {
    throw new Error(`Invalid deployable artifact: ${file}`);
  }
  return parsed as ContractArtifact;
}

/** Load a compiled artifact from contracts/artifacts (run `npm run compile` first). */
export function loadLocalArtifact(contractName: string): ContractArtifact {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(contractName)) {
    throw new TypeError("Invalid local artifact name");
  }
  return parseArtifact(path.join(ROOT, "contracts", "artifacts", `${contractName}.json`));
}

/** Load only the ABI of a local artifact (works for interfaces, which have no bytecode). */
export function loadLocalAbi(contractName: string): Abi {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(contractName)) {
    throw new TypeError("Invalid local artifact name");
  }
  const parsed = JSON.parse(readFileSync(path.join(ROOT, "contracts", "artifacts", `${contractName}.json`), "utf8")) as { abi?: unknown };
  if (!Array.isArray(parsed.abi) || parsed.abi.length === 0) throw new Error(`Artifact has no ABI: ${contractName}`);
  return parsed.abi as Abi;
}

/** Load a vendored @daohaus/baal-contracts 1.2.18 artifact (Baal, Safe, factories, MultiSend). */
export function loadBaalArtifact(name: keyof typeof PACKAGE_ARTIFACTS): ContractArtifact {
  return parseArtifact(path.join(BAAL_PACKAGE_ROOT, PACKAGE_ARTIFACTS[name]));
}

async function receiptFor(context: WriteContext, hash: Hex): Promise<void> {
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
}

/** Read code at `address`, tolerating RPC nodes that lag the receipt's block. */
export async function awaitCode(publicClient: WriteContext["publicClient"], address: Address): Promise<Hex | undefined> {
  let code: Hex | undefined;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    code = await publicClient.getCode({ address });
    if (code !== undefined && code !== "0x") return code;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return undefined;
}

/** Deploy one artifact and return its address and transaction hash. */
export async function deployArtifact(
  context: WriteContext,
  artifact: ContractArtifact,
  args: readonly unknown[] = [],
): Promise<{ address: Address; hash: Hex }> {
  const hash = await context.walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: context.account,
    chain: context.chain,
  } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress == null) {
    throw new Error(`Deployment failed for ${artifact.contractName}: ${hash}`);
  }
  const code = await awaitCode(context.publicClient, receipt.contractAddress);
  if (code === undefined || code === "0x") {
    throw new Error(`Deployment produced no code for ${artifact.contractName}: ${hash}`);
  }
  return { address: getAddress(receipt.contractAddress), hash };
}

/** Deploy the five vendored singletons: Baal, ModuleProxyFactory, Safe, SafeProxyFactory, MultiSend. */
export async function deployBaalInfrastructure(context: WriteContext): Promise<BaalInfrastructure> {
  const baal = await deployArtifact(context, loadBaalArtifact("Baal"));
  const moduleFactory = await deployArtifact(context, loadBaalArtifact("ModuleProxyFactory"));
  const safe = await deployArtifact(context, loadBaalArtifact("GnosisSafe"));
  const safeFactory = await deployArtifact(context, loadBaalArtifact("GnosisSafeProxyFactory"));
  const multiSend = await deployArtifact(context, loadBaalArtifact("MultiSend"));
  return {
    baalSingleton: baal.address,
    moduleProxyFactory: moduleFactory.address,
    safeSingleton: safe.address,
    safeProxyFactory: safeFactory.address,
    multiSend: multiSend.address,
    deploymentTransactions: [baal.hash, moduleFactory.hash, safe.hash, safeFactory.hash, multiSend.hash],
  };
}

/** Create an un-initialized Safe proxy (setup happens in initializeSafeAndBaal). */
export async function createSafeProxy(
  context: WriteContext,
  infrastructure: BaalInfrastructure,
  saltNonce: bigint,
  beforeCreate?: (predicted: Address) => Promise<void>,
): Promise<{ safe: Address; hash: Hex }> {
  const factory = loadBaalArtifact("GnosisSafeProxyFactory");
  const simulation = await context.publicClient.simulateContract({
    address: infrastructure.safeProxyFactory,
    abi: factory.abi,
    functionName: "createProxyWithNonce",
    args: [infrastructure.safeSingleton, "0x", saltNonce],
    account: context.account,
  });
  const safe = getAddress(simulation.result as Address);
  await beforeCreate?.(safe);
  const hash = await context.walletClient.writeContract({
    ...simulation.request,
    account: context.account,
    chain: context.chain,
  } as never);
  await receiptFor(context, hash);
  const code = await awaitCode(context.publicClient, safe);
  if (code === undefined || code === "0x") throw new Error("Safe proxy deployment returned no code");
  return { safe, hash };
}

/** Create an un-initialized Baal minimal proxy (setUp happens in initializeSafeAndBaal). */
export async function createBaalProxy(
  context: WriteContext,
  infrastructure: BaalInfrastructure,
  saltNonce: bigint,
): Promise<{ baal: Address; hash: Hex }> {
  const factory = loadBaalArtifact("ModuleProxyFactory");
  const baalArtifact = loadBaalArtifact("Baal");
  const initializer = encodeFunctionData({ abi: baalArtifact.abi, functionName: "avatar" });
  const simulation = await context.publicClient.simulateContract({
    address: infrastructure.moduleProxyFactory,
    abi: factory.abi,
    functionName: "deployModule",
    args: [infrastructure.baalSingleton, initializer, saltNonce],
    account: context.account,
  });
  const baal = getAddress(simulation.result as Address);
  const hash = await context.walletClient.writeContract({
    ...simulation.request,
    account: context.account,
    chain: context.chain,
  } as never);
  await receiptFor(context, hash);
  const code = await awaitCode(context.publicClient, baal);
  if (code === undefined || code === "0x") throw new Error("Baal proxy deployment returned no code");
  return { baal, hash };
}

export interface PackedCall {
  to: Address;
  data: Hex;
  value?: bigint;
  operation?: 0 | 1;
}

/** Gnosis MultiSend's canonical operation|to|value|dataLength|data encoding. */
export function packMultiSend(calls: readonly PackedCall[]): Hex {
  return concatHex(
    calls.map(({ to, data, value = 0n, operation = 0 }) =>
      concatHex([
        numberToHex(operation, { size: 1 }),
        to,
        numberToHex(value, { size: 32 }),
        numberToHex(BigInt(size(data)), { size: 32 }),
        data,
      ]),
    ),
  );
}

/** Full `multiSend(bytes)` calldata: the exact bytes Baal stores (hashed) and later executes. */
export function encodeProposalData(calls: readonly PackedCall[]): Hex {
  const multiSendArtifact = loadBaalArtifact("MultiSend");
  return encodeFunctionData({
    abi: multiSendArtifact.abi,
    functionName: "multiSend",
    args: [packMultiSend(calls)],
  });
}

/** ABI-encode Baal.setGovernanceConfig's bytes argument. */
export function encodeGovernanceConfig(config: GovernanceConfig): Hex {
  return encodeAbiParameters(
    [
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      config.votingPeriod,
      config.gracePeriod,
      config.proposalOffering,
      config.quorumPercent,
      config.sponsorThreshold,
      config.minRetentionPercent,
    ],
  );
}

export interface InitializeBaalInput {
  safe: Address;
  baal: Address;
  shares: Address;
  loot: Address;
  /** Manager shamans (permission 2): DepositShaman, WorkManager; the only mint paths. */
  managerShamans: Address[];
  governance: GovernanceConfig;
  forwarder?: Address;
}

/**
 * Give the Safe no EOA owner and Baal as its only module; initialize Baal with the Zero One tokens,
 * the manager shamans and the initial governance config; lock admin (no pause path exists anyway).
 * Manager and governor stay unlocked: adding a shaman later needs a passed proposal, which members
 * can stop by votes or exits (DESIGN.md §0). Verified by reading every invariant back.
 */
export async function initializeSafeAndBaal(
  context: WriteContext,
  infrastructure: BaalInfrastructure,
  input: InitializeBaalInput,
): Promise<{ safeSetupHash: Hex; baalSetupHash: Hex }> {
  const safeArtifact = loadBaalArtifact("GnosisSafe");
  const baalArtifact = loadBaalArtifact("Baal");
  const multiSendArtifact = loadBaalArtifact("MultiSend");

  const enableData = encodeFunctionData({
    abi: multiSendArtifact.abi,
    functionName: "multiSend",
    args: [
      packMultiSend([
        {
          to: input.safe,
          data: encodeFunctionData({ abi: safeArtifact.abi, functionName: "enableModule", args: [input.baal] }),
        },
      ]),
    ],
  });
  const safeSetup = (await simulateSettled(context, {
    address: input.safe,
    abi: safeArtifact.abi,
    functionName: "setup",
    args: [[input.baal], 1n, infrastructure.multiSend, enableData, zeroAddress, zeroAddress, 0n, zeroAddress],
  })) as { request: Record<string, unknown> };
  const safeSetupHash = await context.walletClient.writeContract({
    ...safeSetup.request,
    account: context.account,
    chain: context.chain,
  } as never);
  await receiptFor(context, safeSetupHash);

  const initializationCalls: PackedCall[] = [
    {
      to: input.baal,
      data: encodeFunctionData({
        abi: baalArtifact.abi,
        functionName: "setShamans",
        args: [input.managerShamans, input.managerShamans.map(() => 2n)],
      }),
    },
    {
      to: input.baal,
      data: encodeFunctionData({
        abi: baalArtifact.abi,
        functionName: "setGovernanceConfig",
        args: [encodeGovernanceConfig(input.governance)],
      }),
    },
    {
      to: input.baal,
      data: encodeFunctionData({ abi: baalArtifact.abi, functionName: "lockAdmin" }),
    },
  ];
  const initializationMultiSend = encodeFunctionData({
    abi: multiSendArtifact.abi,
    functionName: "multiSend",
    args: [packMultiSend(initializationCalls)],
  });
  const initializationParameters = encodeAbiParameters(
    [
      { type: "address", name: "lootToken" },
      { type: "address", name: "sharesToken" },
      { type: "address", name: "multisendLibrary" },
      { type: "address", name: "avatar" },
      { type: "address", name: "forwarder" },
      { type: "bytes", name: "initializationMultisendData" },
    ],
    [
      input.loot,
      input.shares,
      infrastructure.multiSend,
      input.safe,
      input.forwarder ?? zeroAddress,
      initializationMultiSend,
    ],
  );
  // The Safe must report Baal as an enabled module on the node that answers before setUp is simulated.
  await awaitRead(() => context.publicClient.readContract({ address: input.safe, abi: safeArtifact.abi, functionName: "isModuleEnabled", args: [input.baal] }) as Promise<boolean>, (enabled) => enabled === true);
  const baalSetup = (await simulateSettled(context, {
    address: input.baal,
    abi: baalArtifact.abi,
    functionName: "setUp",
    args: [initializationParameters],
  })) as { request: Record<string, unknown> };
  const baalSetupHash = await context.walletClient.writeContract({
    ...baalSetup.request,
    account: context.account,
    chain: context.chain,
  } as never);
  await receiptFor(context, baalSetupHash);

  const read = (functionName: string, args: readonly unknown[] = []) =>
    context.publicClient.readContract({ address: input.baal, abi: baalArtifact.abi, functionName, args } as never);
  await awaitRead(() => read("avatar") as Promise<Address>, (value) => getAddress(value) === getAddress(input.safe));
  const [avatar, shares, loot, trustedForwarder, adminLock, managerLock, governorLock, votingPeriod, gracePeriod, quorum, sponsor, minRetention, offering, baalEnabled] =
    await Promise.all([
      read("avatar"),
      read("sharesToken"),
      read("lootToken"),
      read("trustedForwarder"),
      read("adminLock"),
      read("managerLock"),
      read("governorLock"),
      read("votingPeriod"),
      read("gracePeriod"),
      read("quorumPercent"),
      read("sponsorThreshold"),
      read("minRetentionPercent"),
      read("proposalOffering"),
      context.publicClient.readContract({ address: input.safe, abi: safeArtifact.abi, functionName: "isModuleEnabled", args: [input.baal] }),
    ]);
  const permissions = await Promise.all(input.managerShamans.map((shaman) => read("shamans", [shaman])));
  if (
    getAddress(avatar as Address) !== getAddress(input.safe) ||
    getAddress(shares as Address) !== getAddress(input.shares) ||
    getAddress(loot as Address) !== getAddress(input.loot) ||
    getAddress(trustedForwarder as Address) !== getAddress(input.forwarder ?? zeroAddress) ||
    adminLock !== true ||
    managerLock !== false ||
    governorLock !== false ||
    Number(votingPeriod) !== input.governance.votingPeriod ||
    Number(gracePeriod) !== input.governance.gracePeriod ||
    (quorum as bigint) !== input.governance.quorumPercent ||
    (sponsor as bigint) !== input.governance.sponsorThreshold ||
    (minRetention as bigint) !== input.governance.minRetentionPercent ||
    (offering as bigint) !== input.governance.proposalOffering ||
    baalEnabled !== true ||
    permissions.some((permission) => permission !== 2n)
  ) {
    throw new Error("Baal/Safe post-initialization invariant failed");
  }

  return { safeSetupHash, baalSetupHash };
}
