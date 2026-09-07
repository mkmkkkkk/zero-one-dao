/**
 * Baal-proposal builder for the proposal-contract templates (DESIGN.md §7).
 *
 * A proposer picks a template and parameters; the builder deploys the instance (the proposer pays
 * the gas), reads back its `describe()` and code hash, and submits the Baal proposal whose multicall
 * funds the instance from the Safe and calls `start()`. Voters see template, parameters, params hash,
 * instance address and code hash in the proposal details. Management proposals (topUp / amend /
 * stop / migrate) are built the same way as multicalls the Safe executes when they pass.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { encodeProposalData, loadBaalArtifact, loadLocalAbi, loadLocalArtifact, type GovernanceConfig, type PackedCall, type WriteContext } from "./baal.js";
import { deployLocal, writeAndWait } from "./onchain.js";
import type { ZeroOneDao } from "./zeroOne.js";

export const TEMPLATE_NAMES = ["Payment", "Strategy", "Project", "Config"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Contract name of each template's artifact. */
export const TEMPLATE_CONTRACTS: Record<TemplateName, string> = {
  Payment: "PaymentProposal",
  Strategy: "StrategyProposal",
  Project: "ProjectProposal",
  Config: "ConfigProposal",
};

export const PROPOSAL_STATUS = ["Pending", "Running", "Complete", "Stopped", "Migrated"] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUS)[number];

export interface PaymentParams {
  recipients: Address[];
  amounts: bigint[];
}

export interface StrategyRule {
  maxPerRun: bigint;
  minInterval: bigint;
  deadline: bigint;
  takeProfitBps: bigint;
  stopLossBps: bigint;
}

export interface StrategyParams {
  venue: Address;
  asset: Address;
  budget: bigint;
  rule: StrategyRule;
}

export type ReleaseType = "date" | "verifiers";

export interface Tranche {
  amount: bigint;
  releaseType: ReleaseType;
  /** Unix time for `date` tranches (0 = at once); ignored for `verifiers`. */
  releaseAt: bigint;
  verifiers: Address[];
  threshold: number;
}

export interface ProjectParams {
  tranches: Tranche[];
  /** Unix time after which anyone may end the project (0 = none). */
  deadline: bigint;
}

export type ConfigParams = GovernanceConfig;

export type TemplateSpec =
  | { template: "Payment"; params: PaymentParams }
  | { template: "Strategy"; params: StrategyParams }
  | { template: "Project"; params: ProjectParams }
  | { template: "Config"; params: ConfigParams };

export interface Description {
  template: string;
  paramsHash: Hex;
  operator: Address;
  budget: bigint;
  deadline: bigint;
  status: ProposalStatusName;
}

export interface TemplateInstance {
  address: Address;
  deployHash: Hex;
  template: TemplateName;
  contractName: string;
  compiler: string;
  spec: TemplateSpec;
  /** keccak256(abi.encode(params)) as computed locally and confirmed equal to the contract's. */
  paramsHash: Hex;
  /** keccak256 of the runtime code at `address` (immutables included). */
  codeHash: Hex;
  description: Description;
}

const RULE_TUPLE = {
  type: "tuple",
  components: [
    { name: "maxPerRun", type: "uint256" },
    { name: "minInterval", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "takeProfitBps", type: "uint256" },
    { name: "stopLossBps", type: "uint256" },
  ],
} as const;

const TRANCHE_ARRAY = {
  type: "tuple[]",
  components: [
    { name: "amount", type: "uint256" },
    { name: "releaseType", type: "uint8" },
    { name: "releaseAt", type: "uint256" },
    { name: "verifiers", type: "address[]" },
    { name: "threshold", type: "uint16" },
  ],
} as const;

const CONFIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "votingPeriod", type: "uint32" },
    { name: "gracePeriod", type: "uint32" },
    { name: "proposalOffering", type: "uint256" },
    { name: "quorumPercent", type: "uint256" },
    { name: "sponsorThreshold", type: "uint256" },
    { name: "minRetentionPercent", type: "uint256" },
  ],
} as const;

