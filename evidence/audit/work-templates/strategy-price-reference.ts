/**
 * Audit rows T-4, T-5, T-6 (StrategyProposal.run() and the venue price reference, security-audit
 * component 4) — phase 5 ruling 5: "the spot venue never ships; phase 4 TWAP venue with scenario K on
 * the fork is the fix".
 *
 * The oracle for T-4 and T-5 therefore moved onto the shipped venue. Part 1 boots an owned loopback
 * Anvil fork of Base, deploys UniswapV3Venue on the real WETH/USDC 0.05% pool and runs the three
 * in-transaction sandwiches from scenario K (`proveSandwiches`), then asserts the two invariants on the
 * numbers reported from inside the attacker's own transaction:
 *
 * T-4 entry sandwich: a same-block +25% spot print leaves `price()` (the 30-minute TWAP) unchanged, the
 *     permissionless run() reverts `TwapBoundExceeded` instead of paying the printed price, and after the
 *     attacker's back-run the same run fills within the voted `slippageBps` of the pre-attack TWAP.
 * T-5 forced exit: a same-block −25% print leaves `value()` unchanged, so the 25% stop-loss does not
 *     fire and the strategy stays Running; and the deadline unwind during a −25% print reverts on the
 *     bound instead of dumping the position at the printed price, then sells within `slippageBps`.
 *
 * Part 2 is the mirror (MockDex, anyone may set the price) and is printed as the record of what a
 * spot-referenced venue does — the demonstration that produced the T-4 / T-5 rows. MockDex is
 * mirror-only (contracts/MockDex.sol, never deployed by scripts/deploy-network.ts; a mainnet Strategy
 * names a UniswapV3Venue), so its settable price is not an invariant of the shipped system and carries no
 * invariant here. T-6 is asserted there as the documented behaviour the audit row itself records (Low,
 * "cost exceeds any gain: griefing, not theft"): a donation that fires take-profit lands in the Safe, so
 * the treasury does not lose; the cost is that the voted strategy never traded.
 *
 * Run: `npx tsx evidence/audit/work-templates/strategy-price-reference.ts` (boots a Base fork; set
 * FORK_RPC to choose the upstream RPC, FORK_BLOCK to choose the pinned block).
 */
import type { Address } from "viem";

import {
  bootForkDao,
  deployTwapVenue,
  proveSandwiches,
  SANDWICH_SLIPPAGE_BPS,
  type SandwichProofs,
} from "../../../scenarios/K-uniswap-v3-fork.js";
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
import { stopDevnet } from "../../../src/devnet.js";
import type { StrategyParams } from "../../../src/proposals.js";
import { finish, invariant } from "./_harness.js";

/** WETH base units in one whole token (the venue's `assetUnit` on the WETH/USDC pool). */
const ASSET_UNIT = 10n ** 18n;

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
 * Part 1: run the three sandwiches against the shipped TWAP venue on an owned Base fork.
 *
 * Returns:
 *   The three proofs, so the invariants can be stated on the numbers the attacker's own transaction
 *   reported.
 */
async function proveOnTheForkedVenue(): Promise<SandwichProofs> {
  step("T-4 / T-5 (phase 5 ruling 5): UniswapV3Venue on the real Base WETH/USDC 0.05% pool, owned fork");
  const fork = await bootForkDao(`audit-strategy-price-${Date.now()}`);
  try {
    const venue = await deployTwapVenue(fork);
    return await proveSandwiches(fork, venue);
  } finally {
    await stopDevnet(fork.devnet);
  }
}

/**
 * State the T-4 and T-5 invariants on the fork proofs.
 *
 * Args:
 *   proofs: The entry, print and exit sandwiches.
 *
 * Returns:
 *   Nothing; each invariant is printed as `holds` or `VIOLATED` with its numbers.
 */
