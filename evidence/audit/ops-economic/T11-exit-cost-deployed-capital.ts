/**
 * Component 7, row ECO-08: cost of blocking (by exit) versus gain when treasury capital is deployed.
 * Treasury 3050; a Project with one verifier tranche of 2000 (never confirmed) passes, so the Safe holds
 * 1050 and the instance 2000. A (32.8%) then proposes "pay A the Safe balance"; C objects by exiting in
 * grace and receives 1000 x 1050 / 3050 = 344.26 instead of 1000: the exit forfeits 65.6%, which accrues
 * to the stayers (A included) when the project returns its unspent 2000. Expected: demonstrated; the
 * phase 4 ledger prices deposits on Safe + open instances but leaves ragequit on the Safe alone, so
 * this asymmetry is retained by design and is exactly what makes exit expensive when it matters.
 *
 * Phase 5 (ruling 6 / A3): MultiSendCallOnly refuses delegatecall, so "pay A what the Safe holds" is
 * expressed call-only as `USDC.approve(A, 2**128)` plus A's own `transferFrom` after execution. Nothing
 * about the exit arithmetic changes; only the shape of the grab does.
 */
import { assert, fmtS, now, processProposal, propose, proposeTemplate, ragequit, read, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, shutdown, snapshot, step, usdcOf, verdict, vote, warp, warpPastGrace, warpPastVoting } from "../../../scenarios/lib.js";
import { encodeFunctionData } from "viem";

import { bootAudit } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco08");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    step("Project: 2000 USDC in one verifier tranche (B, C; threshold 2), 1 day deadline; passes with A + B YES");
    const deadline = (await now(mirror)) + 86_400n;
    const project = await proposeTemplate(mirror, "A", { template: "Project", params: { tranches: [{ amount: 2_000n * SETTLEMENT_UNIT, releaseType: "verifiers", releaseAt: 0n, verifiers: [mirror.actors.B.account.address, mirror.actors.C.account.address], threshold: 2 }], deadline } }, "A: build X, 2000 USDC on verifier release");
    await vote(mirror, "A", project.id, true);
    await vote(mirror, "B", project.id, true);
    await warpPastGrace(mirror, project.id);
    const funded = await processProposal(mirror, "B", project);
    assert(funded.info.status.passed && !funded.info.status.actionFailed, "project funded");
    const deployed = await snapshot(mirror, "after funding", ["F", "A", "B", "C"]);
    assert(deployed.safeSettlement === 1_050n * SETTLEMENT_UNIT && (await usdcOf(mirror, project.instance.address)) === 2_000n * SETTLEMENT_UNIT, "Safe 1050, project instance 2000");

    step("A proposes 'hand A an unlimited USDC allowance on the Safe' (call-only, = the Safe balance at execution); C objects the only effective way: exit during grace");
    const grab = await propose(mirror, "A", [{ to: mirror.dao.settlement, data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "approve", args: [A, 2n ** 128n] }) }], "A: pay A what the Safe holds");
    await vote(mirror, "A", grab.id, true);
    await warpPastVoting(mirror, grab.id);
    const exitC = await ragequit(mirror, "C");
    const fullValue = (1_000n * 10n ** 18n * (deployed.safeSettlement + 2_000n * SETTLEMENT_UNIT)) / deployed.totalShares;
    console.log(`   C burned 1000 shares for ${fmtS(exitC.paid)} USDC; its pro-rata of Safe + instance would be ${fmtS(fullValue)}: exit cost ${fmtS(fullValue - exitC.paid)} USDC = ${Number(((fullValue - exitC.paid) * 10_000n) / fullValue) / 100}% of its value`);
    assert(exitC.paid === (1_000n * 10n ** 18n * deployed.safeSettlement) / deployed.totalShares, "payout is pro-rata of the Safe only");
    await warpPastGrace(mirror, grab.id);
    const safeLeft = await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe]);
    const executed = await processProposal(mirror, "A", grab);
    assert(executed.info.status.passed && !executed.info.status.actionFailed, "the allowance proposal executed");
    const pull = await mirror.actors.A.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transferFrom", args: [mirror.dao.safe, A, safeLeft], account: mirror.actors.A.account, chain: mirror.actors.A.chain });
    await mirror.chain.publicClient.waitForTransactionReceipt({ hash: pull });
    assert((await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe])) === 0n, `A paid ${fmtS(safeLeft)} = the Safe after C's exit (B, F asleep; C's 16.4% exit is below the 34% trigger)`);

    step("the project ends unspent; the 2000 return to the Safe and belong to the stayers (A, B, F) including C's forfeited part");
    await warp(mirror, 86_400 + 5, "past the project deadline");
    await sendAt(mirror, "W", project.instance.address, "project", "end", [], "anyone calls end()");
    const returned = await snapshot(mirror, "after end()", ["F", "A", "B", "C"]);
    const exitA = await ragequit(mirror, "A");
    console.log(`   A: deposited 1000, received ${fmtS(safeLeft)} (vote) + ${fmtS(exitA.paid)} (exit) = ${fmtS(safeLeft + exitA.paid)} USDC; C: deposited 1000, left with ${fmtS(exitC.paid)}; B (asleep): ${fmtS((1_000n * 10n ** 18n * (returned.safeSettlement - exitA.paid)) / (returned.totalShares - 1_000n * 10n ** 18n))} if it exits now`);
    assert(exitA.paid > 900n * SETTLEMENT_UNIT, "A's exit alone recovers most of a second deposit's worth: C's forfeited value moved to the stayers");
    const total = seeded.safeSettlement;
    console.log(`   general rule: with fraction f of NAV outside the Safe, blocking-by-exit costs the objector f x its value (here f = 2000/${fmtS(total)} = 65.6%); blocking-by-vote costs gas but needs weight > proposer's YES`);
    passed = true;
  } finally {
    verdict("ECO-08 exit-cost-deployed-capital", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
