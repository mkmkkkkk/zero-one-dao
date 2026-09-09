/**
 * Audit rows T-4, T-5, T-6 (StrategyProposal.run() and the venue price reference, security-audit
 * component 4) on the anvil mirror with MockDex (anyone may set the price: the mirror's stand-in for a
 * same-block pool move on a real venue).
 *
 * T-4 entry sandwich: run() buys at whatever price the venue prints in that block; `slippageBps` is
 *     measured against the same-transaction quote, so a price moved before the run is fully paid.
 * T-5 forced exit: a one-block price print below budget x (1 - stopLoss) makes the permissionless
 *     run() sell the whole position at the printed price; the real price is unchanged before and after.
 * T-6 donation trigger: any address can send the asset to a Strategy and make its take-profit fire on
 *     the next run(), ending it before it traded (cost = the donation, which lands in the Safe).
 *
 * Run: `npx tsx evidence/audit/work-templates/strategy-price-reference.ts`.
 */
import type { Address } from "viem";

import {
  assert,
  boot,
  DAY,
  deployMockMarket,
  describeAt,
  fmtS,
  type Mirror,
  now,
  pct,
  processProposal,
  proposeTemplate,
  readAt,
  runIfMain,
  seedMembers,
  sendAt,
  SETTLEMENT_UNIT,
  shutdown,
  step,
  T,
  usdcOf,
  vote,
  warp,
  warpPastGrace,
} from "../../../scenarios/lib.js";
import type { StrategyParams } from "../../../src/proposals.js";
import { finish, invariant } from "./_harness.js";

/**
 * Propose, pass and start a Strategy instance (A proposes, A and B vote YES, D executes).
 *
 * Args:
 *   mirror: The booted mirror.
 *   params: Strategy parameters.
 *   label: Proposal summary.
 *
 * Returns:
 *   The Running instance address.
 */
async function startStrategy(mirror: Mirror, params: StrategyParams, label: string): Promise<Address> {
  const proposal = await proposeTemplate(mirror, "A", { template: "Strategy", params }, label);
  await vote(mirror, "A", proposal.id, true);
  await vote(mirror, "B", proposal.id, true);
  await warpPastGrace(mirror, proposal.id);
  const processed = await processProposal(mirror, "D", proposal);
  assert(processed.info.status.passed && !processed.info.status.actionFailed, `${label}: funded and started by the Safe`);
  return proposal.instance.address;
}