function stateForkInvariants(proofs: SandwichProofs): void {
  const { entry, print, exit } = proofs;
  const bound = (implied: bigint) => (implied * (10_000n - SANDWICH_SLIPPAGE_BPS)) / 10_000n;

  // T-4 entry: the run may not be filled further than slippageBps from the price before the attacker acted.
  const entrySwap = entry.swaps[0]!;
  const entryImplied = (entrySwap.amountIn * ASSET_UNIT) / entry.report.priceBefore;
  const entryBound = bound(entryImplied);
  console.log(`   T-4: TWAP before the attack ${fmtS(entry.report.priceBefore)} USDC per WETH, unchanged during a ${entry.spotMoveBps} bps spot print (${fmtS(entry.report.priceDuring)}); ${fmtS(entrySwap.amountIn)} USDC implies ${entryImplied} wei WETH, voted ${SANDWICH_SLIPPAGE_BPS} bps allows >= ${entryBound} wei`);
  invariant("T-4", entry.report.priceDuring === entry.report.priceBefore && entry.report.valueDuring === entry.report.valueBefore,
    `a same-block spot print of ${entry.spotMoveBps} bps moves neither price() nor value() (read inside the attacker's transaction: price ${entry.report.priceBefore} -> ${entry.report.priceDuring}, value ${entry.report.valueBefore} -> ${entry.report.valueDuring})`);
  invariant("T-4", entry.report.refusedOutput > 0n && entry.report.refusedOutput < entryBound,
    `run() during the print reverts TwapBoundExceeded instead of paying the printed price (would have received ${entry.report.refusedOutput} wei WETH, below the ${SANDWICH_SLIPPAGE_BPS} bps bound ${entry.report.refusedMinimum})`);
  invariant("T-4", entrySwap.amountOut >= entryBound,
    `run() executes within the voted slippageBps of the price that prevailed before the attacker acted (filled ${entrySwap.amountOut} wei WETH for ${fmtS(entrySwap.amountIn)} USDC, minimum by the voted ${SANDWICH_SLIPPAGE_BPS} bps ${entryBound} wei: shortfall ${pct(entryImplied - entrySwap.amountOut, entryImplied)} vs 0.50% allowed)`);
  invariant("T-4", entry.statusAfter === "Running" && entry.restoredMoveBps > -50n && entry.restoredMoveBps < 50n,
    `the sandwich ends with the pool restored (${entry.restoredMoveBps} bps off) and the strategy still Running, holding what it bought at the unmanipulated price`);

  // T-5 print: a one-block print may not force the stop-loss unwind.
  invariant("T-5", print.statusAfter !== "Complete" && print.report.valueDuring === print.report.valueBefore,
    `a one-block ${print.spotMoveBps} bps print cannot trigger the stop-loss unwind of a position whose TWAP never moved (value ${print.report.valueBefore} -> ${print.report.valueDuring}, stop-loss 25%, strategy ${print.statusAfter} after the attacker called run() itself)`);

  // T-5 exit: the deadline unwind may not be dumped at the printed price either.
  const exitSwap = exit.swaps[0]!;
  const exitImplied = (exitSwap.amountIn * exit.report.priceBefore) / ASSET_UNIT;
  const exitBound = bound(exitImplied);
  console.log(`   T-5: the deadline unwind sells ${exitSwap.amountIn} wei WETH; at the pre-attack TWAP that is ${fmtS(exitImplied)} USDC, voted ${SANDWICH_SLIPPAGE_BPS} bps allows >= ${fmtS(exitBound)} USDC`);
  invariant("T-5", exit.report.refusedOutput < exitBound,
    `the deadline unwind during a ${exit.spotMoveBps} bps print reverts on the bound instead of dumping the whole position at the printed price (would have received ${fmtS(exit.report.refusedOutput)} USDC, bound ${fmtS(exit.report.refusedMinimum)} USDC)`);
  invariant("T-5", exit.statusAfter === "Complete" && exitSwap.amountOut >= exitBound,
    `after the back-run the same unwind completes within the voted slippageBps of the unmanipulated price (sold for ${fmtS(exitSwap.amountOut)} USDC, minimum ${fmtS(exitBound)} USDC, shortfall ${pct(exitImplied - exitSwap.amountOut, exitImplied)})`);
}

/**
 * Part 2 on the mirror: the spot-reference record (MockDex, no invariants) and the T-6 donation trigger.
 *
 * Returns:
 *   Nothing; prints the receipts and numbers behind the T-4 / T-5 rows and asserts T-6.
 */
