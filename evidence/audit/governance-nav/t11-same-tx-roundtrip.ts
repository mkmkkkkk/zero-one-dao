/**
 * NAV-04 — same-transaction deposit + ragequit nets zero (or -1 unit of rounding), with and
 * without a Strategy budget out of the Safe. Holds: deposit and exit are priced on the same
 * quantity (Safe USDC), so a borrowed-funds round trip cannot profit inside one transaction; the
 * profit in NAV-01 needs the instance to return money between the two legs.
 *
 * Steps: seed → contract R deposits 2000 USDC and ragequits all in ONE transaction: net 0 →
 * Strategy budget 3000 passes (Safe 50) → R repeats with 50 USDC: net 0 (both legs at the same
 * distorted price) → R repeats with 2000 USDC: net 0.
 */
import type { StrategyParams } from "../../../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, fmt, fmtS, fund, now, processProposal, proposeTemplate, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, T, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
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
      const shares = safe === 0n ? amount * 10n ** 12n : (amount * supply) / safe;
      await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, amount), depositCall(mirror, amount), ragequitCall(mirror, R, shares)], `${label}: R deposit ${fmtS(amount)} + ragequit ${fmt(shares)} shares`);
      const after = await usdcOf(mirror, R);
      logLine(LOG, `   ${label}: Safe ${fmtS(safe)} USDC, supply ${fmt(supply)}; R USDC ${fmtS(before)} -> ${fmtS(after)} (net ${fmtS(after - before)}), R shares ${fmt(await sharesOf(mirror, R))}`);
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

    step("round trips while 3000 USDC sit in the instance (deposit NAV 0.0164 USDC/share)");
    const n2 = await roundTrip(50n * SETTLEMENT_UNIT, "budget out, 50 USDC");
    const n3 = await roundTrip(2_000n * SETTLEMENT_UNIT, "budget out, 2000 USDC");
    assert(n2 <= 0n && n2 >= -1n && n3 <= 0n && n3 >= -1n, "same-transaction round trips never profit, even at the distorted price");
    logLine(LOG, `   holds: both legs read USDC.balanceOf(Safe); the NAV-01 profit needs the instance to return USDC between deposit and exit (multi-block), seed ${fmtS(seeded.safeSettlement)}`);
    passed = true;
  } finally {
    verdict("NAV-04 same-transaction deposit + exit nets zero (holds)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
