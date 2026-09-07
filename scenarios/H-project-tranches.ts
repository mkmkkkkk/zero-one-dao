/**
 * DESIGN.md §11 H: a Project proposal contract with tranches: the first (a date tranche due at once)
 * is released to the operator when the vote executes start(); the second only after the named
 * verifiers (never the proposer) confirm; a third that is never confirmed returns to the Safe when
 * anyone ends the project after its deadline. A project naming the proposer as verifier cannot be
 * deployed at all.
 */
import type { ProjectParams, Tranche } from "../src/proposals.js";
import { assert, boot, DAY, describeAt, expectDeployRevert, expectRevert, fmtS, now, processProposal, proposeTemplate, readAt, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, shutdown, simulateAt, snapshot, step, usdcOf, verdict, vote, warp, warpPastGrace } from "./lib.js";

interface TrancheView {
  plan: { amount: bigint; releaseType: number; releaseAt: bigint; verifiers: readonly string[]; threshold: number };
  state: { released: boolean; cancelled: boolean; confirmations: number };
}

export async function main(): Promise<void> {
  const mirror = await boot("scenario-H");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const C = mirror.actors.C.account.address;
    const start = await now(mirror);
    const deadline = start + BigInt(30 * DAY);
    const t0: Tranche = { amount: 300n * SETTLEMENT_UNIT, releaseType: "date", releaseAt: 0n, verifiers: [], threshold: 0 };
    const t1: Tranche = { amount: 200n * SETTLEMENT_UNIT, releaseType: "verifiers", releaseAt: 0n, verifiers: [B, C], threshold: 2 };
    const t2: Tranche = { amount: 100n * SETTLEMENT_UNIT, releaseType: "verifiers", releaseAt: 0n, verifiers: [B, C], threshold: 2 };
    const params: ProjectParams = { tranches: [t0, t1, t2], deadline };
    const trancheOf = async (address: `0x${string}`, index: number): Promise<TrancheView> => {
      const [plan, state] = await readAt<[TrancheView["plan"], TrancheView["state"]]>(mirror, address, "project", "tranche", [index]);
      return { plan, state };
    };

    step("negative: a Project whose verifier is the proposer cannot be deployed");
    await expectDeployRevert(mirror, "A", "ProjectProposal", [mirror.dao.safe, mirror.dao.settlement, A, [{ ...t0, releaseType: 0 }, { ...t1, releaseType: 1, verifiers: [A, B] }], deadline], "VerifierIsOperator", "A naming A as verifier is rejected by the constructor");
    await expectDeployRevert(mirror, "A", "ProjectProposal", [mirror.dao.safe, mirror.dao.settlement, A, [{ ...t1, releaseType: 1, verifiers: [B, B] }], deadline], "DuplicateVerifier", "duplicate verifiers are rejected");
    await expectDeployRevert(mirror, "A", "ProjectProposal", [mirror.dao.safe, mirror.dao.settlement, A, [{ ...t1, releaseType: 1, threshold: 3 }], deadline], "InvalidThreshold", "threshold above the verifier count is rejected");

    step("A deploys a Project (tranches: 300 at once; 200 after B and C confirm; 100 after B and C confirm; 30 d deadline) and submits fund+start");
    const proposal = await proposeTemplate(mirror, "A", { template: "Project", params }, "A: build the beacon, 600 USDC in three tranches");
    const p = proposal.instance.address;
    const pending = await describeAt(mirror, p, "before vote");
    assert(pending.status === "Pending" && pending.budget === 600n * SETTLEMENT_UNIT && pending.deadline === deadline && pending.operator === A, "describe(): Pending, budget 600, deadline, operator A");
    assert((await readAt<bigint>(mirror, p, "project", "trancheCount")) === 3n, "three tranches recorded");

    step("A YES, B YES; grace passes; D executes: the Safe funds 600 and starts; the first tranche (300) releases to A at once");
    const aBefore = await usdcOf(mirror, A);
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "D", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "fund + start executed by the Safe");
    const afterStart = await snapshot(mirror, "after start", ["A"]);
    assert(afterStart.safeSettlement === seeded.safeSettlement - 600n * SETTLEMENT_UNIT, "treasury decreased by the whole budget (600)");
    assert((await usdcOf(mirror, A)) === aBefore + 300n * SETTLEMENT_UNIT, "A received the first tranche (300) on vote");
    assert((await usdcOf(mirror, p)) === 300n * SETTLEMENT_UNIT, "the project holds the two unreleased tranches (300)");
    assert((await trancheOf(p, 0)).state.released && !(await trancheOf(p, 1)).state.released, "tranche 0 released, tranche 1 not");
    assert((await describeAt(mirror, p, "running")).status === "Running", "project is Running");

    step("second tranche: A (operator) and D (stranger) cannot confirm; B confirms (1/2) -> nothing; B again refused; C confirms (2/2) -> 200 to A");
    await expectRevert(simulateAt(mirror, "A", p, "project", "confirm", [1]), "OnlyVerifier", "A (proposer/operator) cannot confirm its own tranche");
    await expectRevert(simulateAt(mirror, "D", p, "project", "confirm", [1]), "OnlyVerifier", "D is not a verifier");
    await expectRevert(simulateAt(mirror, "W", p, "project", "release", [1]), "WrongReleaseType", "a verifiers tranche cannot be released by date");
    await sendAt(mirror, "B", p, "project", "confirm", [1], "B confirms tranche 1 (1/2)");
    assert((await usdcOf(mirror, A)) === aBefore + 300n * SETTLEMENT_UNIT && (await trancheOf(p, 1)).state.confirmations === 1, "nothing released after 1 of 2 confirmations");
    await expectRevert(simulateAt(mirror, "B", p, "project", "confirm", [1]), "AlreadyConfirmed", "B cannot confirm twice");
    await sendAt(mirror, "C", p, "project", "confirm", [1], "C confirms tranche 1 (2/2) -> release");
    assert((await usdcOf(mirror, A)) === aBefore + 500n * SETTLEMENT_UNIT, "A received the second tranche (200) after both verifiers confirmed");
    assert((await usdcOf(mirror, p)) === 100n * SETTLEMENT_UNIT && (await trancheOf(p, 1)).state.released, "the project holds the last tranche (100)");
    await expectRevert(simulateAt(mirror, "C", p, "project", "confirm", [1]), "TrancheSettled", "a released tranche takes no more confirmations");

    step("third tranche is never confirmed; end() before the deadline is refused; after the deadline anyone ends it and the unspent 100 returns to the Safe");
    await expectRevert(simulateAt(mirror, "W", p, "project", "end", []), "DeadlineNotReached", "end() before the deadline is refused");
    await expectRevert(simulateAt(mirror, "A", p, "project", "stop", []), "OnlySafe", "A cannot stop() its own project");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    await warp(mirror, 30 * DAY, "to the project deadline");
    await sendAt(mirror, "W", p, "project", "end", [], "W end() after the deadline");
    const ended = await describeAt(mirror, p, "ended");
    assert(ended.status === "Complete" && (await usdcOf(mirror, p)) === 0n, "project Complete, holds nothing");
    assert((await usdcOf(mirror, mirror.dao.safe)) === safeBefore + 100n * SETTLEMENT_UNIT, `unspent tranche (${fmtS(100n * SETTLEMENT_UNIT)} USDC) returned to the Safe`);
    assert((await usdcOf(mirror, mirror.dao.safe)) === seeded.safeSettlement - 500n * SETTLEMENT_UNIT, "treasury = start - what A actually received (500)");
    await expectRevert(simulateAt(mirror, "B", p, "project", "confirm", [2]), "WrongStatus", "no confirmation after the end");
    passed = true;
  } finally {
    verdict("H", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
