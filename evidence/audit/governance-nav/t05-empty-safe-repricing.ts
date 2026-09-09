/**
 * NAV-02 — the "1 USDC -> 1 share while the treasury is empty" rule re-prices every existing
 * share at 1 USDC once the Safe is drained, whatever supply exists.
 *
 * Invariant that should hold (DESIGN.md §6): deposits are made at NAV per share; a depositor gets
 * what it paid for.
 *
 * Why it fails: navSharesFor() switches to the genesis rule whenever treasuryValue() == 0, but
 * 3050 shares still exist after the DAO spent its last USDC (a Payment, or a Strategy holding it).
 * A depositor's USDC is then shared pro-rata with the old shares.
 *
 * Steps: seed → DAO votes to pay O the whole Safe (3050 USDC) → Safe = 0, supply 3050 → D deposits
 * 1000 USDC and gets 1000 shares = 24.7% of 4050 → D's exit value is 246.9 USDC: 753.1 USDC of D's
 * deposit went to F/A/B/C.
 */
import { assert, boot, deposit, fmt, fmtS, processProposal, propose, ragequit, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, transferCall, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, pct2, safeUsdc, totalShares } from "./audit-lib.js";

const LOG = "t05-empty-safe-repricing";

/**
 * Run NAV-02 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t05");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    step("A, B, C vote to pay O the whole Safe (3050 USDC): Safe = 0 with 3050 shares outstanding");
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, seeded.safeSettlement)], "A: pay O everything");
    for (const actor of ["A", "B", "C"] as const) await vote(mirror, actor, proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "W", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed && (await safeUsdc(mirror)) === 0n, "Safe is empty");
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC, supply ${fmt(await totalShares(mirror))} shares`);

    step("D deposits 1000 USDC");
    const dStart = await usdcOf(mirror, mirror.actors.D.account.address);
    const dep = await deposit(mirror, "D", 1_000n * SETTLEMENT_UNIT);
    const supply = await totalShares(mirror);
    const value = (dep.sharesMinted * (await safeUsdc(mirror))) / supply;
    logLine(LOG, `   D got ${fmt(dep.sharesMinted)} shares = ${pct2(dep.sharesMinted, supply)} of supply; D's exit value ${fmtS(value)} USDC of the 1000 deposited; ${fmtS(1_000n * SETTLEMENT_UNIT - value)} USDC accrued to the 3050 pre-existing shares`);
    const exit = await ragequit(mirror, "D");
    const dEnd = await usdcOf(mirror, mirror.actors.D.account.address);
    logLine(LOG, `   D USDC ${fmtS(dStart)} -> ${fmtS(dEnd)} after deposit + immediate exit: loss ${fmtS(dStart - dEnd)} USDC (${pct2(dStart - dEnd, 1_000n * SETTLEMENT_UNIT)})`);
    assert(exit.paid < 250n * SETTLEMENT_UNIT, "D recovered less than 25% of its deposit");
    passed = true;
  } finally {
    verdict("NAV-02 empty-Safe 1:1 rule re-prices existing shares (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