/**
 * Run the Strategy price-reference audit demonstrations.
 *
 * Returns:
 *   Nothing; prints receipts, numbers and the verdict block.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-strategy");
  try {
    const seeded = await seedMembers(mirror);
    const market = await deployMockMarket(mirror, 1n * SETTLEMENT_UNIT, 1_000_000n * SETTLEMENT_UNIT);
    const mockOf = (address: Address) => readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [address]);
    const priceNow = () => readAt<bigint>(mirror, market.dex, "dex", "price");
    const valueOf = (s: Address) => readAt<bigint>(mirror, s, "strategy", "value");
    const start = await now(mirror);
    const rule = { maxPerRun: 1_000n * SETTLEMENT_UNIT, minInterval: BigInt(T.hour), deadline: start + BigInt(7 * DAY), takeProfitBps: 0n, stopLossBps: 3_000n, slippageBps: 50n };
    const budget = 1_000n * SETTLEMENT_UNIT;

    // ---------------------------------------------------------------- T-4 entry sandwich
    step("T-4: S1 (budget 1000 USDC, 1000 per run, stop-loss 30%, slippage 50 bps) is voted and started at price 1.00");
    const s1 = await startStrategy(mirror, { venue: market.dex, asset: market.asset, budget, rule }, "A: S1 DCA 1000 USDC into MOCK");
    assert((await usdcOf(mirror, s1)) === budget, "S1 holds 1000 USDC");
    step("T-4: attacker W moves the venue price to 2.00 right before anyone runs; O calls run(); W moves it back to 1.00");
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [2n * SETTLEMENT_UNIT], "W setPrice 2.00 (front-run)");
    const fairOut = (budget * SETTLEMENT_UNIT) / (1n * SETTLEMENT_UNIT);
    const minAllowed = (fairOut * (10_000n - rule.slippageBps)) / 10_000n;
    await sendAt(mirror, "O", s1, "strategy", "run", [], "O run() #1 (buys 1000 USDC of MOCK)");
    const got = await mockOf(s1);
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [1n * SETTLEMENT_UNIT], "W setPrice 1.00 (back-run)");
    const v1 = await valueOf(s1);
    console.log(`   S1 received ${fmtS(got)} MOCK for 1000 USDC; at the pre-run price 1.00 it would have received ${fmtS(fairOut)} MOCK (slippageBps 50 allows >= ${fmtS(minAllowed)}); value at the restored price = ${fmtS(v1)} USDC`);
    invariant("T-4", got >= minAllowed, `run() executes within slippageBps of the pre-transaction price (got ${fmtS(got)} MOCK, minimum by the voted 50 bps ${fmtS(minAllowed)} MOCK: shortfall ${pct(fairOut - got, fairOut)} vs 0.50% allowed)`);
    step("T-4: one hour later anyone runs again: value 500 <= 700 = stop-loss -> S1 unwinds at 1.00 and returns 500 USDC to the Safe");
    await warp(mirror, T.hour, "minInterval");
    const safeBefore1 = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", s1, "strategy", "run", [], "W run() #2 -> stop-loss unwind");
    const safeAfter1 = await usdcOf(mirror, mirror.dao.safe);
    const d1 = await describeAt(mirror, s1, "S1 after unwind");
    console.log(`   Safe received ${fmtS(safeAfter1 - safeBefore1)} USDC of the 1000 it funded; treasury loss ${fmtS(budget - (safeAfter1 - safeBefore1))} USDC (${pct(budget - (safeAfter1 - safeBefore1), budget)}) with the real price at 1.00 before and after`);
    invariant("T-4", d1.status !== "Complete" || safeAfter1 - safeBefore1 >= (budget * 9_950n) / 10_000n, `a strategy that traded at an unmoved real price returns its budget minus at most slippage (returned ${fmtS(safeAfter1 - safeBefore1)} of ${fmtS(budget)} USDC)`);

    // ---------------------------------------------------------------- T-5 forced stop-loss
    step("T-5: S2 (same rule) is voted and started; it buys 1000 MOCK at the fair price 1.00");
    const s2 = await startStrategy(mirror, { venue: market.dex, asset: market.asset, budget, rule: { ...rule, deadline: (await now(mirror)) + BigInt(7 * DAY) } }, "A: S2 DCA 1000 USDC into MOCK");
    await sendAt(mirror, "O", s2, "strategy", "run", [], "O run() #1 at 1.00");
    assert((await mockOf(s2)) === 1_000n * SETTLEMENT_UNIT, "S2 holds 1000 MOCK (value 1000)");
    await warp(mirror, T.hour, "minInterval");
    step("T-5: W prints 0.69 for one block (value 690 <= 700), calls run() itself, then restores 1.00");
    const venueMockBefore = await mockOf(market.dex);
    const venueUsdcBefore = await usdcOf(mirror, market.dex);
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [690_000n], "W setPrice 0.69");
    const safeBefore2 = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", s2, "strategy", "run", [], "W run() -> stop-loss unwind at 0.69");
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [1n * SETTLEMENT_UNIT], "W setPrice 1.00");
    const safeAfter2 = await usdcOf(mirror, mirror.dao.safe);
    const d2 = await describeAt(mirror, s2, "S2 after forced unwind");
    const counterpartyGain = (await mockOf(market.dex)) - venueMockBefore;
    const counterpartyPaid = venueUsdcBefore - (await usdcOf(mirror, market.dex));
    console.log(`   Safe got back ${fmtS(safeAfter2 - safeBefore2)} USDC for 1000 MOCK worth 1000 USDC at the unchanged real price; the venue counterparty holds +${fmtS(counterpartyGain)} MOCK for ${fmtS(counterpartyPaid)} USDC (gain ${fmtS(counterpartyGain - counterpartyPaid)} USDC at 1.00); price before ${fmtS(1n * SETTLEMENT_UNIT)} after ${fmtS(await priceNow())}`);
    invariant("T-5", d2.status !== "Complete", `a one-block price print cannot trigger the stop-loss unwind of a position whose real price never moved (S2 Complete, treasury loss ${fmtS(1_000n * SETTLEMENT_UNIT - (safeAfter2 - safeBefore2))} USDC = ${pct(1_000n * SETTLEMENT_UNIT - (safeAfter2 - safeBefore2), 1_000n * SETTLEMENT_UNIT)})`);

    // ---------------------------------------------------------------- T-6 donation trigger
    step("T-6: S3 with take-profit +20% is started; before it trades, W sends 250 MOCK to it; the next run() fires take-profit and ends S3");
    const s3 = await startStrategy(mirror, { venue: market.dex, asset: market.asset, budget, rule: { ...rule, takeProfitBps: 2_000n, stopLossBps: 0n, deadline: (await now(mirror)) + BigInt(7 * DAY) } }, "A: S3 DCA 1000 USDC, take-profit +20%");
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [mirror.actors.W.account.address, 250n * SETTLEMENT_UNIT], "F gives W 250 MOCK");
    await sendAt(mirror, "W", market.asset, "settlement", "transfer", [s3, 250n * SETTLEMENT_UNIT], "W donates 250 MOCK to S3");
    console.log(`   S3 value = ${fmtS(await valueOf(s3))} USDC >= 1200 = budget x 1.20`);
    const safeBefore3 = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", s3, "strategy", "run", [], "W run() -> take-profit before any buy");
    const d3 = await describeAt(mirror, s3, "S3");
    const runs3 = await readAt<bigint>(mirror, s3, "strategy", "runs");
    console.log(`   S3 ${d3.status} after ${runs3} run(s); Safe +${fmtS((await usdcOf(mirror, mirror.dao.safe)) - safeBefore3)} USDC (the 1000 budget plus W's 250 donation); cost to W 250 USDC-equivalent, effect: the voted strategy never traded`);
    invariant("T-6", d3.status !== "Complete", "a strategy's exit rule cannot be fired by a third party's transfer (observed: donation of 25% of budget ends the strategy on the first run)");

    console.log(`\n   treasury at start ${fmtS(seeded.safeSettlement)} USDC, at end ${fmtS(await usdcOf(mirror, mirror.dao.safe))} USDC`);
  } finally {
    finish("strategy-price-reference");
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
