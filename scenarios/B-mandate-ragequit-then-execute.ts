/**
 * DESIGN.md §11 B: A proposes a 10% mandate to operator O; B votes YES, C votes NO and ragequits
 * during grace -> C is paid pro-rata of the treasury before execution, then the mandate executes.
 */
import { assert, boot, fmt, processProposal, propose, proposalInfo, ragequit, read, runIfMain, seedMembers, shutdown, snapshot, stateOf, step, transferCall, verdict, vote, warpPastGrace, warpPastVoting } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-B");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const treasuryAtProposal = seeded.safeSettlement;
    const mandate = treasuryAtProposal / 10n;

    step(`A proposes: 10% mandate = transfer ${fmt(mandate)} settlement to operator O`);
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, mandate)], "A: 10% mandate to operator O (strategy S, rules R in text)");

    step("A YES, B YES, C NO");
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    await vote(mirror, "C", proposal.id, false);

    step("voting closes; C leaves during grace with its pro-rata share");
    await warpPastVoting(mirror, proposal.id);
    assert((await stateOf(mirror, proposal.id)) === "Grace", "proposal is in Grace");
    const before = await snapshot(mirror, "before C exits", ["C", "O"]);
    const exit = await ragequit(mirror, "C");
    assert(exit.paid === exit.expected, `C paid exactly sharesC * treasury / totalShares = ${fmt(exit.expected)}`);
    assert(exit.paid === (before.shares.C * before.safeSettlement) / before.totalShares, "C's payout used the pre-execution treasury (mandate not yet transferred)");
    const afterExit = await snapshot(mirror, "after C exits", ["C", "O"]);
    assert(afterExit.shares.C === 0n, "C holds no shares");
    assert(afterExit.safeSettlement === before.safeSettlement - exit.paid, "treasury decreased by exactly C's payout");
    const info = await proposalInfo(mirror, proposal.id);
    const retentionFloor = (await read<bigint>(mirror, "baal", "proposals", [proposal.id]) as unknown as readonly unknown[])[9] as bigint;
    console.log(`   minRetention check: totalShares ${fmt(afterExit.totalShares)} vs 66% of high-water ${fmt(retentionFloor)} = ${fmt((retentionFloor * 66n) / 100n)}; yes ${fmt(info.yesVotes)} > no ${fmt(info.noVotes)}`);
    assert(afterExit.totalShares * 100n >= retentionFloor * 66n, "C's exit (25%) stays within minRetention 66%, so the proposal survives");

    step("grace ends; anyone (here O) executes the exact multicall that was voted");
    await warpPastGrace(mirror, proposal.id);
    assert((await stateOf(mirror, proposal.id)) === "Ready", "proposal is Ready");
    const processed = await processProposal(mirror, "O", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "proposal passed and the action executed");
    const after = await snapshot(mirror, "after execution", ["A", "B", "C", "O"]);
    assert(after.settlement.O === before.settlement.O + mandate, `O received the mandate ${fmt(mandate)}`);
    assert(after.safeSettlement === treasuryAtProposal - exit.paid - mandate, "treasury = start - C's payout - mandate");
    assert(after.settlement.C === before.settlement.C + exit.paid, "C's balance is its pro-rata payout, paid before execution");
    passed = true;
  } finally {
    verdict("B", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
