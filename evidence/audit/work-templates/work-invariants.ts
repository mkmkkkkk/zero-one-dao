/**
 * Audit rows W-1 .. W-4, W-6 (WorkManager, security-audit component 3) on the anvil mirror — phase 5,
 * FLIPPED (decision.md phase 5 rulings 4c and 10).
 *
 * W-1 deferred mint: the reward of an Active task is a share liability DepositShaman prices into every
 *     deposit (shares = amount x (supply + Σ active rewardShares) / depositTreasury); confirm() reverts
 *     after the task's expiration and anyone may expireTask(), so the liability is bounded in time.
 * W-2 claim blocking: a claim that delivers nothing for CLAIM_TIMEOUT (7 d) lapses; the next claim takes
 *     the task over without a vote.
 * W-3 proposer as worker: accepted by principle (docs/SECURITY_AUDIT.md: the vote is the check; a
 *     verifier that is a second key of the proposer is indistinguishable in code). Shown, not asserted.
 * W-4 expiration edge: a task whose activation proposal expires before processing stays Proposed and can
 *     never be activated, claimed or minted (harmless: a dead id). Shown and asserted as such.
 * W-6 onlySafe: activateTask / cancelTask revert for anyone but the Safe.
 *
 * Run: `npx tsx evidence/audit/work-templates/work-invariants.ts` (exit code 1 = an invariant is violated).
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

const STATUS = ["None", "Proposed", "Active", "Complete", "Cancelled", "Expired"] as const;

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
  expiration: number;
  claimedAt: bigint;
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
    step("W-1: A proposes task #1 with reward 9150 shares (3x the 3050 supply), expiring in 60 days; A and B vote YES; activated after grace, nothing minted");
    const reward1 = 9_150n * UNIT;
    const expiration1 = Number(await now(mirror)) + 60 * DAY;
    const t1 = await activateTask(mirror, "A", [B, C], 2, reward1, expiration1, "task: 9150 shares to whoever delivers (verifiers B, C)", ["A", "B"]);
    assert(t1.processed.info.status.passed && !t1.processed.info.status.actionFailed, "activation executed by the Safe");
    const atVote = await snapshot(mirror, "at activation", ["A", "B", "C", "F"]);
    const rewardValueAtVote = (reward1 * atVote.safeSettlement) / (atVote.totalShares + reward1);
    console.log(`   reward value if minted now: ${fmt(reward1)} / ${fmt(atVote.totalShares + reward1)} of ${fmtS(atVote.safeSettlement)} USDC = ${fmtS(rewardValueAtVote)} USDC`);
    assert((await taskOf(mirror, t1.taskId)).status === 2, "task #1 Active; reward not yet minted");
    const liability = await read<bigint>(mirror, "work", "activeRewardShares");
    const shamanLiability = await read<bigint>(mirror, "deposit", "shareLiability");
    console.log(`   WorkManager.activeRewardShares = ${fmt(liability)}; DepositShaman.shareLiability = ${fmt(shamanLiability)}`);
    invariant("W-1", liability === reward1 && shamanLiability === reward1, `the approved-but-unminted reward is a visible liability (${fmt(liability)} shares)`);

    step("W-1: 30 days pass; the task is still Active; D, who never saw the vote, deposits 10,000 USDC at NAV including the liability");
    await warp(mirror, 30 * DAY, "30 days after activation");
    const quoted = await read<bigint>(mirror, "deposit", "quote", [10_000n * SETTLEMENT_UNIT]);
    const fairShares = (10_000n * SETTLEMENT_UNIT * (atVote.totalShares + reward1)) / atVote.safeSettlement;
    console.log(`   deposit quote for 10,000 USDC = ${fmt(quoted)} shares; liability-adjusted fair quote = ${fmt(fairShares)} shares`);
    invariant("W-1", quoted === fairShares, `the deposit quote prices in approved-but-unminted task rewards (quoted ${fmt(quoted)} shares, liability-adjusted ${fmt(fairShares)} shares)`);
    const dDeposit = await deposit(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    assert(dDeposit.sharesMinted === fairShares, "D was minted the liability-adjusted amount");
    const afterDeposit = await snapshot(mirror, "after D's deposit", ["D"]);
    const dExitBefore = (afterDeposit.shares.D! * afterDeposit.safeSettlement) / afterDeposit.totalShares;
    console.log(`   D exit value now = ${fmtS(dExitBefore)} USDC (${pct(afterDeposit.shares.D!, afterDeposit.totalShares)} of ${fmtS(afterDeposit.safeSettlement)}; the liability is not yet minted so D's pro-rata is temporarily above 10,000)`);

    step("W-1: W claims, delivers; B and C confirm -> 9150 shares mint to W; W ragequits the same block");
    await send(mirror, "W", "work", "claim", [t1.taskId], "W claims task #1");
    await send(mirror, "W", "work", "deliver", [t1.taskId, keccak256(evidence)], "W delivers");
    await send(mirror, "B", "work", "confirm", [t1.taskId, evidence], "B confirms (1/2)");
    await send(mirror, "C", "work", "confirm", [t1.taskId, evidence], "C confirms (2/2) -> mint");
    const afterMint = await snapshot(mirror, "after mint", ["W", "D"]);
    assert(afterMint.shares.W === reward1, "W holds exactly the voted 9150 shares");
    invariant("W-1", (await read<bigint>(mirror, "work", "activeRewardShares")) === 0n, "the liability is gone once the reward is minted");
    const wExit = await ragequit(mirror, "W");
    const afterExit = await snapshot(mirror, "after W's exit", ["W", "D"]);
    const dExitAfter = (afterExit.shares.D! * afterExit.safeSettlement) / afterExit.totalShares;
    console.log(`   W was paid ${fmtS(wExit.paid)} USDC for a reward worth ${fmtS(rewardValueAtVote)} USDC when it was voted`);
    console.log(`   D deposited ${fmtS(10_000n * SETTLEMENT_UNIT)} USDC and can now exit for ${fmtS(dExitAfter)} USDC`);
    invariant("W-1", dExitAfter + 1n >= 10_000n * SETTLEMENT_UNIT, `a depositor who joins after a task's vote and grace is not diluted by that task's later mint (D: 10,000 USDC in, exit value ${fmtS(dExitAfter)} USDC after the mint)`);
    invariant("W-1", wExit.paid <= rewardValueAtVote, `a task reward pays at most its value at the vote (voted worth ${fmtS(rewardValueAtVote)} USDC, paid ${fmtS(wExit.paid)} USDC)`);

    step("W-1: an Active task cannot mint after its expiration: task #1b (reward 100, expires 2 days after grace) is activated, delivered, then expires before the second confirmation");
    const expiration1b = Number(await now(mirror)) + Number(await read<number>(mirror, "baal", "votingPeriod")) + Number(await read<number>(mirror, "baal", "gracePeriod")) + 2 * DAY;
    const t1b = await activateTask(mirror, "A", [B, C], 2, 100n * UNIT, expiration1b, "task: 100 shares, expires 2 d after grace (verifiers B, C)", ["A", "B"]);
    assert(t1b.processed.info.status.passed, "task #1b activated");
    invariant("W-1", (await read<bigint>(mirror, "work", "activeRewardShares")) === 100n * UNIT, "the new task's 100 shares are the liability");
    await send(mirror, "W", "work", "claim", [t1b.taskId], "W claims task #1b");
    await send(mirror, "W", "work", "deliver", [t1b.taskId, keccak256(evidence)], "W delivers #1b");
    await send(mirror, "B", "work", "confirm", [t1b.taskId, evidence], "B confirms #1b (1/2)");
    await warp(mirror, 3 * DAY, "past the task's expiration");
    invariant("W-1", (await read<bigint>(mirror, "work", "activeRewardShares")) === 0n, "an expired task leaves the liability before anyone touches it");
    await expectRevert(simulate(mirror, "C", "work", "confirm", [t1b.taskId, evidence]), "TaskExpired", "the final confirmation reverts after the expiration: nothing can mint");
    await send(mirror, "D", "work", "expireTask", [t1b.taskId], "anyone closes the expired task");
    const expired = await taskOf(mirror, t1b.taskId);
    invariant("W-1", expired.status === 5, `an Active task cannot mint after a bounded time (task #1b ${STATUS[expired.status]} after its expiration)`);
    await expectRevert(simulate(mirror, "W", "work", "claim", [t1b.taskId]), "WrongStatus", "an expired task cannot be claimed");

    // ---------------------------------------------------------------- W-2 claim blocking
    step("W-2: task #2 (reward 10 shares, verifiers B, C) is activated; stranger D claims it in the first block and never delivers; after CLAIM_TIMEOUT the intended worker W takes it over");
    const t2 = await activateTask(mirror, "A", [B, C], 2, 10n * UNIT, 0, "task: 10 shares (verifiers B, C)", ["A", "B"]);
    assert(t2.processed.info.status.passed, "task #2 activated");
    const claim = await send(mirror, "D", "work", "claim", [t2.taskId], "D (stranger, no shares needed) claims task #2");
    console.log(`   cost to D: ${claim.gasUsed} gas; D never delivers`);
    await expectRevert(simulate(mirror, "W", "work", "claim", [t2.taskId]), "TaskAlreadyClaimed", "W cannot claim task #2 while D's claim is fresh");
    await expectRevert(simulate(mirror, "A", "work", "cancelTask", [t2.taskId]), "OnlySafe", "the proposer cannot cancel; only a passed proposal can");
    const workAbi = mirror.abi.work.filter((item) => item.type === "function").map((item) => (item as { name: string }).name);
    const reassign = workAbi.filter((name) => /unclaim|reassign|release|abandon|timeout|expire|lapse/iu.test(name));
    console.log(`   WorkManager functions: ${workAbi.join(", ")}`);
    invariant("W-2", reassign.length !== 0, `a claimed task that is never delivered can be reassigned without a passed proposal (functions matching timeout/lapse/expire: ${reassign.join(", ")})`);
    const timeout = await read<bigint>(mirror, "work", "CLAIM_TIMEOUT");
    await warp(mirror, Number(timeout) + 1, "past CLAIM_TIMEOUT");
    invariant("W-2", await read<boolean>(mirror, "work", "claimLapsed", [t2.taskId]), `a claim that never delivers lapses after CLAIM_TIMEOUT (${timeout} s)`);
    await send(mirror, "W", "work", "claim", [t2.taskId], "W claims task #2 after D's claim lapsed");
    const taken = await taskOf(mirror, t2.taskId);
    invariant("W-2", taken.worker.toLowerCase() === W.toLowerCase(), `W is the worker of task #2 now (was ${D_lower(mirror)})`);
    await send(mirror, "W", "work", "deliver", [t2.taskId, keccak256(evidence)], "W delivers #2");
    await warp(mirror, Number(timeout) + 1, "another CLAIM_TIMEOUT");
    await expectRevert(simulate(mirror, "D", "work", "claim", [t2.taskId]), "TaskAlreadyClaimed", "a claim that delivered does not lapse");

    // ---------------------------------------------------------------- W-3 proposer as worker (accepted by principle)
    step("W-3 (accepted by principle): A proposes task #3 naming O (a fresh key) as the single verifier; A alone votes YES; A claims and delivers its own task; O confirms");
    const t3 = await activateTask(mirror, "A", [O], 1, 100n * UNIT, 0, "task: 100 shares, verifier O", ["A"]);
    assert(t3.processed.info.status.passed, "task #3 activated with A's 1000 YES against 0 NO (B, C, F silent)");
    const aSharesBefore = await read<bigint>(mirror, "shares", "balanceOf", [A]);
    await send(mirror, "A", "work", "claim", [t3.taskId], "A (proposer) claims its own task");
    await send(mirror, "A", "work", "deliver", [t3.taskId, keccak256(evidence)], "A delivers to itself");
    await send(mirror, "O", "work", "confirm", [t3.taskId, evidence], "O confirms (1/1) -> mint to A");
    const aSharesAfter = await read<bigint>(mirror, "shares", "balanceOf", [A]);
    console.log(`   A: ${fmt(aSharesBefore)} -> ${fmt(aSharesAfter)} shares; the only check was the vote (B, C, F did not vote): accepted by principle, the members' NO or exit is the remedy`);
    invariant("W-3", aSharesAfter === aSharesBefore + 100n * UNIT, "the voted reward minted exactly (documented behaviour, docs/SECURITY_AUDIT.md W-3 accepted-by-principle)");

    // ---------------------------------------------------------------- W-4 expiration edges
    step("W-4: expiration inside voting + grace is refused; a passed activation processed after its expiration does nothing and the task stays Proposed, never mintable");
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
    await expectRevert(simulate(mirror, "W", "work", "claim", [taskId4]), "WrongStatus", "a Proposed task cannot be claimed");
    const activeIds = (await read<readonly bigint[]>(mirror, "work", "activeTasks")).map((id) => id.toString());
    invariant("W-4", task4.status === 1 && !activeIds.includes(taskId4.toString()), `a task whose activation proposal expired is a dead id: never Active (active ids: ${activeIds.join(", ") || "none"}), no liability, nothing mintable (documented)`);

    // ---------------------------------------------------------------- W-6 activation only by Safe
    step("W-6: activateTask / cancelTask are onlySafe");
    await expectRevert(simulate(mirror, "A", "work", "activateTask", [taskId4]), "OnlySafe", "proposer cannot activate");
    await expectRevert(simulate(mirror, "W", "work", "activateTask", [taskId4]), "OnlySafe", "stranger cannot activate");
    await expectRevert(simulate(mirror, "F", "work", "cancelTask", [t2.taskId]), "OnlySafe", "founder cannot cancel");
    invariant("W-6", true, "activateTask and cancelTask revert OnlySafe for proposer, stranger and founder; the Safe acts only through Baal.processProposal");

    console.log(`\n   treasury at start ${fmtS(seeded.safeSettlement)} USDC, at end ${fmtS((await snapshot(mirror, "end", [])).safeSettlement)} USDC`);
    assert(A.length > 0 && W.length > 0, "addresses present");
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