function releaseTypeIndex(releaseType: ReleaseType): number {
  if (releaseType === "date") return 0;
  if (releaseType === "verifiers") return 1;
  throw new TypeError(`unknown release type ${String(releaseType)}`);
}

/** Solidity-shaped tranche tuples for ABI encoding. */
function trancheTuples(tranches: Tranche[]) {
  return tranches.map((tranche) => ({
    amount: tranche.amount,
    releaseType: releaseTypeIndex(tranche.releaseType),
    releaseAt: tranche.releaseAt,
    verifiers: tranche.verifiers,
    threshold: tranche.threshold,
  }));
}

/**
 * The bytes a template hashes as `paramsHash` (and, for Strategy/Project/Config, accepts in `amend`).
 *
 * @param spec Template and parameters.
 * @returns ABI-encoded parameters exactly as the contract's `abi.encode(...)`.
 */
export function encodeParams(spec: TemplateSpec): Hex {
  switch (spec.template) {
    case "Payment":
      return encodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }], [spec.params.recipients, spec.params.amounts]);
    case "Strategy":
      return encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, RULE_TUPLE],
        [spec.params.venue, spec.params.asset, spec.params.budget, spec.params.rule],
      );
    case "Project":
      return encodeAbiParameters([TRANCHE_ARRAY, { type: "uint256" }], [trancheTuples(spec.params.tranches), spec.params.deadline]);
    case "Config":
      return encodeAbiParameters([CONFIG_TUPLE], [spec.params]);
  }
}

/**
 * The bytes `amend(params)` expects for a template: the Strategy takes a Rule only; the Project a
 * (Tranche[], deadline) pair; the Payment (recipients, amounts); the Config a Config tuple.
 *
 * @param spec Template and the new parameters.
 * @returns ABI-encoded amend payload.
 */
export function encodeAmendParams(spec: TemplateSpec): Hex {
  if (spec.template === "Strategy") return encodeAbiParameters([RULE_TUPLE], [spec.params.rule]);
  return encodeParams(spec);
}

/** Local keccak256(abi.encode(params)). */
export function paramsHashOf(spec: TemplateSpec): Hex {
  return keccak256(encodeParams(spec));
}

/** Constructor arguments for a template instance owned by `dao.safe`. */
function constructorArgs(dao: ZeroOneDao, operator: Address, spec: TemplateSpec): readonly unknown[] {
  switch (spec.template) {
    case "Payment":
      return [dao.safe, dao.settlement, operator, spec.params.recipients, spec.params.amounts];
    case "Strategy":
      return [dao.safe, dao.settlement, operator, spec.params.venue, spec.params.asset, spec.params.budget, spec.params.rule];
    case "Project":
      return [dao.safe, dao.settlement, operator, trancheTuples(spec.params.tranches), spec.params.deadline];
    case "Config":
      return [dao.safe, dao.settlement, operator, dao.baal, spec.params];
  }
}

/** ABI of the common surface (IProposalContract). */
export function proposalAbi(): Abi {
  return loadLocalAbi("IProposalContract");
}

/**
 * Read `describe()` from any proposal contract.
 *
 * @param context Any connected client.
 * @param address Instance address.
 * @returns Template name, params hash, operator, budget, deadline and status.
 */
export async function describe(context: WriteContext, address: Address): Promise<Description> {
  const result = (await context.publicClient.readContract({ address, abi: proposalAbi(), functionName: "describe" })) as readonly [string, Hex, Address, bigint, bigint, number];
  const status = PROPOSAL_STATUS[result[5]];
  if (status === undefined) throw new Error(`unknown proposal status ${result[5]} at ${address}`);
  return { template: result[0], paramsHash: result[1], operator: getAddress(result[2]), budget: result[3], deadline: result[4], status };
}

