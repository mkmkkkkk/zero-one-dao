/**
 * How much ETH the deployer must hold before a Zero One deployment is allowed to start.
 *
 * The failure this guards against is the only deployment failure that cannot be retried cheaply: the
 * 22-transaction sequence in `scripts/deploy-network.ts` stops halfway, after `DepositShaman.deposit`
 * has already moved 50 real USDC into a half-built stack. A fixed ETH floor cannot guard it, because
 * the cost of those 22 transactions is a gas number times a fee the chain decides on the day: the
 * 0.005 ETH constant this replaces was enough at 0.05 gwei and not enough above roughly 0.2 gwei
 * (decision.md 2026-09-10, "phase 5 Base fork rehearsal review").
 *
 * So the requirement is computed, not written down:
 *
 *   required = max(measured deployment gas x live base fee x 5, 0.02 ETH floor)
 *
 * The gas comes from the committed fork measurement (`evidence/phase5/base-fork/measurements.json`,
 * produced by `npm run e2e:base-fork`), so the number lives in exactly one place and moves when the
 * rehearsal re-measures it. The base fee is read from the chain the deployment is about to write to,
 * at the moment of the check. The factor of five is headroom for a fee spike during the run; the floor
 * is what the requirement never drops below on a chain whose fees are currently near zero.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PublicClient } from "viem";

import { fmtEth, fmtGwei } from "./live.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative path of the committed measurement the requirement is computed from. */
export const MEASUREMENT_FILE = "evidence/phase5/base-fork/measurements.json";
/** Multiple of the measured cost the deployer must hold: headroom for a fee spike mid-deployment. */
export const DEPLOYER_GAS_FACTOR = 5n;
/** Requirement floor, whatever the live fee says: 0.02 ETH (decision.md 2026-09-10). */
export const DEPLOYER_FLOOR_WEI = 20_000_000_000_000_000n;

/** The deployment cost the fork rehearsal measured, and where it was read from. */
export interface DeploymentMeasurement {
  /** Total gas of the deployment plus genesis. */
  gas: bigint;
  /** Number of transactions that gas was spread over. */
  transactions: number;
  /** Repository-relative path of the file it was read from, for the refusal message. */
  source: string;
}

/** A base fee read from the chain, and the exact read it came from. */
export interface LiveBaseFee {
  /** Wei per gas. */
  wei: bigint;
  /** How it was obtained, named in the refusal message. */
  source: string;
}

/** The computed requirement, with every input it was computed from. */
export interface DeployerRequirement {
  /** What the deployer must hold, in wei: the greater of `computedWei` and `floorWei`. */
  wei: bigint;
  /** measured gas x live base fee x DEPLOYER_GAS_FACTOR. */
  computedWei: bigint;
  /** DEPLOYER_FLOOR_WEI. */
  floorWei: bigint;
  /** True when the floor is what the requirement ended up being. */
  floored: boolean;
  measurement: DeploymentMeasurement;
  baseFee: LiveBaseFee;
}

/**
 * Read the committed deployment gas measurement.
 *
 * Args:
 *     root: Repository root (overridable for tests).
 *
 * Returns:
 *     The measured total gas, the transaction count, and the path it came from.
 *
 * Raises:
 *     Error: When the measurement file is missing or does not carry a usable `deployment.totalGas`.
 *         Fail-closed on purpose: without a measurement there is no requirement to check against.
 */
