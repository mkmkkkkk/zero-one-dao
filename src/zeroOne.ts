/** Stand up the whole Zero One DAO (Baal + Safe + tokens + shamans) on a connected chain. */
import { getAddress, type Address, type Hex } from "viem";

import {
  createBaalProxy,
  createSafeProxy,
  deployBaalInfrastructure,
  initializeSafeAndBaal,
  loadBaalArtifact,
  type BaalInfrastructure,
  type GovernanceConfig,
  type WriteContext,
} from "./baal.js";
import { assertInvariant, deployLocal } from "./onchain.js";

export const UNIT = 10n ** 18n;
/** One settlement unit: USDC has 6 decimals (mirror TestToken "USDC-mock" matches). */
export const SETTLEMENT_UNIT = 10n ** 6n;
/** Base mainnet USDC; documented in docs/PARAMETERS.md, not deployed to or used anywhere yet. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const HOUR = 60 * 60;
export const FOUR_YEARS = 4 * 365 * 24 * 60 * 60 + 24 * 60 * 60; // 1461 days incl. one leap day

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
  founder: Address;
  /** Stream length in seconds; the founder's stream target is 10% of total supply at full vest. */
  founderStreamDuration: number;
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
  founderStreamDuration: FOUR_YEARS,
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
  founderStream: Address;
  depositShaman: Address;
  workManager: Address;
  intentAccount: Address;
  params: ZeroOneParams;
  txHashes: Record<string, Hex>;
}

/**
 * Deploy Zero One: vendored Baal/Safe singletons, Safe + Baal proxies, NavShareToken, LootToken,
 * FounderStream, DepositShaman, WorkManager, the 7702 intent adapter, then initialize Baal and
 * the Safe. Returns every address and transaction hash.
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
  const founderStream = await deployLocal(deployer, "FounderStream", [baal, params.founder, params.founderStreamDuration]);
  const depositShaman = await deployLocal(deployer, "DepositShaman", [baal, shares.address]);
  const workManager = await deployLocal(deployer, "WorkManager", [baal, shares.address]);
  const intentAccount = await deployLocal(deployer, "ZeroOneIntentAccount", [baal, depositShaman.address, workManager.address]);
  txHashes["NavShareToken"] = shares.hash;
  txHashes["LootToken"] = loot.hash;
  txHashes["FounderStream"] = founderStream.hash;
  txHashes["DepositShaman"] = depositShaman.hash;
  txHashes["WorkManager"] = workManager.hash;
  txHashes["ZeroOneIntentAccount"] = intentAccount.hash;

  const initialized = await initializeSafeAndBaal(deployer, infrastructure, {
    safe,
    baal,
    shares: shares.address,
    loot: loot.address,
    managerShamans: [founderStream.address, depositShaman.address, workManager.address],
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
    founderStream: founderStream.address,
    depositShaman: depositShaman.address,
    workManager: workManager.address,
    intentAccount: intentAccount.address,
    params,
    txHashes,
  };
}
