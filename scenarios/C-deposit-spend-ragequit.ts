/**
 * DESIGN.md §11 C (the user-visible path): depositor D deposits at NAV, the DAO votes to spend part
 * of the treasury, D ragequits and receives its pro-rata of what remains.
 */
import { assert, boot, deposit, fmt, processProposal, propose, ragequit, runIfMain, seedMembers, shutdown, snapshot, step, transferCall, UNIT, verdict, vote, warpPastGrace } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-C");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);

    step("D deposits 1000 settlement at current NAV");
    const start = await snapshot(mirror, "before deposit", ["D"]);
    const amount = 1_000n * UNIT;
    const expectedShares = (amount * seeded.totalShares) / seeded.safeSettlement;
    const dep = await deposit(mirror, "D", amount);
    assert(dep.sharesMinted === expectedShares, `D received amount * totalShares / treasury = ${fmt(expectedShares)} shares (NAV per share unchanged)`);
    assert(dep.sharesMinted === dep.quoted, "minted shares equal the quote");
    const afterDeposit = await snapshot(mirror, "after deposit", ["D"]);
    assert(afterDeposit.safeSettlement === seeded.safeSettlement + amount, "treasury grew by exactly the deposit");

    step("DAO votes to spend 20% of the treasury (pay operator O); D votes NO and is outvoted");
    const spend = afterDeposit.safeSettlement / 5n;
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, spend)], `A: pay O ${fmt(spend)} for services`);
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    await vote(mirror, "D", proposal.id, false);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "B", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "spend executed");
    const afterSpend = await snapshot(mirror, "after spend", ["D", "O"]);
    assert(afterSpend.safeSettlement === afterDeposit.safeSettlement - spend, "treasury decreased by the spend");

    step("D ragequits all shares and receives its pro-rata of the remainder");
    const exit = await ragequit(mirror, "D");
    assert(exit.paid === exit.expected, `D paid exactly sharesD * remaining treasury / totalShares = ${fmt(exit.expected)}`);
    const fairShare = (dep.sharesMinted * afterSpend.safeSettlement) / afterSpend.totalShares;
    assert(exit.paid === fairShare, "payout is D's share of what remains after the DAO spent");
    assert(exit.paid < amount && exit.paid > (amount * 3n) / 4n, `D bore its pro-rata (20%) of the spend: got back ${fmt(exit.paid)} of ${fmt(amount)}`);
    const after = await snapshot(mirror, "after exit", ["D"]);
    assert(after.shares.D === 0n, "D holds no shares");
    assert(after.settlement.D === start.settlement.D - amount + exit.paid, "D's settlement balance = start - deposit + payout");
    passed = true;
  } finally {
    verdict("C", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
