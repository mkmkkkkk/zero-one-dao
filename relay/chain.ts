/**
 * Chain index shared by the relay (/me, /proposals.json, /state.json) and the beacon build: every
 * Baal proposal with its state, deadlines, votes and decoded treasury effect; every WorkManager task;
 * every member with shares; treasury, NAV, governance parameters and the constitution hash. Read
 * from logs since the deployment's start block plus live contract reads; cached for a few seconds.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { withStateLock } from "./lock.js";
import { atomic } from "./common.js";
import { decodeAbiParameters, decodeFunctionData, getAddress, hexToBigInt, size, slice, type Address, type Hex } from "viem";

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
  /** Settlement units leaving the Safe through this call (USDC.transfer / transferFrom(safe) from the Safe). */
  usdcOut: string;
  /** Settlement units this call puts at a spender's disposal (approve / increaseAllowance by the Safe; phase 5 ruling 6, ECO-06). */
  usdcApproved: string;
  /** Warnings a voter must read even when the label looks benign (`delegatecall`, `approve`, `config`). */
  flags: string[];
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
  treasuryEffect: { usdcOut: string; usdcOutFormatted: string; usdcApproved: string; usdcApprovedFormatted: string; usdcAtRisk: string; usdcAtRiskFormatted: string; summary: string };
  /** Everything a voter must read besides the summary: delegatecall, allowances, terminal Config shapes, a details JSON naming an instance the calls never touch. */
  flags: string[];
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
  treasury: { settled: boolean; depositTreasury: string; depositTreasuryFormatted: string; shareLiability: string; shareLiabilityFormatted: string; safe: Address; usdc: string; usdcFormatted: string; totalShares: string; totalSharesFormatted: string; navUsdcPerShare: string; assets: Array<{ token: Address; symbol: string; balance: string }> };
  members: MemberView[];
  proposals: ProposalView[];
  openProposals: number[];
  tasks: TaskView[];
  openTasks: number[];
  generatedAt: string;
  /** Snapshots older than this are stale (relay polls hourly at most). */
  staleAfter: string;
}

let cache: { key: string; at: number; value: DaoState } | undefined;

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

/** Governance values of a `Baal.setGovernanceConfig` call, decoded from its bytes argument. */
export interface GovernanceConfigCall {
  votingPeriod: number;
  gracePeriod: number;
  proposalOffering: bigint;
  quorumPercent: bigint;
  sponsorThreshold: bigint;
  minRetentionPercent: bigint;
}

/** The poll cadence the README promises agents (`/me.pollSeconds`): a shorter voting + grace can pass unseen. */
export const POLL_SECONDS = 3600;

/**
 * Decode the bytes argument of `Baal.setGovernanceConfig`.
 *
 * @param data The abi.encode(uint32,uint32,uint256,uint256,uint256,uint256) bytes.
 * @returns The six values, or undefined when the bytes are not that encoding.
 */
