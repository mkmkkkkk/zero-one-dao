/**
 * DESIGN.md §11 J: a running Strategy is migrated to a new contract by vote: the voted multicall is
 * [old.migrate(new), new.start()]; the old contract moves its raw holdings (every settlement unit and
 * every asset unit) to the new voted contract WITHOUT calling the venue (DESIGN.md §7; decision.md
 * phase 2a ruling 2) and holds nothing after; the new one runs by its own rules. The venue's price
 * is moved and the MockDex is drained before the migration to show that neither is consulted.
 * The proposer alone cannot migrate.
 */
import { deployTemplate, migrateCalls, proposalDetails, type StrategyParams } from "../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, describeAt, expectRevert, fmtS, HOUR, now, processProposal, propose, proposeTemplate, readAt, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, setPrice, shutdown, simulateAt, stateOf, step, usdcOf, verdict, vote, warp, warpPastGrace } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-J");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);
    const mockOf = (address: `0x${string}`) => readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [address]);
    const start = await now(mirror);
    const params: StrategyParams = {
      venue: market.dex,
      asset: market.asset,
      budget: 1_000n * SETTLEMENT_UNIT,
      rule: { maxPerRun: 300n * SETTLEMENT_UNIT, minInterval: BigInt(HOUR), deadline: start + BigInt(7 * DAY), takeProfitBps: 5000n, stopLossBps: 5000n },
    };

    step("strategy S1 (budget 1000, 300 per run) is voted in and runs once: 700 USDC + 150 MOCK");
    const first = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "A: S1, 1000 USDC, 300 per run");
    const s1 = first.instance.address;
    await vote(mirror, "A", first.id, true);
    await vote(mirror, "B", first.id, true);
    await warpPastGrace(mirror, first.id);
    const processed1 = await processProposal(mirror, "C", first);
    assert(processed1.info.status.passed && !processed1.info.status.actionFailed, "S1 funded and started");
    await sendAt(mirror, "W", s1, "strategy", "run", [], "W run() S1 #1");
    assert((await usdcOf(mirror, s1)) === 700n * SETTLEMENT_UNIT && (await mockOf(s1)) === 150n * SETTLEMENT_UNIT, "S1 holds 700 USDC + 150 MOCK");
    assert((await describeAt(mirror, s1, "S1 running")).status === "Running", "S1 is Running");

    step("A deploys S2 (same budget, 100 per run, 30 d deadline) and proposes [S1.migrate(S2), S2.start()]; A alone cannot migrate");
    const s2Params: StrategyParams = { ...params, rule: { ...params.rule, maxPerRun: 100n * SETTLEMENT_UNIT, deadline: start + BigInt(30 * DAY) } };
    const s2 = await deployTemplate(mirror.actors.A, mirror.dao, { template: "Strategy", params: s2Params });
    console.log(`   S2 @ ${s2.address} paramsHash ${s2.paramsHash} codeHash ${s2.codeHash}`);
    assert((await describeAt(mirror, s2.address, "S2 before vote")).status === "Pending" && (await usdcOf(mirror, s2.address)) === 0n, "S2 is Pending and empty");
    await expectRevert(simulateAt(mirror, "A", s1, "proposal", "migrate", [s2.address]), "OnlySafe", "A (proposer) cannot migrate() S1");
    await expectRevert(simulateAt(mirror, "A", s2.address, "proposal", "start", []), "OnlySafe", "A cannot start() S2");
    const calls = migrateCalls(s1, s2.address);
    const migration = await propose(mirror, "A", calls, proposalDetails(s2, `A: migrate S1 ${s1} -> S2`));
    assert((await stateOf(mirror, migration.id)) === "Voting", "migration proposal is in voting");

    step("the venue dies (MockDex drained of USDC, price moved): the migration must not depend on it");
    const dexUsdc = await usdcOf(mirror, market.dex);
    await sendAt(mirror, "F", market.dex, "dex", "drain", [mirror.dao.settlement, mirror.actors.F.account.address], `F drains ${fmtS(dexUsdc)} USDC from MockDex (a sell would now fail)`);
    await setPrice(mirror, market, 5n * SETTLEMENT_UNIT);
    assert((await usdcOf(mirror, market.dex)) === 0n, "MockDex holds no USDC: an unwind (sell) would revert");

    step("A YES, B YES, C NO; grace passes; O executes: S1 moves its raw holdings (700 USDC + 150 MOCK) to S2 without touching the venue; S2 starts");
    await vote(mirror, "A", migration.id, true);
    await vote(mirror, "B", migration.id, true);
    await vote(mirror, "C", migration.id, false);
    await warpPastGrace(mirror, migration.id);
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    const processed2 = await processProposal(mirror, "O", migration);
    assert(processed2.info.status.passed && !processed2.info.status.actionFailed, "migrate + start executed by the Safe (no venue call: the drained venue did not fail the action)");
    const old = await describeAt(mirror, s1, "S1 after migration");
    assert(old.status === "Migrated", "S1 is Migrated");
    assert((await usdcOf(mirror, s1)) === 0n && (await mockOf(s1)) === 0n, "S1 holds nothing (no USDC, no MOCK)");
    const next = await describeAt(mirror, s2.address, "S2 after migration");
    assert(next.status === "Running" && (await usdcOf(mirror, s2.address)) === 700n * SETTLEMENT_UNIT && (await mockOf(s2.address)) === 150n * SETTLEMENT_UNIT, "S2 is Running with the raw holdings: 700 USDC + 150 MOCK (nothing sold)");
    assert((await usdcOf(mirror, market.dex)) === 0n, "the venue was not called by the migration (still drained)");
    assert((await usdcOf(mirror, mirror.dao.safe)) === safeBefore && safeBefore === seeded.safeSettlement - 1_000n * SETTLEMENT_UNIT, "the migration moved nothing through the treasury");

    step("the venue is refilled; S1 can no longer run; S2 runs by its own rule (100 per run) on the migrated position");
    await sendAt(mirror, "F", mirror.dao.settlement, "settlement", "transfer", [market.dex, dexUsdc], `F refills MockDex with ${fmtS(dexUsdc)} USDC`);
    await setPrice(mirror, market, 2n * SETTLEMENT_UNIT);
    await expectRevert(simulateAt(mirror, "W", s1, "strategy", "run", []), "WrongStatus", "run() on the migrated S1 is refused");
    await sendAt(mirror, "W", s2.address, "strategy", "run", [], "W run() S2 #1");
    assert((await usdcOf(mirror, s2.address)) === 600n * SETTLEMENT_UNIT && (await mockOf(s2.address)) === 200n * SETTLEMENT_UNIT, "S2 bought 100 USDC of MOCK (50 MOCK): 600 USDC + 200 MOCK");
    await warp(mirror, HOUR, "minInterval");
    await sendAt(mirror, "B", s2.address, "strategy", "run", [], "B run() S2 #2");
    assert((await usdcOf(mirror, s2.address)) === 500n * SETTLEMENT_UNIT && (await mockOf(s2.address)) === 250n * SETTLEMENT_UNIT, "S2 holds 500 USDC + 250 MOCK");
    passed = true;
  } finally {
    verdict("J", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
