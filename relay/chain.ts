/**
 * Chain index shared by the relay (/me, /proposals.json, /state.json) and the beacon build: every
 * Baal proposal with its state, deadlines, votes and decoded treasury effect; every WorkManager task;
 * every member with shares; treasury, NAV, governance parameters and the constitution hash. Read
 * from logs since the deployment's start block plus live contract reads; cached for a few seconds.
 */
import { decodeFunctionData, getAddress, hexToBigInt, size, slice, type Address, type Hex } from "viem";

import { PROPOSAL_STATUS, type ProposalStatusName } from "../src/proposals.js";
import { fmtShares, fmtUsdc, SETTLEMENT_UNIT, UNIT, type Env } from "./common.js";

export const PROPOSAL_STATES = ["Unborn", "Submitted", "Voting", "Cancelled", "Grace", "Ready", "Processed", "Defeated"] as const;
export type ProposalStateName = (typeof PROPOSAL_STATES)[number];
export const TASK_STATES = ["None", "Proposed", "Active", "Complete", "Cancelled"] as const;
export type TaskStateName = (typeof TASK_STATES)[number];

/** One call of a voted multicall, labelled for humans. */
export interface DecodedCall {
  to: Address;
  value: string;
  operation: number;
  selector: Hex;
  label: string;
  /** Settlement units leaving the Safe through this call (USDC.transfer from the Safe). */
  usdcOut: string;
}

export interface TemplateInstanceView {
  address: Address;
  template: string;
  paramsHash: Hex;
  operator: Address;
  budget: string;
  budgetUsdc: string;
  deadline: number;
  status: ProposalStatusName;
  /** keccak256 of the runtime code at the address. */
  codeHash?: Hex;
  /** Parsed from the details JSON (template, params, codeHash as submitted). */
  submitted?: Record<string, unknown>;
}

export interface ProposalView {
  id: number;
  state: ProposalStateName;
  sponsor: Address;
  submittedBy?: Address;
  selfSponsor: boolean;
  votingStarts: number;
  votingEnds: number;
  graceEnds: number;
  expiration: number;
  yesVotes: string;
  noVotes: string;
  yesShares: string;
  noShares: string;
  cancelled: boolean;
  processed: boolean;
  passed: boolean;
  actionFailed: boolean;
  details: string;
  proposalData: Hex;
  proposalDataHash: Hex;
  calls: DecodedCall[];
  treasuryEffect: { usdcOut: string; usdcOutFormatted: string; summary: string };
  instance?: TemplateInstanceView;
  /** Task activated by this proposal (WorkManager), if any. */
  taskId?: number;
  votes: Array<{ member: Address; approved: boolean; balance: string }>;
  submittedAt: number;
}

export interface TaskView {
  taskId: number;
  proposalId: number;
  proposer: Address;
  worker: Address;
  verifiers: Address[];
  threshold: number;
  confirmations: number;
  round: number;
  rewardShares: string;
  rewardSharesFormatted: string;
  status: TaskStateName;
  evidenceHash: Hex;
  details: string;
  openForClaim: boolean;
  confirmedBy: Address[];
}

export interface MemberView {
  address: Address;
  shares: string;
  sharesFormatted: string;
  percent: string;
}

export interface DaoState {
  chain: { id: number; blockNumber: string; timestamp: number; name: string };
  contracts: Record<string, Address>;
  constitution: { address: Address; textHash: Hex; textUrl: string };
  governance: { votingPeriod: number; gracePeriod: number; proposalOffering: string; quorumPercent: string; sponsorThreshold: string; minRetentionPercent: string };
  treasury: { safe: Address; usdc: string; usdcFormatted: string; totalShares: string; totalSharesFormatted: string; navUsdcPerShare: string; assets: Array<{ token: Address; symbol: string; balance: string }> };
  members: MemberView[];
  proposals: ProposalView[];
  openProposals: number[];
  tasks: TaskView[];
  openTasks: number[];
  generatedAt: string;
  /** Snapshots older than this are stale (relay polls hourly at most). */
  staleAfter: string;
}

let cache: { at: number; value: DaoState } | undefined;

