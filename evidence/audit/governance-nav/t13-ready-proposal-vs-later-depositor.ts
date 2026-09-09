/**
 * NAV-06 — a passed, unprocessed proposal (expiration 0: never expires) is executed against
 * deposits made after the vote; the depositor had no vote and its share of the payment is lost.
 *
 * Invariant that should hold (DESIGN.md §0/§3): a member is exposed only to proposals it could
 * vote on or exit from.
 *
 * Steps: seed (Safe 3050) → A proposes 'pay A 2000 USDC'; A YES; grace over: Ready (nobody
 * processes it; the relay's /me lists it as open with canExecute) → D deposits 5000 USDC at NAV
 * (5000 shares) → A processes → D's 5000 shares are now worth 3757.76 USDC: D lost 1242.24 USDC
 * (24.8%) to a decision taken before it joined.
 */
import { assert, boot, deposit, fmt, fmtS, processProposal, propose, ragequit, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, stateOf, step, transferCall, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, pct2, safeUsdc, totalShares } from "./audit-lib.js";

const LOG = "t13-ready-proposal-vs-later-depositor";

/**
 * Run NAV-06 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t13");
  let passed = false;
  try {
    await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    step("A proposes 'pay A 2000 USDC', votes YES; grace passes; the proposal is left Ready (expiration 0)");
    const proposal = await propose(mirror, "A", [transferCall(mirror, A, 2_000n * SETTLEMENT_UNIT)], "A: pay A 2000 USDC");
    await vote(mirror, "A", proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    assert((await stateOf(mirror, proposal.id)) === "Ready", "Ready, unprocessed");
    step("D deposits 5000 USDC at the current NAV (1 USDC/share)");
    const dStart = await usdcOf(mirror, mirror.actors.D.account.address);
    const dep = await deposit(mirror, "D", 5_000n * SETTLEMENT_UNIT);
    logLine(LOG, `   D holds ${fmt(dep.sharesMinted)} shares = ${pct2(dep.sharesMinted, await totalShares(mirror))}; Safe ${fmtS(await safeUsdc(mirror))} USDC; D could not vote on #${proposal.id} (votingStarts before D's checkpoint)`);
    step("A processes the old proposal");
    const processed = await processProposal(mirror, "A", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "paid");
    const value = (dep.sharesMinted * (await safeUsdc(mirror))) / (await totalShares(mirror));
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC; D's ${fmt(dep.sharesMinted)} shares now worth ${fmtS(value)} USDC: D lost ${fmtS(5_000n * SETTLEMENT_UNIT - value)} USDC (${pct2(5_000n * SETTLEMENT_UNIT - value, 5_000n * SETTLEMENT_UNIT)}) of the 2000 paid to A; A's own 1000 shares bore ${fmtS(((1_000n * 10n ** 18n) * 2_000n * SETTLEMENT_UNIT) / (await totalShares(mirror)))} USDC`);
    const exit = await ragequit(mirror, "D");
    logLine(LOG, `   D USDC ${fmtS(dStart)} -> ${fmtS(await usdcOf(mirror, mirror.actors.D.account.address))} after exit (paid ${fmtS(exit.paid)})`);
    assert(exit.paid < 3_800n * SETTLEMENT_UNIT, "D recovered less than 76% of its deposit");
    passed = true;
  } finally {
    verdict("NAV-06 Ready proposal executes against a later depositor (finding demonstrated; mitigation informational only)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