export function measuredDeployment(root: string = ROOT): DeploymentMeasurement {
  const file = path.join(root, MEASUREMENT_FILE);
  let parsed: { deployment?: { totalGas?: unknown; transactions?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
  } catch (error) {
    throw new Error(`REFUSED: cannot read the deployment gas measurement ${MEASUREMENT_FILE} (${error instanceof Error ? error.message : String(error)}); run npm run e2e:base-fork`);
  }
  const { totalGas, transactions } = parsed.deployment ?? {};
  if (typeof totalGas !== "string" || !/^[0-9]+$/u.test(totalGas) || totalGas === "0") throw new Error(`REFUSED: ${MEASUREMENT_FILE} has no decimal deployment.totalGas (got ${JSON.stringify(totalGas)})`);
  if (typeof transactions !== "number" || !Number.isInteger(transactions) || transactions <= 0) throw new Error(`REFUSED: ${MEASUREMENT_FILE} has no deployment.transactions count (got ${JSON.stringify(transactions)})`);
  return { gas: BigInt(totalGas), transactions, source: MEASUREMENT_FILE };
}

/**
 * Read the base fee of the chain a deployment is about to write to.
 *
 * The latest block's `baseFeePerGas` is the EIP-1559 answer and is what Base reports. A chain that
 * reports none (a pre-1559 chain, or a devnet configured without a base fee) falls back to
 * `eth_gasPrice`, which is the same quantity there; the refusal message says which read was used.
 *
 * Args:
 *     publicClient: Client bound to the target chain.
 *
 * Returns:
 *     The fee in wei per gas and the read it came from.
 *
 * Raises:
 *     Error: When the chain reports neither a base fee nor a gas price.
 */
export async function liveBaseFee(publicClient: PublicClient): Promise<LiveBaseFee> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) return { wei: block.baseFeePerGas, source: `latest block ${block.number}` };
  let gasPrice: bigint;
  try {
    gasPrice = await publicClient.getGasPrice();
  } catch (error) {
    throw new Error(`REFUSED: chain reports no baseFeePerGas at block ${block.number} and eth_gasPrice failed (${error instanceof Error ? error.message : String(error)}); the deployer requirement cannot be computed`);
  }
  return { wei: gasPrice, source: `eth_gasPrice (block ${block.number} reports no baseFeePerGas)` };
}

/**
 * Combine a measurement and a live fee into the requirement.
 *
 * Args:
 *     measurement: The committed deployment gas measurement.
 *     baseFee: The fee just read from the target chain.
 *
 * Returns:
 *     The requirement and every input it was computed from.
 */
export function deployerRequirement(measurement: DeploymentMeasurement, baseFee: LiveBaseFee): DeployerRequirement {
  const computedWei = measurement.gas * baseFee.wei * DEPLOYER_GAS_FACTOR;
  const floored = computedWei <= DEPLOYER_FLOOR_WEI;
  return { wei: floored ? DEPLOYER_FLOOR_WEI : computedWei, computedWei, floorWei: DEPLOYER_FLOOR_WEI, floored, measurement, baseFee };
}

/**
 * One sentence naming the requirement and every number behind it.
 *
 * Args:
 *     requirement: The computed requirement.
 *
 * Returns:
 *     `"<required> ETH: <gas> gas (measured over <n> transactions, <file>) x <fee> gwei live base
 *     fee (<read>) x 5 = <computed> ETH, floor <floor> ETH[ governs]"`.
 */
export function requirementSentence(requirement: DeployerRequirement): string {
  const { measurement, baseFee } = requirement;
  return `${fmtEth(requirement.wei)} ETH: ${measurement.gas} gas (measured over ${measurement.transactions} transactions, ${measurement.source}) x ${fmtGwei(baseFee.wei)} gwei live base fee (${baseFee.source}) x ${DEPLOYER_GAS_FACTOR} = ${fmtEth(requirement.computedWei)} ETH, floor ${fmtEth(requirement.floorWei)} ETH${requirement.floored ? " governs" : ""}`;
}

/**
 * Refuse the deployment unless the deployer holds the computed requirement.
 *
 * Called before any write. The refusal names the three numbers an operator needs to act: what the
 * deployment requires, the live base fee it required it at, and what the deployer actually holds.
 *
 * Args:
 *     publicClient: Client bound to the target chain (the base fee is read from it here, not earlier).
 *     deployer: The deploying EOA.
 *     balance: Its ETH balance in wei, already read by the caller.
 *
 * Returns:
 *     The requirement that was satisfied, for the caller's receipts.
 *
 * Raises:
 *     Error: When the deployer holds less than the requirement, or the requirement cannot be computed.
 */
export async function assertDeployerFunded(publicClient: PublicClient, deployer: string, balance: bigint): Promise<DeployerRequirement> {
  const requirement = deployerRequirement(measuredDeployment(), await liveBaseFee(publicClient));
  if (balance < requirement.wei) throw new Error(`REFUSED: deployer ${deployer} holds ${fmtEth(balance)} ETH, below the ${requirementSentence(requirement)}`);
  console.log(`ASSERT deployer ${deployer} holds ${fmtEth(balance)} ETH, at or above the ${requirementSentence(requirement)}`);
  return requirement;
}