/**
 * Deploy a template instance for `spec`; the caller is the operator (proposer). Verifies that the
 * contract's paramsHash equals the local keccak256(abi.encode(params)) and records the code hash.
 *
 * @param proposer Signer that deploys (pays gas) and becomes the operator.
 * @param dao The deployed DAO (Safe, settlement, Baal).
 * @param spec Template and parameters.
 * @returns The instance with its description, params hash and code hash.
 * @throws Error if the on-chain paramsHash or template name disagrees with the spec.
 */
export async function deployTemplate(proposer: WriteContext, dao: ZeroOneDao, spec: TemplateSpec): Promise<TemplateInstance> {
  const contractName = TEMPLATE_CONTRACTS[spec.template];
  const deployed = await deployLocal(proposer, contractName, constructorArgs(dao, proposer.account.address, spec));
  const code = await proposer.publicClient.getCode({ address: deployed.address });
  if (code === undefined || code === "0x") throw new Error(`no code at ${deployed.address}`);
  const description = await describe(proposer, deployed.address);
  const paramsHash = paramsHashOf(spec);
  if (description.paramsHash !== paramsHash) {
    throw new Error(`paramsHash mismatch for ${spec.template}: contract ${description.paramsHash}, local ${paramsHash}`);
  }
  if (description.template !== spec.template) throw new Error(`template mismatch: contract ${description.template}, spec ${spec.template}`);
  if (description.operator !== getAddress(proposer.account.address)) throw new Error("operator is not the proposer");
  const artifact = deployed.artifact as { compiler?: string };
  return {
    address: deployed.address,
    deployHash: deployed.hash,
    template: spec.template,
    contractName,
    compiler: artifact.compiler ?? "unknown",
    spec,
    paramsHash,
    codeHash: keccak256(code),
    description,
  };
}

function transferCall(dao: ZeroOneDao, to: Address, amount: bigint): PackedCall {
  return { to: dao.settlement, data: encodeFunctionData({ abi: loadLocalArtifact("TestToken").abi, functionName: "transfer", args: [to, amount] }) };
}

function instanceCall(instance: Address, functionName: string, args: readonly unknown[] = []): PackedCall {
  return { to: instance, data: encodeFunctionData({ abi: proposalAbi(), functionName, args }) };
}

/**
 * The multicall the Safe executes when the proposal passes: fund the instance with its budget from
 * the Safe (or, for Config, apply the governance config on Baal), then `start()`.
 *
 * @param dao The deployed DAO.
 * @param instance A deployed template instance.
 * @returns Packed calls in execution order.
 */