export function decodeGovernanceConfig(data: Hex): GovernanceConfigCall | undefined {
  try {
    const [votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent] = decodeAbiParameters(
      [{ type: "uint32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      data,
    ) as unknown as [number, number, bigint, bigint, bigint, bigint];
    return { votingPeriod: Number(votingPeriod), gracePeriod: Number(gracePeriod), proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent };
  } catch {
    return undefined;
  }
}

/**
 * Warnings for a voted governance config (phase 5 ruling 10: ECO-04, T-9, GOV-07). Nothing is refused
 * on chain — the constitution allows any value — but a member polling hourly must be told that this
 * proposal would leave it no reaction window, or leave the DAO unable to decide again.
 *
 * @param config The six values the proposal would apply.
 * @param context Chain time and share supply at the read block (both change what is terminal).
 * @returns Human-readable warnings, empty when the shape is ordinary.
 */
export function governanceConfigFlags(config: GovernanceConfigCall, context: { now: number; totalShares: bigint }): string[] {
  const flags: string[] = [];
  const window = config.votingPeriod + config.gracePeriod;
  if (config.votingPeriod === 0 || config.gracePeriod === 0) {
    flags.push(`config: votingPeriod ${config.votingPeriod} / gracePeriod ${config.gracePeriod} means "unchanged" to Baal, so ConfigProposal.start() reverts NotApplied and the whole action fails (nothing is applied)`);
  } else if (window < POLL_SECONDS) {
    flags.push(`config: voting + grace = ${window} s is below the ${POLL_SECONDS} s poll cadence the README promises: a member polling hourly can miss the next proposal entirely, vote and exit included (ECO-04)`);
  }
  if (config.quorumPercent > 100n) {
    flags.push(`config: quorumPercent ${config.quorumPercent} is above 100, so no proposal can ever reach quorum again, a repair Config included: TERMINAL (T-9b)`);
  }
  if (config.sponsorThreshold >= context.totalShares && context.totalShares > 0n) {
    flags.push(`config: sponsorThreshold ${fmtShares(config.sponsorThreshold)} is at or above the whole share supply (${fmtShares(context.totalShares)}), so nobody can sponsor a proposal again: TERMINAL (T-9c)`);
  }
  const maxUint32 = 4_294_967_295;
  if (config.votingPeriod > maxUint32 - (context.now % 4_294_967_296)) {
    flags.push(`config: votingPeriod ${config.votingPeriod} overflows uint32(block.timestamp) + votingPeriod in submitProposal (Panic 0x11): nobody could submit a proposal again: TERMINAL (GOV-07b)`);
  }
  if (config.minRetentionPercent > 100n) {
    flags.push(`config: minRetentionPercent ${config.minRetentionPercent} is above 100, so every proposal fails on retention: TERMINAL`);
  }
  return flags;
}

/**
 * Decode a Baal proposalData (multiSend calldata) into labelled calls, the settlement leaving the Safe,
 * the settlement put at a spender's disposal, and the warnings a voter must read (phase 5 ruling 6).
 *
 * @param env The environment (ABIs, addresses).
 * @param proposalData The exact bytes Baal stores.
 * @param context Chain time and share supply, used only to judge governance config shapes.
 * @returns Calls, the total USDC out, the total USDC approved and the proposal-level flags.
 */
export function decodeProposalData(env: Env, proposalData: Hex, context: { now: number; totalShares: bigint } = { now: 0, totalShares: 0n }): { calls: DecodedCall[]; usdcOut: bigint; usdcApproved: bigint; flags: string[] } {
  const d = env.deployment;
  let packed: Hex;
  try {
    const decoded = decodeFunctionData({ abi: env.abi.multiSend, data: proposalData });
    packed = (decoded.args ?? [])[0] as Hex;
  } catch {
    return { calls: [{ to: d.safe, value: "0", operation: 0, selector: proposalData.slice(0, 10) as Hex, label: "not a multiSend payload", usdcOut: "0", usdcApproved: "0", flags: ["the proposalData is not a multiSend payload: read the raw bytes before voting"] }], usdcOut: 0n, usdcApproved: 0n, flags: ["the proposalData is not a multiSend payload: read the raw bytes before voting"] };
  }
  let usdcOut = 0n;
  let usdcApproved = 0n;
  const flags: string[] = [];
  const calls = unpackMultiSend(packed).map((call, index) => {
    const selector = call.data.slice(0, 10) as Hex;
    let label = `${call.to}.${selector}`;
    let out = 0n;
    let approved = 0n;
    const callFlags: string[] = [];
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
      } else if (decoded?.functionName === "transferFrom") {
        const [from, to, amount] = (decoded.args ?? []) as unknown as [Address, Address, bigint];
        if (getAddress(from) === d.safe) out = amount;
        label = `USDC.transferFrom(${from}, ${to}, ${fmtUsdc(amount)} USDC)${getAddress(from) === d.safe ? " out of the Safe" : ""}`;
      } else if (decoded?.functionName === "approve" || decoded?.functionName === "increaseAllowance") {
        const [spender, amount] = (decoded.args ?? []) as unknown as [Address, bigint];
        approved = amount;
        label = `USDC.${decoded.functionName}(${spender}, ${fmtUsdc(amount)} USDC) by the Safe`;
        callFlags.push(`allowance: ${spender} may pull ${fmtUsdc(amount)} USDC out of the Safe at any later time, outside this vote and outside any grace window (ECO-06)`);
      } else if (decoded) label = `USDC.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } else if (call.to === d.baal) {
      const decoded = tryDecode(env.abi.baal);
      if (decoded) label = `Baal.${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
      if (decoded?.functionName === "setGovernanceConfig") {
        const config = decodeGovernanceConfig((decoded.args ?? [])[0] as Hex);
        if (config === undefined) callFlags.push("config: the setGovernanceConfig argument is not the six-value encoding; read the raw bytes before voting");
        else {
          label = `Baal.setGovernanceConfig(votingPeriod ${config.votingPeriod} s, gracePeriod ${config.gracePeriod} s, proposalOffering ${config.proposalOffering}, quorumPercent ${config.quorumPercent}, sponsorThreshold ${fmtShares(config.sponsorThreshold)}, minRetentionPercent ${config.minRetentionPercent})`;
          callFlags.push(...governanceConfigFlags(config, context));
        }
      }
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
    if (call.operation !== 0) {
      label = `DELEGATECALL ${label}`;
      callFlags.push(`delegatecall: call ${index + 1} would run ${call.to}'s code as the Safe itself, which can move every asset the Safe holds; the deployment's multisend library is MultiSendCallOnly, so execution reverts instead (ECO-06)`);
    }
    if (call.value > 0n) label += ` +${call.value} wei`;
    usdcOut += out;
    usdcApproved += approved;
    flags.push(...callFlags);
    return { to: call.to, value: call.value.toString(), operation: call.operation, selector, label, usdcOut: out.toString(), usdcApproved: approved.toString(), flags: callFlags };
  });
  return { calls, usdcOut, usdcApproved, flags };
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

/**
 * Build the full DAO state (cached for `ttlMs`).
 *
 * @param env The connected environment.
 * @param ttlMs Cache lifetime in ms (default 3000; 0 forces a fresh read).
 * @returns The state.
 */
export async function readDaoState(env: Env, ttlMs = 3_000): Promise<DaoState> {
  const key = `${env.stateDir}:${env.deployment.chainId}:${env.deployment.baal}`;
  if (cache !== undefined && cache.key === key && Date.now() - cache.at < ttlMs) return cache.value;
  const value = await buildDaoState(env);
  cache = { key, at: Date.now(), value };
  return value;
}

/** Drop the cache (after the relay broadcast a transaction). */
export function invalidateState(): void {
  cache = undefined;
}

/** Public RPCs cap eth_getLogs at 10,000 blocks (sepolia.base.org: -32614); scan in chunks below that. */
const LOG_CHUNK = 9_000n;
/** Log scans are incremental: every log seen so far, with the last block covered; only newer blocks are fetched. */
interface LogCache {
  toBlock: bigint;
  blockHash: Hex;
  baal: unknown[];
  work: unknown[];
  shares: unknown[];
}

/** Submitter (tx.from) per SubmitProposal transaction hash; immutable once known. */
const submitterCache = new Map<string, Address>();
/** Immutable part of a template instance (code hash and constructor facts) per address. */
const instanceCache = new Map<Address, { codeHash: Hex; template: string; paramsHash: Hex; operator: Address }>();

/** getLogs over [from, to] in chunks the public RPC accepts. */
async function scanLogs(client: Env["publicClient"], address: Address, events: unknown[], from: bigint, to: bigint): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < to ? start + LOG_CHUNK - 1n : to;
    out.push(...(await client.getLogs({ address, events: events as never, fromBlock: start, toBlock: end })));
  }
  return out;
}

/** One contract read for readMany. */
interface ReadCall {
  address: Address;
  abi: unknown;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Many reads at one block: a single Multicall3 `aggregate3` when the chain has one (Base, Base Sepolia),
 * else individual eth_calls with bounded concurrency (local anvil). Failed calls yield `undefined`.
 */
async function readMany(client: Env["publicClient"], calls: ReadCall[], blockNumber: bigint): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const multicall3 = (client.chain as { contracts?: { multicall3?: { address: Address } } } | undefined)?.contracts?.multicall3;
  if (multicall3 !== undefined) {
    const out: unknown[] = [];
    for (let start = 0; start < calls.length; start += 120) {
      const chunk = calls.slice(start, start + 120);
      const results = (await client.multicall({ contracts: chunk as never, blockNumber, allowFailure: true, multicallAddress: multicall3.address })) as unknown as Array<{ status: string; result?: unknown }>;
      out.push(...results.map((result) => (result.status === "success" ? result.result : undefined)));
    }
    return out;
  }
  return pMap(calls, 4, async (call) => {
    try {
      return await client.readContract({ ...call, blockNumber } as never);
    } catch {
      return undefined;
    }
  });
}

/** Run `fn` over `items` with at most `limit` in flight (the public RPC rate-limits bursts). */
async function pMap<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildDaoState(env: Env): Promise<DaoState> {
  let logCache: LogCache | undefined;
  const { publicClient: client, deployment: d, abi } = env;
  const fromBlock = BigInt(d.startBlock ?? 0);
  const block = await client.getBlock();
  const toBlock = block.number;
  const treasuryLedger = getAddress(d.treasuryLedger ?? await client.readContract({ address: d.templateFactory, abi: abi.factory, functionName: "ledger", blockNumber: toBlock }) as Address);
  const [settled, depositTreasury, shareLiability] = await Promise.all([
    client.readContract({ address: treasuryLedger, abi: abi.ledger, functionName: "settled", blockNumber: toBlock }) as Promise<boolean>,
    client.readContract({ address: treasuryLedger, abi: abi.ledger, functionName: "depositTreasury", blockNumber: toBlock }) as Promise<bigint>,
    client.readContract({ address: d.workManager, abi: abi.work, functionName: "activeRewardShares", blockNumber: toBlock }) as Promise<bigint>,
  ]);
  const base = await readMany(client, [
    { address: d.settlement, abi: abi.settlement, functionName: "balanceOf", args: [d.safe] },
    { address: d.shares, abi: abi.shares, functionName: "totalSupply" },
    { address: d.baal, abi: abi.baal, functionName: "votingPeriod" },
    { address: d.baal, abi: abi.baal, functionName: "gracePeriod" },
    { address: d.baal, abi: abi.baal, functionName: "proposalOffering" },
    { address: d.baal, abi: abi.baal, functionName: "quorumPercent" },
    { address: d.baal, abi: abi.baal, functionName: "sponsorThreshold" },
    { address: d.baal, abi: abi.baal, functionName: "minRetentionPercent" },
    { address: d.constitution.address, abi: abi.constitution, functionName: "textHash" },
    { address: d.constitution.address, abi: abi.constitution, functionName: "textUrl" },
    { address: d.baal, abi: abi.baal, functionName: "proposalCount" },
  ], toBlock);
  if (base.some((value) => value === undefined)) throw new Error(`base reads failed at block ${toBlock}`);
  const [treasuryUsdc, totalShares, votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, textHash, textUrl, proposalCount] = base as [bigint, bigint, number, number, bigint, bigint, bigint, bigint, Hex, string, number];

  const baalEvents = abi.baal.filter((item) => item.type === "event" && ["SubmitProposal", "SponsorProposal", "SubmitVote", "ProcessProposal", "CancelProposal"].includes(item.name));
  const workEvents = abi.work.filter((item) => item.type === "event");
  const transferEvent = abi.shares.filter((item) => item.type === "event" && item.name === "Transfer");
  await withStateLock(env.stateDir, "index", async () => {
    const file = path.join(env.stateDir, `index-${d.chainId}-${d.baal.toLowerCase()}.json`);
    if (existsSync(file)) {
      logCache = JSON.parse(readFileSync(file, "utf8"), (_key, value) => value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.$bigint === "string" ? BigInt(value.$bigint) : value) as LogCache;
    } else logCache = undefined;
    if (logCache) {
      const checkpoint = await client.getBlock({ blockNumber: logCache.toBlock }).catch(() => undefined);
      if (logCache.toBlock > toBlock || checkpoint?.hash !== logCache.blockHash) logCache = undefined;
    }
    const scanFrom = logCache ? logCache.toBlock + 1n : fromBlock;
    if (scanFrom <= toBlock) {
      const [newBaal, newWork, newShares] = await Promise.all([
        scanLogs(client, d.baal, baalEvents, scanFrom, toBlock),
        scanLogs(client, d.workManager, workEvents, scanFrom, toBlock),
        scanLogs(client, d.shares, transferEvent, scanFrom, toBlock),
      ]);
      logCache = { toBlock, blockHash: block.hash, baal: [...(logCache?.baal ?? []), ...newBaal], work: [...(logCache?.work ?? []), ...newWork], shares: [...(logCache?.shares ?? []), ...newShares] };
      const encoded = JSON.parse(JSON.stringify(logCache, (_key, value) => typeof value === "bigint" ? { $bigint: value.toString() } : value));
      atomic(file, encoded);
      console.log(`[index] scan ${scanFrom}..${toBlock} rows=${logCache.baal.length + logCache.work.length + logCache.shares.length}`);
    } else console.log(`[index] resume ${logCache!.toBlock} scanned=0`);
  });
  const baalLogs = logCache!.baal;
  const workLogs = logCache!.work;
  const shareLogs = logCache!.shares;
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
  const submitLogs = baalLogs.filter((log) => (log as { eventName: string }).eventName === "SubmitProposal");
  await pMap(submitLogs, 4, async (log) => {
    const hash = (log as { transactionHash: Hex | null }).transactionHash;
    if (hash === null) return;
    let from = submitterCache.get(hash);
    if (from === undefined) {
      from = getAddress((await client.getTransaction({ hash })).from);
      submitterCache.set(hash, from);
    }
    const entry = submitted.get(Number((log as { args: Record<string, unknown> }).args.proposal));
    if (entry) entry.from = from;
  });

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

  const ids = Array.from({ length: Number(proposalCount) }, (_, index) => index + 1);
  const proposalReads = await readMany(client, ids.flatMap((id) => [
    { address: d.baal, abi: abi.baal, functionName: "state", args: [id] },
    { address: d.baal, abi: abi.baal, functionName: "proposals", args: [id] },
    { address: d.baal, abi: abi.baal, functionName: "getProposalStatus", args: [id] },
  ]), toBlock);
  // Phase 5 ruling 6 (A5-11): the instance panel is bound to the DECODED CALLS, never to the details
  // JSON. Candidates are the addresses the voted multicall actually calls that are not DAO contracts;
  // the details JSON only picks among them, and an `instance` it names that no call touches is flagged.
  const daoContracts = new Set<Address>([d.safe, d.baal, d.shares, d.loot, d.settlement, d.depositShaman, d.workManager, d.templateFactory, d.intentAccount, d.constitution.address, treasuryLedger]);
  const decodedOf = new Map<number, ReturnType<typeof decodeProposalData>>();
  const calledOf = new Map<number, Address[]>();
  const namedOf = new Map<number, Address>();
  for (const id of ids) {
    const decoded = decodeProposalData(env, submitted.get(id)?.data ?? "0x", { now: Number(block.timestamp), totalShares });
    decodedOf.set(id, decoded);
    calledOf.set(id, [...new Set(decoded.calls.map((call) => call.to).filter((to) => !daoContracts.has(to)))]);
    const details = submitted.get(id)?.details ?? "";
    const jsonStart = details.indexOf("{");
    if (jsonStart < 0) continue;
    try {
      const candidate = (JSON.parse(details.slice(jsonStart)) as { instance?: unknown }).instance;
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/u.test(candidate)) namedOf.set(id, getAddress(candidate));
    } catch {
      // details without JSON
    }
  }
  const instanceAddresses = [...new Set([...calledOf.values()].flat())];
  await pMap(instanceAddresses.filter((address) => !instanceCache.has(address)), 4, async (address) => {
    const code = await client.getCode({ address, blockNumber: toBlock });
    if (code === undefined || code === "0x") return;
    const { keccak256 } = await import("viem");
    instanceCache.set(address, { codeHash: keccak256(code), template: "", paramsHash: "0x" as Hex, operator: address });
  });
  const describable = instanceAddresses.filter((address) => instanceCache.has(address));
  const describes = await readMany(client, describable.map((address) => ({ address, abi: abi.proposal, functionName: "describe" })), toBlock);
  const instanceViews = new Map<Address, TemplateInstanceView>();
  for (const [index, address] of describable.entries()) {
    const result = describes[index] as readonly [string, Hex, Address, bigint, bigint, number] | undefined;
    const fixed = instanceCache.get(address)!;
    if (result === undefined) continue;
    const updated = { ...fixed, template: result[0], paramsHash: result[1], operator: getAddress(result[2]) };
    instanceCache.set(address, updated);
    instanceViews.set(address, { address, template: updated.template, paramsHash: updated.paramsHash, operator: updated.operator, budget: result[3].toString(), budgetUsdc: fmtUsdc(result[3]), deadline: Number(result[4]), status: PROPOSAL_STATUS[result[5]] ?? "Pending", codeHash: updated.codeHash });
  }
  const proposals: ProposalView[] = ids.map((id, index) => {
    const stateIndex = proposalReads[index * 3] as number;
    const raw = proposalReads[index * 3 + 1] as readonly unknown[];
    const status = proposalReads[index * 3 + 2] as readonly boolean[];
    if (stateIndex === undefined || raw === undefined || status === undefined) throw new Error(`proposal ${id}: read failed at block ${toBlock}`);
    const sub = submitted.get(id);
    const proposalData = sub?.data ?? "0x";
    const decoded = decodedOf.get(id)!;
    const flags = [...decoded.flags];
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
    const called = calledOf.get(id) ?? [];
    const describedCalls = called.filter((address) => instanceViews.has(address));
    const named = namedOf.get(id);
    const instanceAddress = named !== undefined && describedCalls.includes(named) ? named : describedCalls[0];
    const instance = instanceAddress === undefined ? undefined : { ...instanceViews.get(instanceAddress)!, submitted: submittedJson };
    if (named !== undefined && (instanceAddress === undefined || named !== instanceAddress)) {
      flags.push(`details: the proposal's details JSON names instance ${named}, which none of this proposal's calls touches${instanceAddress === undefined ? "" : ` (the calls run ${instanceAddress})`}; the panel below is built from the decoded calls, so read calls[] and ignore the name (A5-11)`);
    }
    const yes = raw[7] as bigint;
    const no = raw[8] as bigint;
    const taskId = taskProposal.get(id);
    if (taskId !== undefined) taskDetails.set(taskId, details);
    const summaryParts = [] as string[];
    if (decoded.usdcOut > 0n) summaryParts.push(`${fmtUsdc(decoded.usdcOut)} USDC leaves the Safe`);
    if (decoded.usdcApproved > 0n) summaryParts.push(`${fmtUsdc(decoded.usdcApproved)} USDC of allowance is granted on the Safe (the spender pulls it whenever it likes)`);
    if (instance) summaryParts.push(`${instance.template} contract ${instance.address} (budget ${instance.budgetUsdc} USDC, operator ${instance.operator})`);
    if (taskId !== undefined) summaryParts.push(`activates task ${taskId} (reward in shares, minted on verification)`);
    if (decoded.calls.some((call) => call.label.startsWith("Baal.setGovernanceConfig"))) summaryParts.push("changes governance parameters");
    if (decoded.calls.some((call) => call.operation !== 0)) summaryParts.push("contains a delegatecall as the Safe");
    if (summaryParts.length === 0) summaryParts.push(decoded.calls.map((call) => call.label).join("; ") || "no calls");
    if (flags.length > 0) summaryParts.push(`WARNING: ${flags.length} flag${flags.length === 1 ? "" : "s"} on this proposal (read flags[])`);
    return {
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
      treasuryEffect: {
        usdcOut: decoded.usdcOut.toString(),
        usdcOutFormatted: fmtUsdc(decoded.usdcOut),
        usdcApproved: decoded.usdcApproved.toString(),
        usdcApprovedFormatted: fmtUsdc(decoded.usdcApproved),
        usdcAtRisk: (decoded.usdcOut + decoded.usdcApproved).toString(),
        usdcAtRiskFormatted: fmtUsdc(decoded.usdcOut + decoded.usdcApproved),
        summary: summaryParts.join("; "),
      },
      flags,
      ...(instance ? { instance } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      votes: votes.get(id) ?? [],
      submittedAt: sub?.timestamp ?? 0,
    } satisfies ProposalView;
  });

  const sortedTaskIds = [...taskIds].sort((a, b) => a - b);
  const taskReads = await readMany(client, sortedTaskIds.flatMap((taskId) => [
    { address: d.workManager, abi: abi.work, functionName: "getTask", args: [taskId] },
    { address: d.workManager, abi: abi.work, functionName: "verifiersOf", args: [taskId] },
  ]), toBlock);
  const tasks: TaskView[] = sortedTaskIds.map((taskId, index) => {
    const task = taskReads[index * 2] as { proposer: Address; worker: Address; rewardShares: bigint; verifierThreshold: number; confirmations: number; round: number; proposalId: number; status: number; evidenceHash: Hex } | undefined;
    const verifierList = taskReads[index * 2 + 1] as Address[] | undefined;
    if (task === undefined || verifierList === undefined) throw new Error(`task ${taskId}: read failed at block ${toBlock}`);
    const verifiers = verifierList.map((v) => getAddress(v));
    const status = TASK_STATES[task.status] ?? "None";
    return {
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
    } satisfies TaskView;
  });

  const holders = new Set<Address>();
  for (const log of shareLogs) {
    const to = (log as unknown as { args: { to?: Address } }).args.to;
    if (to !== undefined && BigInt(to) !== 0n) holders.add(getAddress(to));
  }
  const holderList = [...holders];
  const balanceReads = await readMany(client, holderList.map((address) => ({ address: d.shares, abi: abi.shares, functionName: "balanceOf", args: [address] })), toBlock);
  const members: MemberView[] = holderList.map((address, index) => ({ address, shares: (balanceReads[index] as bigint | undefined) ?? 0n })).filter(({ shares }) => shares > 0n).map(({ address, shares }) => ({ address, shares: shares.toString(), sharesFormatted: fmtShares(shares), percent: percent(shares, totalShares) }));
  members.sort((a, b) => (BigInt(a.shares) > BigInt(b.shares) ? -1 : 1));

  const now = new Date();
  return {
    chain: { id: d.chainId, blockNumber: toBlock.toString(), timestamp: Number(block.timestamp), name: env.policy.name },
    contracts: { treasuryLedger, safe: d.safe, baal: d.baal, shares: d.shares, loot: d.loot, settlement: d.settlement, depositShaman: d.depositShaman, workManager: d.workManager, templateFactory: d.templateFactory, intentAccount: d.intentAccount, constitution: d.constitution.address },
    constitution: { address: d.constitution.address, textHash, textUrl },
    governance: { votingPeriod: Number(votingPeriod), gracePeriod: Number(gracePeriod), proposalOffering: proposalOffering.toString(), quorumPercent: quorumPercent.toString(), sponsorThreshold: sponsorThreshold.toString(), minRetentionPercent: minRetentionPercent.toString() },
    treasury: { settled, depositTreasury: depositTreasury.toString(), depositTreasuryFormatted: fmtUsdc(depositTreasury), shareLiability: shareLiability.toString(), shareLiabilityFormatted: fmtShares(shareLiability), safe: d.safe, usdc: treasuryUsdc.toString(), usdcFormatted: fmtUsdc(treasuryUsdc), totalShares: totalShares.toString(), totalSharesFormatted: fmtShares(totalShares), navUsdcPerShare: navPerShare(depositTreasury, totalShares + shareLiability), assets: [{ token: d.settlement, symbol: "USDC", balance: treasuryUsdc.toString() }] },
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