/**
 * Unpack Gnosis MultiSend bytes (operation|to|value|dataLength|data) into calls.
 *
 * @param packed The packed transactions.
 * @returns The calls in order.
 */
export function unpackMultiSend(packed: Hex): Array<{ operation: number; to: Address; value: bigint; data: Hex }> {
  const calls: Array<{ operation: number; to: Address; value: bigint; data: Hex }> = [];
  let offset = 0;
  const total = size(packed);
  while (offset < total) {
    const operation = Number(hexToBigInt(slice(packed, offset, offset + 1)));
    const to = getAddress(slice(packed, offset + 1, offset + 21));
    const value = hexToBigInt(slice(packed, offset + 21, offset + 53));
    const length = Number(hexToBigInt(slice(packed, offset + 53, offset + 85)));
    const data = length === 0 ? "0x" : slice(packed, offset + 85, offset + 85 + length);
    calls.push({ operation, to, value, data });
    offset += 85 + length;
  }
  return calls;
}

/**
 * Decode a Baal proposalData (multiSend calldata) into labelled calls and the settlement leaving the Safe.
 *
 * @param env The environment (ABIs, addresses).
 * @param proposalData The exact bytes Baal stores.
 * @returns Calls and the total USDC out.
 */
export function decodeProposalData(env: Env, proposalData: Hex): { calls: DecodedCall[]; usdcOut: bigint } {
  const d = env.deployment;
  let packed: Hex;
  try {
    const decoded = decodeFunctionData({ abi: env.abi.multiSend, data: proposalData });
    packed = (decoded.args ?? [])[0] as Hex;
  } catch {
    return { calls: [{ to: d.safe, value: "0", operation: 0, selector: proposalData.slice(0, 10) as Hex, label: "not a multiSend payload", usdcOut: "0" }], usdcOut: 0n };
  }
  let usdcOut = 0n;
  const calls = unpackMultiSend(packed).map((call) => {
    const selector = call.data.slice(0, 10) as Hex;
    let label = `${call.to}.${selector}`;
    let out = 0n;
    const tryDecode = (abi: typeof env.abi.baal) => {
      try {
        return decodeFunctionData({ abi, data: call.data });
      } catch {
        return undefined;
      }
    };
    if (call.to === d.settlement) {
      const decoded = tryDecode(env.abi.settlement);
      if (decoded?.functionName === "transfer") {
        const [to, amount] = (decoded.args ?? []) as unknown as [Address, bigint];
        out = amount;
        label = `USDC.transfer(${to}, ${fmtUsdc(amount)} USDC) from the Safe`;
      } else if (decoded) label = `USDC.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else if (call.to === d.baal) {
      const decoded = tryDecode(env.abi.baal);
      if (decoded) label = `Baal.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else if (call.to === d.workManager) {
      const decoded = tryDecode(env.abi.work);
      if (decoded) label = `WorkManager.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else if (call.to === d.templateFactory) {
      const decoded = tryDecode(env.abi.factory);
      if (decoded) label = `TemplateFactory.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else if (call.to === d.safe) {
      const decoded = tryDecode(env.abi.safe);
      if (decoded) label = `Safe.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else {
      const decoded = tryDecode(env.abi.proposal);
      if (decoded) label = `${call.to}.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    }
    if (call.value > 0n) label += ` +${call.value} wei`;
    usdcOut += out;
    return { to: call.to, value: call.value.toString(), operation: call.operation, selector, label, usdcOut: out.toString() };
  });
  return { calls, usdcOut };
}

/** Percent of `part` in `whole` with 4 decimals. */
export function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0";
  return (Number((part * 1_000_000n) / whole) / 10_000).toFixed(4);
}

/** NAV in USDC per share as a decimal string (6 decimals). */
export function navPerShare(treasuryUsdc: bigint, totalShares: bigint): string {
  if (totalShares === 0n) return treasuryUsdc === 0n ? "1" : "0";
  return fmtUsdc((treasuryUsdc * UNIT) / totalShares);
}

/** Read one template instance's describe() and code hash; undefined if the address has no code. */
async function readInstance(env: Env, address: Address, submitted?: Record<string, unknown>): Promise<TemplateInstanceView | undefined> {
  const code = await env.publicClient.getCode({ address });
  if (code === undefined || code === "0x") return undefined;
  try {
    const result = (await env.publicClient.readContract({ address, abi: env.abi.proposal, functionName: "describe" })) as readonly [string, Hex, Address, bigint, bigint, number];
    const { keccak256 } = await import("viem");
    return { address, template: result[0], paramsHash: result[1], operator: getAddress(result[2]), budget: result[3].toString(), budgetUsdc: fmtUsdc(result[3]), deadline: Number(result[4]), status: PROPOSAL_STATUS[result[5]] ?? "Pending", codeHash: keccak256(code), submitted };
  } catch {
    return undefined;
  }
}

/**
 * Build the full DAO state (cached for `ttlMs`).
 *
 * @param env The connected environment.
 * @param ttlMs Cache lifetime in ms (default 3000; 0 forces a fresh read).
 * @returns The state.
 */
export async function readDaoState(env: Env, ttlMs = 3_000): Promise<DaoState> {
  if (cache !== undefined && Date.now() - cache.at < ttlMs) return cache.value;
  const value = await buildDaoState(env);
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the cache (after the relay broadcast a transaction). */
export function invalidateState(): void {
  cache = undefined;
}

async function buildDaoState(env: Env): Promise<DaoState> {
  const { publicClient: client, deployment: d, abi } = env;
  const fromBlock = BigInt(d.startBlock ?? 0);
  const block = await client.getBlock();
  const toBlock = block.number;
  const read = <T,>(address: Address, contractAbi: typeof abi.baal, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: contractAbi, functionName, args, blockNumber: toBlock } as never) as Promise<T>;

  const [treasuryUsdc, totalShares, votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, textHash, textUrl, proposalCount] = await Promise.all([
    read<bigint>(d.settlement, abi.settlement, "balanceOf", [d.safe]),
    read<bigint>(d.shares, abi.shares, "totalSupply"),
    read<number>(d.baal, abi.baal, "votingPeriod"),
    read<number>(d.baal, abi.baal, "gracePeriod"),
    read<bigint>(d.baal, abi.baal, "proposalOffering"),
    read<bigint>(d.baal, abi.baal, "quorumPercent"),
    read<bigint>(d.baal, abi.baal, "sponsorThreshold"),
    read<bigint>(d.baal, abi.baal, "minRetentionPercent"),
    read<Hex>(d.constitution.address, abi.constitution, "textHash"),
    read<string>(d.constitution.address, abi.constitution, "textUrl"),
    read<number>(d.baal, abi.baal, "proposalCount"),
  ]);

  const baalEvents = abi.baal.filter((item) => item.type === "event" && ["SubmitProposal", "SponsorProposal", "SubmitVote", "ProcessProposal", "CancelProposal"].includes(item.name));
  const baalLogs = await client.getLogs({ address: d.baal, events: baalEvents as never, fromBlock, toBlock });
  const submitted = new Map<number, { data: Hex; details: string; selfSponsor: boolean; timestamp: number; from?: Address }>();
  const votes = new Map<number, Array<{ member: Address; approved: boolean; balance: string }>>();
  for (const log of baalLogs) {
    const args = (log as { args: Record<string, unknown>; eventName: string; transactionHash: Hex }).args;
    const name = (log as { eventName: string }).eventName;
    if (name === "SubmitProposal") {
      const id = Number(args.proposal);
      submitted.set(id, { data: args.proposalData as Hex, details: String(args.details ?? ""), selfSponsor: Boolean(args.selfSponsor), timestamp: Number(args.timestamp) });
    } else if (name === "SubmitVote") {
      const id = Number(args.proposal);
      const list = votes.get(id) ?? [];
      list.push({ member: getAddress(args.member as Address), approved: Boolean(args.approved), balance: String(args.balance) });
      votes.set(id, list);
    }
  }
  // Who submitted: the transaction sender (the member's own address under EIP-7702, or the WorkManager for tasks).
  const submitters = new Map<Hex, Address>();
  for (const log of baalLogs) {
    if ((log as { eventName: string }).eventName !== "SubmitProposal") continue;
    const hash = (log as { transactionHash: Hex | null }).transactionHash;
    if (hash === null || submitters.has(hash)) continue;
    const tx = await client.getTransaction({ hash });
    submitters.set(hash, getAddress(tx.from));
    const id = Number((log as { args: Record<string, unknown> }).args.proposal);
    const entry = submitted.get(id);
    if (entry) entry.from = getAddress(tx.from);
  }

  const workEvents = abi.work.filter((item) => item.type === "event");
  const workLogs = await client.getLogs({ address: d.workManager, events: workEvents as never, fromBlock, toBlock });
  const taskIds = new Set<number>();
  const taskDetails = new Map<number, string>();
  const taskProposal = new Map<number, number>();
  const confirmedBy = new Map<string, Address[]>();
  for (const log of workLogs) {
    const { eventName, args } = log as unknown as { eventName: string; args: Record<string, unknown> };
    if (eventName === "TaskProposed") {
      const taskId = Number(args.taskId);
      taskIds.add(taskId);
      taskProposal.set(Number(args.proposalId), taskId);
    } else if (eventName === "DeliveryConfirmed") {
      const key = `${Number(args.taskId)}:${Number(args.round)}`;
      const list = confirmedBy.get(key) ?? [];
      list.push(getAddress(args.verifier as Address));
      confirmedBy.set(key, list);
    }
  }

  const proposals: ProposalView[] = [];
  for (let id = 1; id <= Number(proposalCount); id += 1) {
    const [stateIndex, raw, status] = await Promise.all([
      read<number>(d.baal, abi.baal, "state", [id]),
      read<readonly unknown[]>(d.baal, abi.baal, "proposals", [id]),
      read<readonly boolean[]>(d.baal, abi.baal, "getProposalStatus", [id]),
    ]);
    const sub = submitted.get(id);
    const proposalData = sub?.data ?? "0x";
    const decoded = decodeProposalData(env, proposalData);
    const details = sub?.details ?? "";
    let submittedJson: Record<string, unknown> | undefined;
    const jsonStart = details.indexOf("{");
    if (jsonStart >= 0) {
      try {
        submittedJson = JSON.parse(details.slice(jsonStart)) as Record<string, unknown>;
      } catch {
        submittedJson = undefined;
      }
    }
    let instance: TemplateInstanceView | undefined;
    const instanceAddress = submittedJson?.instance;
    if (typeof instanceAddress === "string" && /^0x[0-9a-fA-F]{40}$/u.test(instanceAddress)) instance = await readInstance(env, getAddress(instanceAddress), submittedJson);
    const yes = raw[7] as bigint;
    const no = raw[8] as bigint;
    const taskId = taskProposal.get(id);
    if (taskId !== undefined) taskDetails.set(taskId, details);
    const summaryParts = [] as string[];
    if (decoded.usdcOut > 0n) summaryParts.push(`${fmtUsdc(decoded.usdcOut)} USDC leaves the Safe`);
    if (instance) summaryParts.push(`${instance.template} contract ${instance.address} (budget ${instance.budgetUsdc} USDC, operator ${instance.operator})`);
    if (taskId !== undefined) summaryParts.push(`activates task ${taskId} (reward in shares, minted on verification)`);
    if (decoded.calls.some((call) => call.label.startsWith("Baal.setGovernanceConfig"))) summaryParts.push("changes governance parameters");
    if (summaryParts.length === 0) summaryParts.push(decoded.calls.map((call) => call.label).join("; ") || "no calls");
    proposals.push({
      id,
      state: PROPOSAL_STATES[stateIndex] ?? "Unborn",
      sponsor: getAddress(raw[11] as Address),
      submittedBy: sub?.from,
      selfSponsor: sub?.selfSponsor ?? false,
      votingStarts: Number(raw[2]),
      votingEnds: Number(raw[3]),
      graceEnds: Number(raw[4]),
      expiration: Number(raw[5]),
      yesVotes: yes.toString(),
      noVotes: no.toString(),
      yesShares: fmtShares(yes),
      noShares: fmtShares(no),
      cancelled: status[0] ?? false,
      processed: status[1] ?? false,
      passed: status[2] ?? false,
      actionFailed: status[3] ?? false,
      details,
      proposalData,
      proposalDataHash: raw[12] as Hex,
      calls: decoded.calls,
      treasuryEffect: { usdcOut: decoded.usdcOut.toString(), usdcOutFormatted: fmtUsdc(decoded.usdcOut), summary: summaryParts.join("; ") },
      ...(instance ? { instance } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      votes: votes.get(id) ?? [],
      submittedAt: sub?.timestamp ?? 0,
    });
  }

  const tasks: TaskView[] = [];
  for (const taskId of [...taskIds].sort((a, b) => a - b)) {
    const task = await read<{ proposer: Address; worker: Address; rewardShares: bigint; verifierThreshold: number; confirmations: number; round: number; proposalId: number; status: number; evidenceHash: Hex }>(d.workManager, abi.work, "getTask", [taskId]);
    const verifiers = (await read<Address[]>(d.workManager, abi.work, "verifiersOf", [taskId])).map((v) => getAddress(v));
    const status = TASK_STATES[task.status] ?? "None";
    tasks.push({
      taskId,
      proposalId: Number(task.proposalId),
      proposer: getAddress(task.proposer),
      worker: getAddress(task.worker),
      verifiers,
      threshold: Number(task.verifierThreshold),
      confirmations: Number(task.confirmations),
      round: Number(task.round),
      rewardShares: task.rewardShares.toString(),
      rewardSharesFormatted: fmtShares(task.rewardShares),
      status,
      evidenceHash: task.evidenceHash,
      details: taskDetails.get(taskId) ?? "",
      openForClaim: status === "Active" && BigInt(task.worker) === 0n,
      confirmedBy: confirmedBy.get(`${taskId}:${Number(task.round)}`) ?? [],
    });
  }

  const transferEvent = abi.shares.filter((item) => item.type === "event" && item.name === "Transfer");
  const shareLogs = await client.getLogs({ address: d.shares, events: transferEvent as never, fromBlock, toBlock });
  const holders = new Set<Address>();
  for (const log of shareLogs) {
    const to = (log as unknown as { args: { to?: Address } }).args.to;
    if (to !== undefined && BigInt(to) !== 0n) holders.add(getAddress(to));
  }
  const members: MemberView[] = [];
  for (const address of holders) {
    const shares = await read<bigint>(d.shares, abi.shares, "balanceOf", [address]);
    if (shares > 0n) members.push({ address, shares: shares.toString(), sharesFormatted: fmtShares(shares), percent: percent(shares, totalShares) });
  }
  members.sort((a, b) => (BigInt(a.shares) > BigInt(b.shares) ? -1 : 1));

  const now = new Date();
  return {
    chain: { id: d.chainId, blockNumber: toBlock.toString(), timestamp: Number(block.timestamp), name: env.policy.name },
    contracts: { safe: d.safe, baal: d.baal, shares: d.shares, loot: d.loot, settlement: d.settlement, depositShaman: d.depositShaman, workManager: d.workManager, templateFactory: d.templateFactory, intentAccount: d.intentAccount, constitution: d.constitution.address },
    constitution: { address: d.constitution.address, textHash, textUrl },
    governance: { votingPeriod: Number(votingPeriod), gracePeriod: Number(gracePeriod), proposalOffering: proposalOffering.toString(), quorumPercent: quorumPercent.toString(), sponsorThreshold: sponsorThreshold.toString(), minRetentionPercent: minRetentionPercent.toString() },
    treasury: { safe: d.safe, usdc: treasuryUsdc.toString(), usdcFormatted: fmtUsdc(treasuryUsdc), totalShares: totalShares.toString(), totalSharesFormatted: fmtShares(totalShares), navUsdcPerShare: navPerShare(treasuryUsdc, totalShares), assets: [{ token: d.settlement, symbol: "USDC", balance: treasuryUsdc.toString() }] },
    members,
    proposals,
    openProposals: proposals.filter((p) => ["Submitted", "Voting", "Grace", "Ready"].includes(p.state)).map((p) => p.id),
    tasks,
    openTasks: tasks.filter((t) => t.openForClaim).map((t) => t.taskId),
    generatedAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}

export { SETTLEMENT_UNIT };
