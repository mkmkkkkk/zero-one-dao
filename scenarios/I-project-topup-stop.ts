/**
 * DESIGN.md §11 I: a running Project's budget is raised by a second passed proposal (topUp + amend
 * that schedules the new money) and stopped by a third (stop returns the remainder to the Safe).
 * The proposer alone cannot call topUp, amend or stop: every one of them is Safe-only.
 */
import { amendCalls, encodeAmendParams, stopCalls, topUpCalls, type ProjectParams, type Tranche } from "../src/proposals.js";
import { assert, boot, DAY, describeAt, expectRevert, fmtS, now, processProposal, propose, proposeTemplate, readAt, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulateAt, step, usdcOf, verdict, vote, warpPastGrace } from "./lib.js";

interface TrancheView {
  plan: { amount: bigint; releaseType: number; releaseAt: bigint; verifiers: readonly string[]; threshold: number };
  state: { released: boolean; cancelled: boolean; confirmations: number };
}

export async function main(): Promise<void> {
  const mirror = await boot("scenario-I");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const C = mirror.actors.C.account.address;
    const deadline = (await now(mirror)) + BigInt(30 * DAY);
    const t0: Tranche = { amount: 200n * SETTLEMENT_UNIT, releaseType: "date", releaseAt: 0n, verifiers: [], threshold: 0 };
    const t1: Tranche = { amount: 300n * SETTLEMENT_UNIT, releaseType: "verifiers", releaseAt: 0n, verifiers: [B, C], threshold: 2 };
    const params: ProjectParams = { tranches: [t0, t1], deadline };
    const trancheOf = async (address: `0x${string}`, index: number): Promise<TrancheView> => {
      const [plan, state] = await readAt<[TrancheView["plan"], TrancheView["state"]]>(mirror, address, "project", "tranche", [index]);
      return { plan, state };
    };

    step("proposal 1: A's Project (200 at once; 300 after B and C confirm) is voted in and started");
    const first = await proposeTemplate(mirror, "A", { template: "Project", params }, "A: project, 500 USDC in two tranches");
    const p = first.instance.address;
    await vote(mirror, "A", first.id, true);
    await vote(mirror, "B", first.id, true);
    await warpPastGrace(mirror, first.id);
    const aStart = await usdcOf(mirror, A);
    const processed1 = await processProposal(mirror, "C", first);
    assert(processed1.info.status.passed && !processed1.info.status.actionFailed, "proposal 1 executed");
    const d1 = await describeAt(mirror, p, "after proposal 1");
    assert(d1.status === "Running" && d1.budget === 500n * SETTLEMENT_UNIT, "Running with budget 500");
    assert((await usdcOf(mirror, A)) === aStart + 200n * SETTLEMENT_UNIT && (await usdcOf(mirror, p)) === 300n * SETTLEMENT_UNIT, "A got 200; the project holds 300");

    step("negative: the proposer calling topUp / amend / stop directly reverts (Safe only)");
    const raise = 400n * SETTLEMENT_UNIT;
    const newPlan: ProjectParams = { tranches: [t1, { amount: raise, releaseType: "date", releaseAt: 0n, verifiers: [], threshold: 0 }], deadline };
    const amendParams = encodeAmendParams({ template: "Project", params: newPlan });
    await expectRevert(simulateAt(mirror, "A", p, "proposal", "topUp", [raise]), "OnlySafe", "A cannot topUp()");
    await expectRevert(simulateAt(mirror, "A", p, "proposal", "amend", [amendParams]), "OnlySafe", "A cannot amend()");
    await expectRevert(simulateAt(mirror, "A", p, "proposal", "stop", []), "OnlySafe", "A cannot stop()");
    await expectRevert(simulateAt(mirror, "B", p, "proposal", "stop", []), "OnlySafe", "B (a verifier) cannot stop()");

    step(`proposal 2 (by A): topUp ${fmtS(raise)} USDC + amend (keep the 300 verifier tranche, add a 400 tranche released at once); voted in`);
    const second = await propose(mirror, "A", [...topUpCalls(mirror.dao, p, raise), ...amendCalls(p, amendParams)], `A: raise project ${p} budget by ${fmtS(raise)} USDC ${JSON.stringify({ amendParams })}`);
    await vote(mirror, "A", second.id, true);
    await vote(mirror, "B", second.id, true);
    await vote(mirror, "C", second.id, false);
    await warpPastGrace(mirror, second.id);
    const safeBefore2 = await usdcOf(mirror, mirror.dao.safe);
    const processed2 = await processProposal(mirror, "B", second);
    assert(processed2.info.status.passed && !processed2.info.status.actionFailed, "topUp + amend executed by the Safe");
    const d2 = await describeAt(mirror, p, "after proposal 2");
    assert(d2.budget === 900n * SETTLEMENT_UNIT && d2.status === "Running", "budget raised 500 -> 900, still Running");
    assert(d2.paramsHash !== d1.paramsHash, "paramsHash changed with the amendment");
    assert((await usdcOf(mirror, mirror.dao.safe)) === safeBefore2 - raise, "treasury decreased by the topUp");
    assert((await usdcOf(mirror, A)) === aStart + 600n * SETTLEMENT_UNIT, "A received the new 400 tranche at once (200 + 400 so far)");
    assert((await usdcOf(mirror, p)) === 300n * SETTLEMENT_UNIT, "the project still holds the 300 verifier tranche");
    assert((await readAt<bigint>(mirror, p, "project", "trancheCount")) === 4n, "four tranches recorded (2 original, 2 amended)");
    assert((await trancheOf(p, 1)).state.cancelled && !(await trancheOf(p, 2)).state.released && (await trancheOf(p, 3)).state.released, "old verifier tranche cancelled; new verifier tranche open; new date tranche released");
    assert((await readAt<bigint>(mirror, p, "project", "unreleased")) === 300n * SETTLEMENT_UNIT, "unreleased = 300");

    step("proposal 3 (by B): stop(); A NO, B YES, C YES; the remainder (300) returns to the Safe");
    const third = await propose(mirror, "B", stopCalls(p), `B: stop project ${p}`);
    await vote(mirror, "A", third.id, false);
    await vote(mirror, "B", third.id, true);
    await vote(mirror, "C", third.id, true);
    await warpPastGrace(mirror, third.id);
    const safeBefore3 = await usdcOf(mirror, mirror.dao.safe);
    const processed3 = await processProposal(mirror, "W", third);
    assert(processed3.info.status.passed && !processed3.info.status.actionFailed, "stop executed by the Safe");
    const d3 = await describeAt(mirror, p, "after proposal 3");
    assert(d3.status === "Stopped" && (await usdcOf(mirror, p)) === 0n, "project Stopped and holds nothing");
    assert((await usdcOf(mirror, mirror.dao.safe)) === safeBefore3 + 300n * SETTLEMENT_UNIT, "the Safe received the remainder (300)");
    assert((await usdcOf(mirror, mirror.dao.safe)) === seeded.safeSettlement - 600n * SETTLEMENT_UNIT, "treasury = start - exactly what A received (600)");
    await expectRevert(simulateAt(mirror, "B", p, "project", "confirm", [2]), "WrongStatus", "no confirmation after stop");
    await expectRevert(simulateAt(mirror, "A", p, "proposal", "start", []), "OnlySafe", "A cannot restart it");
    passed = true;
  } finally {
    verdict("I", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
