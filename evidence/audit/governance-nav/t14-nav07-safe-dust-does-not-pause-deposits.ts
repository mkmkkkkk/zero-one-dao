/**
 * NAV-07 (phase 5, FLIPPED) — dust of a registered asset on the Safe cannot pause deposits.
 *
 * Invariant: deposits, the only capital path, cannot be blocked by anyone but the members' votes.
 *
 * Fix (decision.md phase 5 ruling 4a): TreasuryLedger.settled() looks only at the asset holdings of
 * OPEN instances, never at Safe balances. A stranger who sends 1 wei of a registered asset to the Safe
 * changes nothing; the dust is shared by exit. What still pauses deposits is an open instance holding
 * its asset (a running or stopped-not-unwound Strategy), which only a vote created and only a vote
 * (unwind / migrate) or the Strategy's own rule (deadline, take-profit, stop-loss) ends. A stranger's
 * 1 wei sent to such an open instance keeps it open until that vote: documented residual (the
 * instance is closed for deposits during its life anyway).
 *
 * Steps: seed → Strategy on MOCK passes, registers MOCK, completes at its deadline (closed) → W sends
 * 1 raw unit of MOCK to the Safe → settled() true, deposit succeeds at NAV; W sends 1 unit to the
 * closed instance → still true; a second Strategy runs and holds MOCK → false (deposits paused by the
 * vote's own instance); its stop + unwind vote → true again.
 */
import { loadLocalAbi } from "../../../src/baal.js";
import { stopAndUnwindCalls, type StrategyParams } from "../../../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, deposit, expectRevert, fmt, fmtS, now, processProposal, propose, proposeTemplate, read, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, shutdown, simulate, step, T, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, safeUsdc, totalShares } from "./audit-lib.js";

const LOG = "t14-nav07-safe-dust-does-not-pause-deposits";

