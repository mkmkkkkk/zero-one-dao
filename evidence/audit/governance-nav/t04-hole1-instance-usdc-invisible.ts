/**
 * NAV-01 — deposit NAV ignores settlement held by a running Strategy instance ("hole 1").
 *
 * Invariant that should hold (DESIGN.md §6): shares = amount x totalShares / treasury, where the
 * treasury is what the members own; nobody can buy shares below NAV and exit above it.
 *
 * Why it fails on this branch: NavShareToken.treasuryValue() = USDC.balanceOf(Safe). A passed
 * Strategy moves its budget out of the Safe; the instance still belongs to the DAO, but deposits
 * price it at zero. Phase 4 (TreasuryLedger, branch phase4-ledger-twap, not present in this
 * checkout) is the intended fix: depositTreasury = Safe USDC + Σ USDC of open instances.
 *
 * Steps: seed (3050 USDC, 3050 shares) → Strategy budget 3000 USDC passes (Safe keeps 50) →
 * D deposits 50 USDC and receives 3050 shares (50% of supply) → the deadline passes, anyone calls
 * run(): the instance returns 3000 USDC → D ragequits 3050 shares (50% of 3100 USDC) for 1550 USDC. Profit 1500 on 50.
 */
import type { StrategyParams } from "../../../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, deposit, fmt, fmtS, now, processProposal, proposeTemplate, ragequit, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, shutdown, step, T, usdcOf, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, pct2, revertChain, safeUsdc, snapshotChain, totalShares } from "./audit-lib.js";

const LOG = "t04-hole1-instance-usdc-invisible";

/**
 * Run NAV-01 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t04");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);

    step("A proposes a Strategy with budget 3000 USDC (98% of the treasury); A, B, C YES; executed");
    const start = await now(mirror);
    const params: StrategyParams = { venue: market.dex, asset: market.asset, budget: 3_000n * SETTLEMENT_UNIT, rule: { maxPerRun: 1n, minInterval: BigInt(T.hour), deadline: start + BigInt(2 * DAY), takeProfitBps: 0n, stopLossBps: 0n } };
    const proposal = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "A: strategy 3000 USDC");
    for (const actor of ["A", "B", "C"] as const) await vote(mirror, actor, proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "W", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "strategy funded and started");
    const instance = proposal.instance.address;
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC; instance ${fmtS(await usdcOf(mirror, instance))} USDC; supply ${fmt(await totalShares(mirror))} shares (true NAV 1 USDC/share, deposit NAV ${fmtS((await safeUsdc(mirror)) * 10n ** 18n / (await totalShares(mirror)))} USDC/share)`);

    step("side finding NAV-05 (snapshot): A ragequits its 1000 shares while the budget is out -> paid pro-rata of the Safe only");
    const snap = await snapshotChain(mirror);
    const aExit = await ragequit(mirror, "A");
    logLine(LOG, `   A burned ${fmt(aExit.burned)} shares (32.8% of supply, true value ${fmtS((aExit.burned * (3_050n * SETTLEMENT_UNIT)) / seeded.totalShares)} USDC) and was paid ${fmtS(aExit.paid)} USDC: ${fmtS((aExit.burned * (3_050n * SETTLEMENT_UNIT)) / seeded.totalShares - aExit.paid)} USDC forfeited to the stayers (exit is pro-rata of the Safe, not of the DAO)`);
    await revertChain(mirror, snap);

    step("D deposits 50 USDC while the budget is out");
    const dStart = await usdcOf(mirror, mirror.actors.D.account.address);
    const dep = await deposit(mirror, "D", 50n * SETTLEMENT_UNIT);
    logLine(LOG, `   D paid 50 USDC for ${fmt(dep.sharesMinted)} shares = ${pct2(dep.sharesMinted, await totalShares(mirror))} of supply (fair: ${fmt((50n * SETTLEMENT_UNIT * seeded.totalShares) / seeded.safeSettlement)} shares)`);
    assert(dep.sharesMinted === 3_050n * 10n ** 18n, "D received 3050 shares for 50 USDC");

    step("the deadline passes; anyone calls run(): the instance returns its 3000 USDC to the Safe");
    await warp(mirror, 2 * DAY + 1, "past the strategy deadline");
    await sendAt(mirror, "W", instance, "strategy", "run", [], "W run() at deadline");
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC; instance ${fmtS(await usdcOf(mirror, instance))} USDC`);

    step("D ragequits all shares");
    const exit = await ragequit(mirror, "D");
    const dEnd = await usdcOf(mirror, mirror.actors.D.account.address);
    logLine(LOG, `   D USDC ${fmtS(dStart)} -> ${fmtS(dEnd)}: profit ${fmtS(dEnd - dStart)} USDC on a 50 USDC deposit; F/A/B/C lost ${fmtS(exit.paid - 50n * SETTLEMENT_UNIT)} USDC of their 3050`);
    assert(exit.paid === 1_550n * SETTLEMENT_UNIT, "D was paid 1550 USDC (half of the 3100 USDC Safe)");
    passed = true;
  } finally {
    verdict("NAV-01 hole 1: instance USDC invisible to deposit NAV (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
