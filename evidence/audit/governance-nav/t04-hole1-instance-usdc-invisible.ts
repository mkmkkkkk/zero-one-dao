/**
 * NAV-01 (phase 4/5, FLIPPED) — deposit NAV counts the settlement held by a running Strategy ("hole 1"
 * closed by the TreasuryLedger).
 *
 * Invariant (DESIGN.md §6): shares = amount x totalShares / treasury, where the treasury is what the
 * members own; nobody can buy shares below NAV and exit above it.
 *
 * Fix: DepositShaman prices on TreasuryLedger.depositTreasury() = Safe USDC + Σ USDC of open
 * instances (decision.md phase 4 rulings; phase 5 ruling 4).
 *
 * Steps: seed (3050 USDC, 3050 shares) → Strategy budget 3000 USDC passes (Safe keeps 50, instance
 * holds 3000, deposit NAV stays 1 USDC/share) → D deposits 50 USDC and receives 50 shares → the deadline
 * passes, anyone calls run(): the instance returns 3000 USDC → D ragequits 50 shares of 3100 for exactly
 * 50 USDC. NAV-05 (exit pro-rata of the Safe only while capital is out) is shown unchanged: accepted.
 */
import { loadLocalAbi } from "../../../src/baal.js";
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
    const ledgerAbi = loadLocalAbi("TreasuryLedger");
    const depositTreasury = (await mirror.chain.publicClient.readContract({ address: mirror.dao.treasuryLedger, abi: ledgerAbi, functionName: "depositTreasury" })) as bigint;
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC; instance ${fmtS(await usdcOf(mirror, instance))} USDC; ledger depositTreasury ${fmtS(depositTreasury)} USDC; supply ${fmt(await totalShares(mirror))} shares (deposit NAV ${fmtS(depositTreasury * 10n ** 18n / (await totalShares(mirror)))} USDC/share)`);
    assert(depositTreasury === 3_050n * SETTLEMENT_UNIT, "the ledger counts the 3000 USDC held by the open instance");

    step("NAV-05, accepted (snapshot): A ragequits its 1000 shares while the budget is out -> paid pro-rata of the Safe only (exit price <= deposit price; documented)");
    const snap = await snapshotChain(mirror);
    const aExit = await ragequit(mirror, "A");
    logLine(LOG, `   A burned ${fmt(aExit.burned)} shares (32.8% of supply, true value ${fmtS((aExit.burned * (3_050n * SETTLEMENT_UNIT)) / seeded.totalShares)} USDC) and was paid ${fmtS(aExit.paid)} USDC: ${fmtS((aExit.burned * (3_050n * SETTLEMENT_UNIT)) / seeded.totalShares - aExit.paid)} USDC forfeited to the stayers (exit is pro-rata of the Safe, not of the DAO)`);
    await revertChain(mirror, snap);

    step("D deposits 50 USDC while the budget is out");
    const dStart = await usdcOf(mirror, mirror.actors.D.account.address);
    const dep = await deposit(mirror, "D", 50n * SETTLEMENT_UNIT);
    logLine(LOG, `   D paid 50 USDC for ${fmt(dep.sharesMinted)} shares = ${pct2(dep.sharesMinted, await totalShares(mirror))} of supply (fair: ${fmt((50n * SETTLEMENT_UNIT * seeded.totalShares) / seeded.safeSettlement)} shares)`);
    assert(dep.sharesMinted === 50n * 10n ** 18n, "D received exactly 50 shares for 50 USDC (NAV 1, the instance budget counted)");

    step("the deadline passes; anyone calls run(): the instance returns its 3000 USDC to the Safe");
    await warp(mirror, 2 * DAY + 1, "past the strategy deadline");
    await sendAt(mirror, "W", instance, "strategy", "run", [], "W run() at deadline");
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC; instance ${fmtS(await usdcOf(mirror, instance))} USDC`);

    step("D ragequits all shares");
    const exit = await ragequit(mirror, "D");
    const dEnd = await usdcOf(mirror, mirror.actors.D.account.address);
    logLine(LOG, `   D USDC ${fmtS(dStart)} -> ${fmtS(dEnd)}: net ${fmtS(dEnd - dStart)} USDC on a 50 USDC deposit; F/A/B/C keep their 3050`);
    assert(exit.paid === 50n * SETTLEMENT_UNIT && dEnd === dStart, "D was paid exactly its 50 USDC back (50 of 3100 shares x 3100 USDC): no round-trip profit");
    passed = true;
  } finally {
    verdict("NAV-01 hole 1 closed: instance USDC counted by the TreasuryLedger (phase 4/5; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