/**
 * Run NAV-07 on a fresh mirror.
 *
 * Raises:
 *   Error: when a deposit is paused by anything but an open instance's own holdings.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t14");
  let passed = false;
  try {
    await seedMembers(mirror);
    const ledgerAbi = loadLocalAbi("TreasuryLedger");
    const ledger = mirror.dao.treasuryLedger;
    const ledgerRead = async <R,>(functionName: string, args: readonly unknown[] = []): Promise<R> => (await mirror.chain.publicClient.readContract({ address: ledger, abi: ledgerAbi, functionName, args } as never)) as R;
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);
    const mockOf = (holder: `0x${string}`) => mirror.chain.publicClient.readContract({ address: market.asset, abi: mirror.abi.settlement, functionName: "balanceOf", args: [holder] }) as Promise<bigint>;

    step("a Strategy on MOCK (budget 100 USDC, 1 day) passes: MOCK is registered forever; it completes at its deadline and closes");
    const start = await now(mirror);
    const params: StrategyParams = { venue: market.dex, asset: market.asset, budget: 100n * SETTLEMENT_UNIT, rule: { maxPerRun: 100n * SETTLEMENT_UNIT, minInterval: BigInt(T.hour), deadline: start + BigInt(DAY), takeProfitBps: 0n, stopLossBps: 0n, slippageBps: 100n } };
    const first = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "A: strategy 100 USDC on MOCK");
    for (const actor of ["A", "B"] as const) await vote(mirror, actor, first.id, true);
    await warpPastGrace(mirror, first.id);
    const processed = await processProposal(mirror, "W", first);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "strategy funded and started");
    assert(await ledgerRead<boolean>("registeredAsset", [market.asset]), "MOCK is a registered asset");
    await warp(mirror, DAY + 1, "past the strategy deadline");
    await sendAt(mirror, "W", first.instance.address, "strategy", "run", [], "W run() at deadline -> Complete, closed");
    assert((await ledgerRead<`0x${string}`[]>("openInstances")).length === 0 && (await ledgerRead<boolean>("settled")), "no open instance; settled");

    step("W (stranger) sends 1 raw unit of MOCK to the Safe: deposits stay open");
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [mirror.actors.W.account.address, 10n], "F gives W 10 raw units of MOCK");
    await sendAt(mirror, "W", market.asset, "settlement", "transfer", [mirror.dao.safe, 1n], "W sends 1 raw unit of MOCK to the Safe");
    logLine(LOG, `   Safe MOCK = ${await mockOf(mirror.dao.safe)} raw units (registered asset); ledger.settled() = ${await ledgerRead<boolean>("settled")}`);
    assert((await mockOf(mirror.dao.safe)) === 1n && (await ledgerRead<boolean>("settled")), "settled() ignores Safe balances");
    const supply = await totalShares(mirror);
    const treasury = await ledgerRead<bigint>("depositTreasury");
    const dep = await deposit(mirror, "D", 100n * SETTLEMENT_UNIT);
    logLine(LOG, `   D deposited 100 USDC -> ${fmt(dep.sharesMinted)} shares at NAV ${fmtS(treasury)} / ${fmt(supply)} (dust ignored, shared by exit only)`);
    assert(dep.sharesMinted === (100n * SETTLEMENT_UNIT * supply) / treasury, "the deposit succeeded at NAV with dust on the Safe");
    await sendAt(mirror, "W", market.asset, "settlement", "transfer", [first.instance.address, 1n], "W sends 1 raw unit of MOCK to the CLOSED instance");
    assert(await ledgerRead<boolean>("settled"), "a closed instance's balance is never consulted either");

    step("what does pause deposits: an OPEN instance holding its asset (created by a vote, ended by a vote or by its rule)");
    const second = await proposeTemplate(mirror, "A", { template: "Strategy", params: { ...params, rule: { ...params.rule, deadline: (await now(mirror)) + BigInt(30 * DAY) } } }, "A: strategy 100 USDC on MOCK, 30 d");
    for (const actor of ["A", "B"] as const) await vote(mirror, actor, second.id, true);
    await warpPastGrace(mirror, second.id);
    assert((await processProposal(mirror, "W", second)).info.status.passed, "second strategy started (open, holds only USDC)");
    assert(await ledgerRead<boolean>("settled"), "open instance holding only USDC: settled");
    await sendAt(mirror, "W", second.instance.address, "strategy", "run", [], "run(): buys MOCK with the whole budget");
    logLine(LOG, `   open instance MOCK = ${await mockOf(second.instance.address)}; ledger.settled() = ${await ledgerRead<boolean>("settled")}`);
    assert(!(await ledgerRead<boolean>("settled")), "an open instance holding its asset pauses deposits (by design: the members voted that capital out)");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [100n * SETTLEMENT_UNIT]), "TreasuryNotSettled", "deposit refused while the voted strategy holds MOCK");
    const stopUnwind = await propose(mirror, "A", stopAndUnwindCalls(second.instance.address), "A: stop + unwind the second strategy");
    for (const actor of ["A", "B"] as const) await vote(mirror, actor, stopUnwind.id, true);
    await warpPastGrace(mirror, stopUnwind.id);
    const done = await processProposal(mirror, "W", stopUnwind);
    assert(done.info.status.passed && !done.info.status.actionFailed, "stop + unwind executed by the Safe");
    logLine(LOG, `   after the unwind vote: open instances ${(await ledgerRead<`0x${string}`[]>("openInstances")).length}, Safe USDC ${fmtS(await safeUsdc(mirror))}, Safe MOCK dust still ${await mockOf(mirror.dao.safe)}; ledger.settled() = ${await ledgerRead<boolean>("settled")}`);
    assert(await ledgerRead<boolean>("settled"), "the vote reopened deposits; the Safe dust never mattered");
    const again = await deposit(mirror, "D", 100n * SETTLEMENT_UNIT);
    assert(again.sharesMinted > 0n, "deposits open again");
    logLine(LOG, `   NAV-07 closed: a stranger's dust on the Safe cannot pause deposits; only a voted instance holding its asset does, and only until the vote or the rule ends it`);
    passed = true;
  } finally {
    verdict("NAV-07 Safe dust does not pause deposits (phase 5 ruling 4a; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
