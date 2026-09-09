/**
 * Audit rows W-1 .. W-4, W-6 (WorkManager, security-audit component 3) on the anvil mirror.
 *
 * W-1 deferred mint: the share reward of a task is minted whenever the verifiers confirm, not when the
 *     vote passes; a depositor who joins after vote + grace is priced without the approved liability
 *     and diluted at mint time, with no vote and no exit window of its own.
 * W-2 claim blocking: any non-verifier address can claim an Active task first; there is no unclaim,
 *     no claim deadline, and cancel needs a passed proposal.
 * W-3 proposer as worker: the proposer may claim and deliver its own task; a verifier that is merely
 *     a second key of the proposer is indistinguishable in code.
 * W-4 expiration edge: a task whose activation proposal expires before processing stays Proposed
 *     forever; Baal refuses expirations inside voting + grace.
 * W-6 onlySafe: activateTask / cancelTask revert for anyone but the Safe.
 *
 * Run: `npx tsx evidence/audit/work-templates/work-invariants.ts` (exit code 1 = findings demonstrated).
 */
import { keccak256, stringToHex, type Hex } from "viem";

import {
  type ActorName,
  assert,
  boot,
  DAY,
  deposit,
  expectRevert,
  fmt,
  fmtS,
  type Mirror,
  now,
  pct,
  processProposal,
  proposalInfo,
  ragequit,
  read,
  runIfMain,
  seedMembers,
  send,
  SETTLEMENT_UNIT,
  shutdown,
  simulate,
  snapshot,
  sponsor,
  stateOf,
  step,
  UNIT,
  vote,
  warp,
  warpPastGrace,
} from "../../../scenarios/lib.js";
import { finish, invariant } from "./_harness.js";

const STATUS = ["None", "Proposed", "Active", "Complete", "Cancelled"] as const;

interface Task {
  proposer: string;
  worker: string;
  rewardShares: bigint;
  verifierThreshold: number;
  confirmations: number;
  round: number;
  proposalId: number;
  status: number;
  evidenceHash: Hex;
}

/**
 * Submit a task, sponsor it, vote YES with `voters`, pass grace and execute the activation.
 *
 * Args:
 *   mirror: The booted mirror.
 *   proposer: Actor that calls submitTask (recorded as the task's proposer).
 *   verifiers: Verifier addresses.
 *   threshold: Confirmations required.
 *   reward: Reward in shares (18 decimals).
 *   expiration: Baal expiration (0 = none).
 *   details: Proposal text.
 *   voters: Actors voting YES.
 *
 * Returns:
 *   Task id, Baal proposal id and the processProposal result.
 */
async function activateTask(
  mirror: Mirror,
  proposer: ActorName,
  verifiers: `0x${string}`[],
  threshold: number,
  reward: bigint,
  expiration: number,
  details: string,
  voters: ActorName[],
): Promise<{ taskId: bigint; proposalId: number; processed: Awaited<ReturnType<typeof processProposal>> }> {
  await send(mirror, proposer, "work", "submitTask", [verifiers, threshold, reward, expiration, details], `${proposer} submitTask "${details}"`);
  const taskId = await read<bigint>(mirror, "work", "taskCount");
  const task = await read<Task>(mirror, "work", "getTask", [taskId]);
  const proposalId = task.proposalId;
  await sponsor(mirror, proposer, proposalId);
  for (const voter of voters) await vote(mirror, voter, proposalId, true);
  await warpPastGrace(mirror, proposalId);
  const data = await read<Hex>(mirror, "work", "activationData", [taskId]);
  const processed = await processProposal(mirror, "C", { id: proposalId, data, submit: { hash: "0x", blockNumber: 0n, gasUsed: 0n } });
  return { taskId, proposalId, processed };
}

/**
 * Read a task and print its status.
 *
 * Args:
 *   mirror: The booted mirror.
 *   taskId: Task id.
 *
 * Returns:
 *   The task struct.
 */
async function taskOf(mirror: Mirror, taskId: bigint): Promise<Task> {
  const task = await read<Task>(mirror, "work", "getTask", [taskId]);
  console.log(`   task #${taskId}: status ${STATUS[task.status]} worker ${task.worker} reward ${fmt(task.rewardShares)} round ${task.round} confirmations ${task.confirmations}`);
  return task;
}

