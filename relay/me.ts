/**
 * /me/<address>.json: identity (delegation, nonces, signing domain), shares and their NAV value,
 * every open proposal with deadlines, treasury effect and my vote, my tasks (as proposer, worker or
 * verifier) with what is pending, and the exact ragequit data. Agents read it before every intent.
 */
import { getAddress, type Address, type Hex } from "viem";

import { percent, readDaoState, type DaoState, type ProposalView, type TaskView } from "./chain.js";
import { fmtShares, fmtUsdc, type Env } from "./common.js";
import { intentDomain, ragequitData } from "./intents.js";
import { fail } from "./errors.js";

export interface Identity {
  address: Address;
  chainId: number;
  adapter: Address;
  delegated: boolean;
  /** Intent nonce (ZeroOneIntentAccount.accountNonce); 0 before delegation. */
  nonce: string;
  /** Native transaction count: the nonce an EIP-7702 authorization must carry. */
  authorizationNonce: number;
  /** Latest block timestamp: intent deadlines are checked against chain time, not wall clocks. */
  chainTime: number;
  domain: ReturnType<typeof intentDomain>;
}

export interface Me extends Identity {
  dao: { name: string; principle: string };
  custody: "self-custody" | "custodial-lite";
  shares: string;
  sharesFormatted: string;
  percent: string;
  navUsdcPerShare: string;
  settled: boolean;
  depositTreasury: string;
  /** Shares already voted to Active, unexpired tasks and not yet minted; deposits are priced including them (phase 5 ruling 4c). */
  shareLiability: string;
  exitValueUsdc: string;
  usdc: string;
  usdcFormatted: string;
  spendable: string;
  openProposals: Array<ProposalView & { myVote: "yes" | "no" | null; canVote: boolean; secondsToVotingEnd: number; secondsToGraceEnd: number; canExecute: boolean }>;
  myProposals: number[];
  myTasks: Array<TaskView & { role: string[]; pending: string[] }>;
  openTasks: number[];
  ragequit: { tokens: Address[]; data: Hex; amountAll: string };
  /** One line per flag of every open proposal (delegatecall, allowance, terminal or window-shrinking Config, spoofed instance name). */
  warnings: string[];
  pollSeconds: number;
  polledAt: string;
  blockNumber: string;
}

/**
 * Identity of an address: delegation status, intent nonce, authorization nonce and signing domain.
 *
 * @param env The connected environment.
 * @param address The member address.
 * @returns The identity.
 * @throws RelayError 409 if the address carries code that is not the Zero One adapter.
 */
export async function identity(env: Env, address: Address): Promise<Identity> {
  const adapter = env.deployment.intentAccount;
  const code = await env.publicClient.getCode({ address });
  const delegated = (code ?? "0x").toLowerCase() === `0xef0100${adapter.slice(2)}`.toLowerCase();
  if (code !== undefined && code !== "0x" && !delegated) fail(409, "address carries account code that is not the Zero One adapter; use a fresh key");
  const nonce = delegated ? ((await env.publicClient.readContract({ address, abi: env.abi.account, functionName: "accountNonce" })) as bigint) : 0n;
  const [authorizationNonce, block] = await Promise.all([env.publicClient.getTransactionCount({ address, blockTag: "pending" }), env.publicClient.getBlock()]);
  return { address: getAddress(address), chainId: env.deployment.chainId, adapter, delegated, nonce: nonce.toString(), authorizationNonce, chainTime: Number(block.timestamp), domain: intentDomain(adapter, env.deployment.chainId) };
}

/**
 * Everything one member needs to act.
 *
 * @param env The connected environment.
 * @param address The member address.
 * @param custody Custody label (T1 self-custody or T0 custodial-lite).
 * @param state A DAO state to reuse (default: fresh readDaoState).
 * @param id An identity already read (the relay passes a lag-settled one).
 * @returns The /me document.
 */