async function recordSpotReferenceAndProveT6(): Promise<void> {
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

    // ------------------------------------------- record: what a spot-referenced venue does (mirror only)
    step("record (no invariant): MockDex is mirror-only and prices at spot, so a print is fully paid — the demonstration behind the T-4 / T-5 rows; the shipped venue is the TWAP venue proven on the fork above");
    const s1 = await startStrategy(mirror, { venue: market.dex, asset: market.asset, budget, rule }, "A: S1 DCA 1000 USDC into MOCK");
    assert((await usdcOf(mirror, s1)) === budget, "S1 holds 1000 USDC");
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [2n * SETTLEMENT_UNIT], "W setPrice 2.00 (front-run)");
    const fairOut = (budget * SETTLEMENT_UNIT) / (1n * SETTLEMENT_UNIT);
    const minAllowed = (fairOut * (10_000n - rule.slippageBps)) / 10_000n;
    await sendAt(mirror, "O", s1, "strategy", "run", [], "O run() #1 (buys 1000 USDC of MOCK)");
    const got = await mockOf(s1);
    await sendAt(mirror, "W", market.dex, "dex", "setPrice", [1n * SETTLEMENT_UNIT], "W setPrice 1.00 (back-run)");
    console.log(`   MockDex record: S1 received ${fmtS(got)} MOCK for 1000 USDC; at the pre-run price 1.00 it would have received ${fmtS(fairOut)} MOCK (a 50 bps bound would allow >= ${fmtS(minAllowed)}); shortfall ${pct(fairOut - got, fairOut)}; value at the restored price = ${fmtS(await valueOf(s1))} USDC`);
    await warp(mirror, T.hour, "minInterval");
    const safeBefore1 = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", s1, "strategy", "run", [], "W run() #2 -> stop-loss unwind");
    const safeAfter1 = await usdcOf(mirror, mirror.dao.safe);
    const d1 = await describeAt(mirror, s1, "S1 after unwind");
    console.log(`   MockDex record: S1 ${d1.status}; Safe received ${fmtS(safeAfter1 - safeBefore1)} USDC of the 1000 it funded (${pct(budget - (safeAfter1 - safeBefore1), budget)} loss) with the mock price 1.00 before and after — MockDex (contracts/MockDex.sol) is never deployed outside the mirror, and a Strategy on Base names a UniswapV3Venue whose price() is the pool's 30-minute TWAP`);

    // ---------------------------------------------------------------- T-6 donation trigger (documented)
    step("T-6 (Low, documented): S3 with take-profit +20% is started; before it trades, W sends 250 MOCK to it; the next run() fires take-profit and ends S3 — the donation lands in the Safe");
    const s3 = await startStrategy(mirror, { venue: market.dex, asset: market.asset, budget, rule: { ...rule, takeProfitBps: 2_000n, stopLossBps: 0n, deadline: (await now(mirror)) + BigInt(7 * DAY) } }, "A: S3 DCA 1000 USDC, take-profit +20%");
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [mirror.actors.W.account.address, 250n * SETTLEMENT_UNIT], "F gives W 250 MOCK");
    await sendAt(mirror, "W", market.asset, "settlement", "transfer", [s3, 250n * SETTLEMENT_UNIT], "W donates 250 MOCK to S3");
    console.log(`   S3 value = ${fmtS(await valueOf(s3))} USDC >= 1200 = budget x 1.20; mock price ${fmtS(await priceNow())}`);
    const safeBefore3 = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", s3, "strategy", "run", [], "W run() -> take-profit before any buy");
    const d3 = await describeAt(mirror, s3, "S3");
    const runs3 = await readAt<bigint>(mirror, s3, "strategy", "runs");
    const safeGain3 = (await usdcOf(mirror, mirror.dao.safe)) - safeBefore3;
    console.log(`   S3 ${d3.status} after ${runs3} run(s); Safe +${fmtS(safeGain3)} USDC (the 1000 budget plus W's 250 donation); cost to W 250 USDC-equivalent, effect: the voted strategy never traded and a new 12 h proposal is needed to restart it`);
    invariant("T-6", safeGain3 >= budget + 250n * SETTLEMENT_UNIT,
      `a third party's donation that fires take-profit costs the donor and not the treasury: the Safe received ${fmtS(safeGain3)} USDC, the full ${fmtS(budget)} budget plus the ${fmtS(250n * SETTLEMENT_UNIT)} donation (documented behaviour, docs/SECURITY_AUDIT.md T-6: Low, "cost exceeds any gain: griefing, not theft"; the price of it is a new proposal, not money)`);

    console.log(`\n   mirror treasury at start ${fmtS(seeded.safeSettlement)} USDC, at end ${fmtS(await usdcOf(mirror, mirror.dao.safe))} USDC`);
  } finally {
    await shutdown(mirror);
  }
}

/**
 * Run the Strategy price-reference audit test.
 *
 * Returns:
 *   Nothing; prints receipts, numbers and the verdict block, and exits non-zero on any violation.
 */
export async function main(): Promise<void> {
  try {
    const proofs = await proveOnTheForkedVenue();
    stateForkInvariants(proofs);
    await recordSpotReferenceAndProveT6();
  } finally {
    finish("strategy-price-reference");
  }
}

runIfMain(import.meta.url, main);