/**
 * Run the WorkManager audit demonstrations.
 *
 * Returns:
 *   Nothing; prints receipts, numbers and the verdict block.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-work");
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const C = mirror.actors.C.account.address;
    const O = mirror.actors.O.account.address;
    const W = mirror.actors.W.account.address;
    const evidence = stringToHex("evidence: deliverable v1");

    // ---------------------------------------------------------------- W-1 deferred mint
    step("W-1: A proposes task #1 with reward 9150 shares (3x the 3050 supply); A and B vote YES; activated after grace, nothing minted");
    const reward1 = 9_150n * UNIT;
    const t1 = await activateTask(mirror, "A", [B, C], 2, reward1, 0, "task: 9150 shares to whoever delivers (verifiers B, C)", ["A", "B"]);
    assert(t1.processed.info.status.passed && !t1.processed.info.status.actionFailed, "activation executed by the Safe");
    const atVote = await snapshot(mirror, "at activation", ["A", "B", "C", "F"]);
    const rewardValueAtVote = (reward1 * atVote.safeSettlement) / (atVote.totalShares + reward1);
    console.log(`   reward value if minted now: ${fmt(reward1)} / ${fmt(atVote.totalShares + reward1)} of ${fmtS(atVote.safeSettlement)} USDC = ${fmtS(rewardValueAtVote)} USDC`);
    assert((await taskOf(mirror, t1.taskId)).status === 2, "task #1 Active; reward not yet minted");

    step("W-1: 30 days pass; the task is still Active (no expiry); D, who never saw the vote, deposits 10,000 USDC at NAV");
    await warp(mirror, 30 * DAY, "30 days after activation");
    invariant("W-1", (await taskOf(mirror, t1.taskId)).status !== 2, "an Active task cannot mint after a bounded time (observed: still Active 30 days after activation, no deadline exists)");
    const quoted = await read<bigint>(mirror, "deposit", "quote", [10_000n * SETTLEMENT_UNIT]);
    const fairShares = (10_000n * SETTLEMENT_UNIT * (atVote.totalShares + reward1)) / atVote.safeSettlement;
    console.log(`   deposit quote for 10,000 USDC = ${fmt(quoted)} shares; quote including the approved 9150-share liability would be ${fmt(fairShares)} shares`);
    invariant("W-1", quoted >= fairShares, `the deposit quote prices in approved-but-unminted task rewards (quoted ${fmt(quoted)} shares, liability-adjusted ${fmt(fairShares)} shares)`);
    const dDeposit = await deposit(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    const afterDeposit = await snapshot(mirror, "after D's deposit", ["D"]);
    const dExitBefore = (afterDeposit.shares.D! * afterDeposit.safeSettlement) / afterDeposit.totalShares;
    console.log(`   D exit value now = ${fmtS(dExitBefore)} USDC (${pct(afterDeposit.shares.D!, afterDeposit.totalShares)} of ${fmtS(afterDeposit.safeSettlement)})`);

    step("W-1: W claims, delivers; B and C confirm -> 9150 shares mint to W; W ragequits the same block");
    await send(mirror, "W", "work", "claim", [t1.taskId], "W claims task #1");
    await send(mirror, "W", "work", "deliver", [t1.taskId, keccak256(evidence)], "W delivers");
    await send(mirror, "B", "work", "confirm", [t1.taskId, evidence], "B confirms (1/2)");
    await send(mirror, "C", "work", "confirm", [t1.taskId, evidence], "C confirms (2/2) -> mint");
    const afterMint = await snapshot(mirror, "after mint", ["W", "D"]);
    assert(afterMint.shares.W === reward1, "W holds exactly the voted 9150 shares");
    const wExit = await ragequit(mirror, "W");
    const afterExit = await snapshot(mirror, "after W's exit", ["W", "D"]);
    const dExitAfter = (afterExit.shares.D! * afterExit.safeSettlement) / afterExit.totalShares;
    console.log(`   W was paid ${fmtS(wExit.paid)} USDC for a reward worth ${fmtS(rewardValueAtVote)} USDC when it was voted (+${fmtS(wExit.paid - rewardValueAtVote)} USDC funded by D)`);
    console.log(`   D deposited ${fmtS(10_000n * SETTLEMENT_UNIT)} USDC ${dDeposit.receipt.blockNumber > 0n ? "" : ""}and can now exit for ${fmtS(dExitAfter)} USDC (loss ${fmtS(dExitBefore - dExitAfter)} USDC = ${pct(dExitBefore - dExitAfter, dExitBefore)})`);
    invariant("W-1", dExitAfter >= 10_000n * SETTLEMENT_UNIT, `a depositor who joins after a task's vote and grace is not diluted by that task's later mint (D: 10,000 USDC in, exit value ${fmtS(dExitAfter)} USDC after the mint)`);
    invariant("W-1", wExit.paid <= rewardValueAtVote, `a task reward pays at most its value at the vote (voted worth ${fmtS(rewardValueAtVote)} USDC, paid ${fmtS(wExit.paid)} USDC)`);

    // ---------------------------------------------------------------- W-2 claim blocking
    step("W-2: task #2 (reward 10 shares, verifiers B, C) is activated; stranger D claims it in the first block; the intended worker W is locked out");
    const t2 = await activateTask(mirror, "A", [B, C], 2, 10n * UNIT, 0, "task: 10 shares (verifiers B, C)", ["A", "B"]);
    assert(t2.processed.info.status.passed, "task #2 activated");
    const claim = await send(mirror, "D", "work", "claim", [t2.taskId], "D (stranger, no shares needed) claims task #2");
    console.log(`   cost to D: ${claim.gasUsed} gas; D never delivers`);
    await expectRevert(simulate(mirror, "W", "work", "claim", [t2.taskId]), "TaskAlreadyClaimed", "W cannot claim task #2 any more");
    await expectRevert(simulate(mirror, "A", "work", "cancelTask", [t2.taskId]), "OnlySafe", "the proposer cannot cancel; only a passed proposal (>= votingPeriod + gracePeriod = 12 h) can");
    const workAbi = mirror.abi.work.filter((item) => item.type === "function").map((item) => (item as { name: string }).name);
    const reassign = workAbi.filter((name) => /unclaim|reassign|release|abandon|timeout|expire/iu.test(name));
    console.log(`   WorkManager functions: ${workAbi.join(", ")}`);
    invariant("W-2", reassign.length !== 0, `a claimed task that is never delivered can be reassigned without a passed proposal (functions matching unclaim/reassign/timeout: ${reassign.length}; remedy = cancel proposal 12 h + new task proposal 12 h)`);
    await warp(mirror, 7 * DAY, "a week later");
    invariant("W-2", (await taskOf(mirror, t2.taskId)).worker.toLowerCase() !== D_lower(mirror), "a claim that never delivers lapses (observed: D still the worker after 7 days)");

    // ---------------------------------------------------------------- W-3 proposer as worker
    step("W-3: A proposes task #3 naming O (a fresh key, e.g. A's own second key) as the single verifier; A alone votes YES; A claims and delivers its own task; O confirms");
    const t3 = await activateTask(mirror, "A", [O], 1, 100n * UNIT, 0, "task: 100 shares, verifier O", ["A"]);
    assert(t3.processed.info.status.passed, "task #3 activated with A's 1000 YES against 0 NO (B, C, F silent)");
    const aSharesBefore = await read<bigint>(mirror, "shares", "balanceOf", [A]);
    let proposerClaimed = false;
    try {
      await send(mirror, "A", "work", "claim", [t3.taskId], "A (proposer) claims its own task");
      proposerClaimed = true;
    } catch (error) {
      console.log(`   proposer claim reverted: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    invariant("W-3", !proposerClaimed, "the proposer of a task cannot claim (be paid as the worker of) its own task");
    if (proposerClaimed) {
      await send(mirror, "A", "work", "deliver", [t3.taskId, keccak256(evidence)], "A delivers to itself");
      await send(mirror, "O", "work", "confirm", [t3.taskId, evidence], "O confirms (1/1) -> mint to A");
      const aSharesAfter = await read<bigint>(mirror, "shares", "balanceOf", [A]);
      console.log(`   A: ${fmt(aSharesBefore)} -> ${fmt(aSharesAfter)} shares; cost to A = gas of 4 transactions + one extra key; the only check was the vote (B, C, F did not vote)`);
      invariant("W-3", aSharesAfter === aSharesBefore, `proposer + one second key cannot mint the task reward to the proposer (minted ${fmt(aSharesAfter - aSharesBefore)} shares to the proposer)`);
    }

    // ---------------------------------------------------------------- W-4 expiration edges
    step("W-4: expiration inside voting + grace is refused; a passed activation that is processed after its expiration does nothing and leaves the task Proposed forever");
    const t = Number(await now(mirror));
    const votingPeriod = Number(await read<number>(mirror, "baal", "votingPeriod"));
    const gracePeriod = Number(await read<number>(mirror, "baal", "gracePeriod"));
    await expectRevert(simulate(mirror, "A", "work", "submitTask", [[B], 1, 1n * UNIT, t + votingPeriod + gracePeriod, "task: expiration == now + voting + grace"]), "expired", "Baal refuses expiration <= now + votingPeriod + gracePeriod");
    const expiration = t + votingPeriod + gracePeriod + 120;
    await send(mirror, "A", "work", "submitTask", [[B], 1, 1n * UNIT, expiration, "task: expires 120 s after grace"], "A submitTask with expiration");
    const taskId4 = await read<bigint>(mirror, "work", "taskCount");
    const proposalId4 = (await read<Task>(mirror, "work", "getTask", [taskId4])).proposalId;
    await sponsor(mirror, "A", proposalId4);
    await vote(mirror, "A", proposalId4, true);
    await warpPastGrace(mirror, proposalId4);
    await warp(mirror, 300, "past the expiration");
    const info4 = await proposalInfo(mirror, proposalId4);
    console.log(`   proposal #${proposalId4}: expiration ${expiration}, now ${await now(mirror)}, state ${await stateOf(mirror, proposalId4)}, yes ${fmt(info4.yesVotes)} no ${fmt(info4.noVotes)}`);
    const data4 = await read<Hex>(mirror, "work", "activationData", [taskId4]);
    const processed4 = await processProposal(mirror, "C", { id: proposalId4, data: data4, submit: { hash: "0x", blockNumber: 0n, gasUsed: 0n } });
    assert(!processed4.info.status.passed && !processed4.info.status.actionFailed, "expired proposal processed as not passed, no action");
    const task4 = await taskOf(mirror, taskId4);
    assert(task4.status === 1, "task #4 stays Proposed (never Active, never Cancelled)");
    await expectRevert(simulate(mirror, "A", "work", "cancelTask", [taskId4]), "OnlySafe", "the proposer cannot clean it up; only a passed proposal can cancel");
    invariant("W-4", task4.status !== 1, "a task whose activation proposal expired is closed automatically (observed: Proposed forever; harmless: nothing minted, id simply dead)");

    // ---------------------------------------------------------------- W-6 activation only by Safe
    step("W-6: activateTask / cancelTask are onlySafe");
    await expectRevert(simulate(mirror, "A", "work", "activateTask", [taskId4]), "OnlySafe", "proposer cannot activate");
    await expectRevert(simulate(mirror, "W", "work", "activateTask", [taskId4]), "OnlySafe", "stranger cannot activate");
    await expectRevert(simulate(mirror, "F", "work", "cancelTask", [t2.taskId]), "OnlySafe", "founder cannot cancel");
    invariant("W-6", true, "activateTask and cancelTask revert OnlySafe for proposer, stranger and founder; the Safe acts only through Baal.processProposal");

    console.log(`\n   treasury at start ${fmtS(seeded.safeSettlement)} USDC, at end ${fmtS((await snapshot(mirror, "end", [])).safeSettlement)} USDC`);
  } finally {
    finish("work-invariants");
    await shutdown(mirror);
  }
}

/**
 * Lower-cased address of actor D.
 *
 * Args:
 *   mirror: The booted mirror.
 *
 * Returns:
 *   D's address in lower case.
 */
function D_lower(mirror: Mirror): string {
  return mirror.actors.D.account.address.toLowerCase();
}

runIfMain(import.meta.url, main);
