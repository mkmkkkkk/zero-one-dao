/**
 * NAV-04 — a same-transaction deposit + ragequit never profits. With the whole treasury in the Safe it
 * nets zero (or -1 unit of rounding); with a Strategy budget out of the Safe it nets a loss, because
 * phase 5 prices the mint on Safe + open instances (ruling 4a) and leaves the burn pro-rata of the Safe
 * alone. Either way a borrowed-funds round trip cannot profit inside one transaction: the profit in
 * NAV-01 needed the instance to return money between the two legs, which takes a second block.
 *
 * Steps: seed → contract R deposits 2000 USDC and ragequits all in ONE transaction: net 0 →
 * Strategy budget 3000 passes (Safe 50) → R repeats with 50 USDC and with 2000 USDC: both net a loss.
 */
import type { StrategyParams } from "../../../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, fmt, fmtS, fund, now, processProposal, proposeTemplate, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, T, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { approveCall, depositCall, deployHelper, logLine, ragequitCall, runCalls, safeUsdc, sharesOf, totalShares } from "./audit-lib.js";

const LOG = "t11-same-tx-roundtrip";

/**
 * Run NAV-04 on a fresh mirror.
 *
 * Raises:
 *   Error: when a same-transaction round trip nets more than zero.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t11");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const helper = await deployHelper(mirror, "D");
    const R = helper.address;
    await fund(mirror, "D", 5_000n * SETTLEMENT_UNIT);
    await mirror.actors.D.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [R, 5_000n * SETTLEMENT_UNIT], account: mirror.actors.D.account, chain: mirror.actors.D.chain } as never);

    const roundTrip = async (amount: bigint, label: string): Promise<bigint> => {
      const before = await usdcOf(mirror, R);
      const supply = await totalShares(mirror);
      const safe = await safeUsdc(mirror);
      // Phase 5 (ruling 4a): the deposit price is amount x (shares + Active-task liability) / (Safe +
      // open-instance USDC), so the Safe balance alone no longer predicts the mint. Ask the shaman.
      const treasury = await read<bigint>(mirror, "deposit", "depositTreasury");
      const shares = await read<bigint>(mirror, "deposit", "quote", [amount]);
      await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, amount), depositCall(mirror, amount), ragequitCall(mirror, R, shares)], `${label}: R deposit ${fmtS(amount)} + ragequit ${fmt(shares)} shares`);
      const after = await usdcOf(mirror, R);
      logLine(LOG, `   ${label}: Safe ${fmtS(safe)} USDC, ledger treasury ${fmtS(treasury)}, supply ${fmt(supply)}; R USDC ${fmtS(before)} -> ${fmtS(after)} (net ${fmtS(after - before)}), R shares ${fmt(await sharesOf(mirror, R))}`);
      return after - before;
    };

    step("round trip 2000 USDC with the whole treasury in the Safe");
    const n1 = await roundTrip(2_000n * SETTLEMENT_UNIT, "full Safe");
    assert(n1 <= 0n && n1 >= -1n, "nets zero or -1 unit");

    step("Strategy budget 3000 USDC passes (Safe keeps 50)");
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);
    const params: StrategyParams = { venue: market.dex, asset: market.asset, budget: 3_000n * SETTLEMENT_UNIT, rule: { maxPerRun: 1n, minInterval: BigInt(T.hour), deadline: (await now(mirror)) + BigInt(2 * DAY), takeProfitBps: 0n, stopLossBps: 0n } };
    const proposal = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "A: strategy 3000");
    for (const actor of ["A", "B", "C"] as const) await vote(mirror, actor, proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "W", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "strategy funded");

    step("round trips while 3000 USDC sit in the open instance (deposit priced on 3050, exit on the Safe)");
    const n2 = await roundTrip(50n * SETTLEMENT_UNIT, "budget out, 50 USDC");
    const n3 = await roundTrip(2_000n * SETTLEMENT_UNIT, "budget out, 2000 USDC");
    // Phase 5: the mint leg is priced on Safe + open instances, the burn leg on the Safe alone, so a
    // round trip taken while capital is deployed is strictly lossy (the ECO-08 / NAV-05 asymmetry).
    assert(n2 < 0n && n3 < 0n, "same-transaction round trips lose money while a budget is out, and never profit");
    logLine(LOG, `   holds: the mint leg reads the ledger (Safe + open instances), the burn leg USDC.balanceOf(Safe): with 3000 of ${fmtS(seeded.safeSettlement)} deployed a 50 USDC round trip returns ${fmtS(50n * SETTLEMENT_UNIT + n2)} (net ${fmtS(n2)}) and a 2000 USDC one nets ${fmtS(n3)}; the NAV-01 profit needed the instance to return USDC between the legs (multi-block)`);
    passed = true;
  } finally {
    verdict("NAV-04 same-transaction deposit + exit never profits (holds)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
