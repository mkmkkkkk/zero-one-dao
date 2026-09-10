/**
 * GOV-01 (phase 5, FLIPPED) — a passed proposal cannot be killed by a low-gas processProposal.
 *
 * Invariant: a proposal that passed the vote and survived grace executes its voted multicall when
 * processed, or stays Ready until it can.
 *
 * Fix (decision.md phase 5 ruling 1): every Zero One submit path sets baalGas = the action's simulated
 * need x 1.5 (src/proposals.ts baalGasFor, used by scenarios/lib.ts propose; ZeroOneIntentAccount op 0;
 * WorkManager ACTIVATION_BAAL_GAS), so Baal's guard `gasleft() >= baalGas` reverts "not enough gas" for
 * every limit at which the voted multicall could run out of gas. The proposal stays Ready.
 *
 * Steps: seed → A proposes "pay O 500 USDC + 39 x 1 USDC" (a ~1.2 M gas action; baalGas ~1.9 M) → A, B YES
 * → grace → W (non-member) sweeps processProposal gas limits 500k..1.6M: every transaction reverts, the
 * proposal is still Ready, O unpaid → control: 5,000,000 gas pays O.
 */
import { getAddress } from "viem";

import { assert, boot, fmtS, proposalInfo, propose, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, stateOf, step, transferCall, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { logLine, revertChain, snapshotChain, writeWithGas } from "./audit-lib.js";

const LOG = "t01-lowgas-process-kills-proposal";

/**
 * Run GOV-01 on a fresh mirror.
 *
 * Raises:
 *   Error: when an assertion about the demonstrated failure does not hold.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t01");
  let passed = false;
  try {
    await seedMembers(mirror);
    const O = mirror.actors.O.account.address;
    const pay = 500n * SETTLEMENT_UNIT;

    step("A proposes: Safe pays O 500 USDC plus 39 x 1 USDC to fresh addresses (a multicall the size of a Project/Strategy start; baalGas = simulated need x 1.5, as every Zero One proposal)");
    const grantees = Array.from({ length: 39 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    const proposal = await propose(mirror, "A", [transferCall(mirror, O, pay), ...grantees.map((g) => transferCall(mirror, g, SETTLEMENT_UNIT))], "A: pay O 500 USDC + 39 grants");
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    await warpPastGrace(mirror, proposal.id);
    assert((await stateOf(mirror, proposal.id)) === "Ready", "proposal is Ready (passed, grace over)");
    const snap = await snapshotChain(mirror);

    step("control: W processes with the mirror's explicit 5,000,000 gas -> O is paid");
    const oBefore = await usdcOf(mirror, O);
    const ok = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [proposal.id, proposal.data], 5_000_000n);
    const okInfo = await proposalInfo(mirror, proposal.id);
    logLine(LOG, `   control  gas=5000000 status=${ok.status} gasUsed=${ok.gasUsed} passed=${okInfo.status.passed} actionFailed=${okInfo.status.actionFailed} O USDC ${fmtS(oBefore)} -> ${fmtS(await usdcOf(mirror, O))}`);
    assert(okInfo.status.passed && !okInfo.status.actionFailed && (await usdcOf(mirror, O)) === oBefore + pay, "control: the multicall executed and O received 500 USDC");
    await revertChain(mirror, snap);

    step("attack: W (holds no shares) sweeps processProposal gas limits from 500,000 to 1,600,000: every one must revert (not enough gas), never record actionFailed");
    const baalGas = (await mirror.chain.publicClient.readContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "proposals", args: [proposal.id] } as never) as readonly unknown[])[6] as bigint;
    logLine(LOG, `   proposal #${proposal.id} baalGas = ${baalGas} (simulated action need x 1.5)`);
    assert(baalGas > 0n && baalGas <= 8_000_000n, "the proposal carries a non-zero baalGas within the 8,000,000 cap");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    let killed = false;
    let reverted = 0;
    for (let gas = 500_000n; gas <= 1_600_000n; gas += 25_000n) {
      const attempt = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [proposal.id, proposal.data], gas);
      const attemptInfo = await proposalInfo(mirror, proposal.id);
      if (gas % 200_000n === 0n || attempt.status === "success") logLine(LOG, `   sweep gas=${gas} status=${attempt.status} gasUsed=${attempt.gasUsed} processed=${attemptInfo.status.processed} passed=${attemptInfo.status.passed} actionFailed=${attemptInfo.status.actionFailed} O USDC ${fmtS(await usdcOf(mirror, O))}`);
      if (attempt.status === "reverted") reverted += 1;
      if (attempt.status === "success" && attemptInfo.status.actionFailed) killed = true;
    }
    const info = await proposalInfo(mirror, proposal.id);
    logLine(LOG, `   sweep: ${reverted} of 45 low-gas attempts reverted; processed=${info.status.processed} passed=${info.status.passed} actionFailed=${info.status.actionFailed} state=${await stateOf(mirror, proposal.id)}`);
    assert(!killed, "no gas limit exists at which processProposal succeeds while the voted multicall runs out of gas");
    assert(reverted === 45 && !info.status.processed, "every low-gas attempt reverted (not enough gas); the proposal is untouched");
    assert((await stateOf(mirror, proposal.id)) === "Ready" && (await usdcOf(mirror, O)) === oBefore && (await usdcOf(mirror, mirror.dao.safe)) === safeBefore, "the proposal is still Ready; nothing moved");
    step("after the sweep the proposal still executes with the relay's explicit gas");
    const done = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [proposal.id, proposal.data], 5_000_000n);
    const doneInfo = await proposalInfo(mirror, proposal.id);
    logLine(LOG, `   processProposal gas=5000000 status=${done.status} passed=${doneInfo.status.passed} actionFailed=${doneInfo.status.actionFailed} O USDC ${fmtS(oBefore)} -> ${fmtS(await usdcOf(mirror, O))}`);
    assert(done.status === "success" && doneInfo.status.passed && !doneInfo.status.actionFailed && (await usdcOf(mirror, O)) === oBefore + pay, "the voted payment executed");
    passed = true;
  } finally {
    verdict("GOV-01 low-gas processProposal cannot kill a passed proposal (phase 5: baalGas = simulated x 1.5; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