export function fundAndStartCalls(dao: ZeroOneDao, instance: TemplateInstance): PackedCall[] {
  const calls: PackedCall[] = [];
  if (instance.spec.template === "Config") {
    const config = instance.spec.params;
    const encoded = encodeAbiParameters(
      [{ type: "uint32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [config.votingPeriod, config.gracePeriod, config.proposalOffering, config.quorumPercent, config.sponsorThreshold, config.minRetentionPercent],
    );
    calls.push({ to: dao.baal, data: encodeFunctionData({ abi: loadBaalArtifact("Baal").abi, functionName: "setGovernanceConfig", args: [encoded] }) });
  } else if (instance.description.budget > 0n) {
    calls.push(transferCall(dao, instance.address, instance.description.budget));
  }
  calls.push(instanceCall(instance.address, "start"));
  return calls;
}

/** Multicall for a later proposal: transfer `amount` more from the Safe, then `topUp(amount)`. */
export function topUpCalls(dao: ZeroOneDao, instance: Address, amount: bigint): PackedCall[] {
  return [transferCall(dao, instance, amount), instanceCall(instance, "topUp", [amount])];
}

/** Multicall for a later proposal: `amend(params)`. */
export function amendCalls(instance: Address, params: Hex): PackedCall[] {
  return [instanceCall(instance, "amend", [params])];
}

/** Multicall for a later proposal: `stop()` (everything returns to the Safe). */
export function stopCalls(instance: Address): PackedCall[] {
  return [instanceCall(instance, "stop")];
}

/** Multicall for a later proposal: `old.migrate(new)` then `new.start()`. */
export function migrateCalls(oldInstance: Address, newInstance: Address): PackedCall[] {
  return [instanceCall(oldInstance, "migrate", [newInstance]), instanceCall(newInstance, "start")];
}

/** JSON with bigints as decimal strings (stable key order as written). */
export function jsonify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

/**
 * Proposal details for voters: template, parameters, params hash, instance, code hash, compiler.
 *
 * @param instance A deployed template instance.
 * @param summary One-line human summary prefixed to the JSON.
 * @returns The details string stored with the Baal proposal.
 */
export function proposalDetails(instance: TemplateInstance, summary: string): string {
  return `${summary} ${jsonify({
    template: instance.template,
    contract: instance.contractName,
    compiler: instance.compiler,
    instance: instance.address,
    operator: instance.description.operator,
    budget: instance.description.budget,
    deadline: instance.description.deadline,
    params: instance.spec.params,
    paramsHash: instance.paramsHash,
    codeHash: instance.codeHash,
  })}`;
}

export interface SubmittedProposal {
  instance: TemplateInstance;
  id: number;
  calls: PackedCall[];
  data: Hex;
  details: string;
  submitHash: Hex;
}

/**
 * Submit a Baal proposal whose multicall is `calls` with `details`; returns the new proposal id.
 *
 * @param proposer Signer submitting (self-sponsored when it holds >= sponsorThreshold shares).
 * @param dao The deployed DAO.
 * @param calls The multicall the Safe will execute on pass.
 * @param details Proposal text.
 * @param expiration Baal expiration (0 = none).
 * @returns Proposal id, the exact proposalData bytes and the submit hash.
 */
export async function submitCalls(
  proposer: WriteContext,
  dao: ZeroOneDao,
  calls: readonly PackedCall[],
  details: string,
  expiration = 0,
): Promise<{ id: number; data: Hex; submitHash: Hex }> {
  const baalAbi = loadBaalArtifact("Baal").abi;
  const data = encodeProposalData(calls);
  const before = (await proposer.publicClient.readContract({ address: dao.baal, abi: baalAbi, functionName: "proposalCount" })) as number | bigint;
  const simulation = await proposer.publicClient.simulateContract({
    address: dao.baal,
    abi: baalAbi,
    functionName: "submitProposal",
    args: [data, expiration, 0n, details],
    account: proposer.account,
  } as never);
  const { hash } = await writeAndWait(proposer, simulation.request as unknown as Record<string, unknown>);
  const after = (await proposer.publicClient.readContract({ address: dao.baal, abi: baalAbi, functionName: "proposalCount" })) as number | bigint;
  if (Number(after) !== Number(before) + 1) throw new Error(`proposalCount did not advance by one (${before} -> ${after})`);
  return { id: Number(after), data, submitHash: hash };
}

/**
 * Deploy a template instance and submit the Baal proposal that funds and starts it.
 *
 * @param proposer Signer that deploys the instance and submits the proposal.
 * @param dao The deployed DAO.
 * @param spec Template and parameters.
 * @param summary One-line human summary for the details.
 * @param expiration Baal expiration (0 = none).
 * @returns The instance, proposal id, multicall, proposalData and details.
 */
export async function submitTemplateProposal(
  proposer: WriteContext,
  dao: ZeroOneDao,
  spec: TemplateSpec,
  summary: string,
  expiration = 0,
): Promise<SubmittedProposal> {
  const instance = await deployTemplate(proposer, dao, spec);
  const calls = fundAndStartCalls(dao, instance);
  const details = proposalDetails(instance, summary);
  const submitted = await submitCalls(proposer, dao, calls, details, expiration);
  return { instance, id: submitted.id, calls, data: submitted.data, details, submitHash: submitted.submitHash };
}
