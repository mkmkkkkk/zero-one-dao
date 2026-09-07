/**
 * DESIGN.md §11 E: a task with verifier != proposer passes, is claimed, delivered and confirmed, and
 * mints shares to the deliverer at the NAV of verification; a task whose verifier == proposer is
 * rejected by the WorkManager.
 */
import { keccak256, stringToHex, type Hex } from "viem";

import { assert, boot, expectRevert, fmt, processProposal, read, runIfMain, seedMembers, send, shutdown, simulate, snapshot, sponsor, stateOf, step, UNIT, verdict, vote, warp, warpPastGrace } from "./lib.js";

const STATUS = ["None", "Proposed", "Active", "Complete", "Cancelled"] as const;

interface Task {
  proposer: string;
  worker: string;
  rewardValue: bigint;
  verifierThreshold: number;
  confirmations: number;
  round: number;
  proposalId: number;
  status: number;
  evidenceHash: Hex;
  sharesMinted: bigint;
}

export async function main(): Promise<void> {
  const mirror = await boot("scenario-E");
  let passed = false;
  try {
    await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const C = mirror.actors.C.account.address;
    const W = mirror.actors.W.account.address;
    const reward = 500n * UNIT;

    step("A submits task #1: verifiers [B, C], threshold 2, reward 500 settlement-worth of shares");
    await send(mirror, "A", "work", "submitTask", [[B, C], 2, reward, 0, "task: write the beacon README (verifiers B, C)"], "A submitTask -> Baal proposal");
    const taskId = await read<bigint>(mirror, "work", "taskCount");
    const task = await read<Task>(mirror, "work", "getTask", [taskId]);
    assert(taskId === 1n && STATUS[task.status] === "Proposed", "task #1 recorded as Proposed");
    assert(task.proposer.toLowerCase() === A.toLowerCase(), "proposer recorded as A (msg.sender)");
    const proposalId = task.proposalId;
    await warp(mirror, 1);
    assert((await stateOf(mirror, proposalId)) === "Submitted", `Baal proposal #${proposalId} is Submitted (WorkManager holds no shares, needs a member sponsor)`);

    step("A (member) sponsors; A and B vote YES; grace passes; C executes the activation");
    await sponsor(mirror, "A", proposalId);
    await vote(mirror, "A", proposalId, true);
    await vote(mirror, "B", proposalId, true);
    await warpPastGrace(mirror, proposalId);
    const data = await read<Hex>(mirror, "work", "activationData", [taskId]);
    const processed = await processProposal(mirror, "C", { id: proposalId, data, submit: { hash: "0x", blockNumber: 0n, gasUsed: 0n } });
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "activation multicall executed by the Safe");
    assert(STATUS[(await read<Task>(mirror, "work", "getTask", [taskId])).status] === "Active", "task #1 is Active");

    step("verifier B cannot claim; worker W claims");
    await expectRevert(simulate(mirror, "B", "work", "claim", [taskId]), "VerifierCannotClaim", "verifier B is refused as worker");
    await send(mirror, "W", "work", "claim", [taskId], "W claims task #1");

    step("W delivers an evidence hash; B and C confirm; shares mint to W at the NAV of verification");
    const evidence = stringToHex("evidence: README v1 sha256=...");
    await send(mirror, "W", "work", "deliver", [taskId, keccak256(evidence)], "W deliver evidence hash");
    await send(mirror, "B", "work", "confirm", [taskId, evidence], "B confirms (1/2)");
    assert(STATUS[(await read<Task>(mirror, "work", "getTask", [taskId])).status] === "Active", "still Active after 1 of 2 confirmations; nothing minted yet");
    assert((await read<bigint>(mirror, "shares", "balanceOf", [W])) === 0n, "W has no shares before threshold");
    const before = await snapshot(mirror, "before final confirmation", ["W"]);
    const expectedShares = (reward * before.totalShares) / before.safeSettlement;
    console.log(`   NAV per share = ${fmt((before.safeSettlement * UNIT) / before.totalShares)} settlement; 500 settlement-worth = ${fmt(expectedShares)} shares`);
    await send(mirror, "C", "work", "confirm", [taskId, evidence], "C confirms (2/2) -> mint");
    const done = await read<Task>(mirror, "work", "getTask", [taskId]);
    assert(STATUS[done.status] === "Complete", "task #1 Complete");
    const after = await snapshot(mirror, "after verification", ["W"]);
    assert(after.shares.W === expectedShares, `W received reward * totalShares / treasury = ${fmt(expectedShares)} shares`);
    assert(done.sharesMinted === expectedShares, "task records the minted amount");
    assert(after.safeSettlement === before.safeSettlement, "verification moved no settlement; W's claim is shares at NAV");
    await expectRevert(simulate(mirror, "B", "work", "confirm", [taskId, evidence]), "WrongStatus", "no further confirmation or mint after completion");

    step("negative: a task whose verifier == proposer is rejected at submission");
    await expectRevert(simulate(mirror, "A", "work", "submitTask", [[A, B], 1, reward, 0, "task: A verifies itself"]), "VerifierIsProposer", "A naming A as verifier is rejected");
    await expectRevert(simulate(mirror, "B", "work", "submitTask", [[A, B], 2, reward, 0, "task: B verifies itself"]), "VerifierIsProposer", "B naming B as verifier is rejected");
    await expectRevert(simulate(mirror, "A", "work", "submitTask", [[B, B], 2, reward, 0, "task: duplicate verifier"]), "DuplicateVerifier", "duplicate verifiers are rejected");
    assert((await read<bigint>(mirror, "work", "taskCount")) === 1n, "no second task exists");
    passed = true;
  } finally {
    verdict("E", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