export async function me(env: Env, address: Address, custody: Me["custody"] = "self-custody", state?: DaoState, id?: Identity): Promise<Me> {
  id = id ?? (await identity(env, address));
  const dao = state ?? (await readDaoState(env));
  const d = env.deployment;
  const [shares, usdc] = await Promise.all([
    env.publicClient.readContract({ address: d.shares, abi: env.abi.shares, functionName: "balanceOf", args: [address], blockNumber: BigInt(dao.chain.blockNumber) }) as Promise<bigint>,
    env.publicClient.readContract({ address: d.settlement, abi: env.abi.settlement, functionName: "balanceOf", args: [address], blockNumber: BigInt(dao.chain.blockNumber) }) as Promise<bigint>,
  ]);
  const totalShares = BigInt(dao.treasury.totalShares);
  const treasury = BigInt(dao.treasury.usdc);
  const exitValue = totalShares === 0n ? 0n : (shares * treasury) / totalShares;
  const now = dao.chain.timestamp;
  const lower = address.toLowerCase();
  const openProposals = dao.proposals
    .filter((p) => ["Submitted", "Voting", "Grace", "Ready"].includes(p.state))
    .map((p) => {
      const mine = p.votes.find((v) => v.member.toLowerCase() === lower);
      return {
        ...p,
        myVote: mine ? (mine.approved ? ("yes" as const) : ("no" as const)) : null,
        canVote: p.state === "Voting" && mine === undefined,
        secondsToVotingEnd: Math.max(0, p.votingEnds - now),
        secondsToGraceEnd: Math.max(0, p.graceEnds - now),
        canExecute: p.state === "Ready",
      };
    });
  const myTasks = dao.tasks
    .map((t) => {
      const role: string[] = [];
      const pending: string[] = [];
      if (t.proposer.toLowerCase() === lower) role.push("proposer");
      if (t.worker.toLowerCase() === lower) role.push("worker");
      const verifier = t.verifiers.some((v) => v.toLowerCase() === lower);
      if (verifier) role.push("verifier");
      if (role.length === 0) return undefined;
      if (t.status === "Proposed") pending.push(`proposal ${t.proposalId} must pass and be executed to activate the task`);
      if (t.status === "Active" && t.worker.toLowerCase() === lower && t.evidenceHash === `0x${"0".repeat(64)}`) pending.push("deliver: commit keccak256(evidence)");
      if (t.status === "Active" && t.worker.toLowerCase() === lower && t.evidenceHash !== `0x${"0".repeat(64)}`) pending.push(`awaiting verification (${t.confirmations}/${t.threshold})`);
      if (t.status === "Active" && verifier && t.evidenceHash !== `0x${"0".repeat(64)}` && !t.confirmedBy.some((v) => v.toLowerCase() === lower)) pending.push("confirm: send the delivered evidence text");
      return { ...t, role, pending };
    })
    .filter((t): t is TaskView & { role: string[]; pending: string[] } => t !== undefined);
  const tokens = [d.settlement];
  return {
    ...id,
    dao: { name: "Zero One", principle: "Any member can propose anything; only the other members' votes or exits can stop it." },
    custody,
    shares: shares.toString(),
    sharesFormatted: fmtShares(shares),
    percent: percent(shares, totalShares),
    navUsdcPerShare: dao.treasury.navUsdcPerShare,
    settled: dao.treasury.settled,
    depositTreasury: dao.treasury.depositTreasury,
    shareLiability: dao.treasury.shareLiability,
    exitValueUsdc: fmtUsdc(exitValue),
    usdc: usdc.toString(),
    usdcFormatted: fmtUsdc(usdc),
    spendable: shares.toString(),
    openProposals,
    myProposals: dao.proposals.filter((p) => p.submittedBy?.toLowerCase() === lower || p.instance?.operator.toLowerCase() === lower).map((p) => p.id),
    myTasks,
    openTasks: dao.openTasks,
    ragequit: { tokens, data: ragequitData(tokens), amountAll: shares.toString() },
    warnings: openProposals.flatMap((proposal) => proposal.flags.map((flag) => `proposal ${proposal.id} (${proposal.state}, grace ends ${proposal.graceEnds}): ${flag}`)),
    pollSeconds: 3600,
    polledAt: new Date().toISOString(),
    blockNumber: dao.chain.blockNumber,
  };
}
