/**
 * GOV-05 (phase 5, FLIPPED) — no proposal can demand more processing gas than one Base transaction
 * can carry: the Zero One Baal fork caps baalGas at 8,000,000 in submitProposal (ruling 1).
 *
 * Invariant: every Ready proposal can be processed by anyone within the chain's per-transaction gas
 * cap (Base EIP-7825: 16,777,216); later proposals are never held hostage forever by an earlier one.
 *
 * Steps: seed → A's submit with baalGas 20,000,000 reverts "baalGas to high" → A submits #1 with the
 * maximum 8,000,000, votes YES → B submits #2 (prev = #1), votes YES → grace → processProposal(#1) at
 * 5 M reverts "not enough gas" and #2 is blocked behind it (as before) → processProposal(#1) with
 * 8,500,000 gas (under the 16,777,216 cap) succeeds → #2 processes at 5 M.
 */
import { assert, boot, expectRevert, fmtS, proposalInfo, propose, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulate, stateOf, step, transferCall, usdcOf, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { encodeProposalData } from "../../../src/baal.js";
import { logLine, writeWithGas } from "./audit-lib.js";

const LOG = "t08-baalgas-20m-blocks-chain";

/**
 * Run GOV-05 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t08");
  let passed = false;
  try {
    await seedMembers(mirror);
    const O = mirror.actors.O.account.address;
    step("A's submitProposal with baalGas = 20,000,000 reverts: the fork caps baalGas at 8,000,000");
    const data1 = encodeProposalData([transferCall(mirror, O, SETTLEMENT_UNIT)]);
    const A = mirror.actors.A;
    await expectRevert(simulate(mirror, "A", "baal", "submitProposal", [data1, 0, 20_000_000n, "A: pay O 1 USDC (baalGas 20M)"]), "baalGas to high", "baalGas 20,000,000 is refused");
    await expectRevert(simulate(mirror, "A", "baal", "submitProposal", [data1, 0, 8_000_001n, "A: pay O 1 USDC (baalGas 8M+1)"]), "baalGas to high", "baalGas 8,000,001 is refused");
    step("A submits #1 'pay O 1 USDC' with baalGas = 8,000,000 (the maximum the fork accepts) and votes YES");
    const hash = await A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data1, 0, 8_000_000n, "A: pay O 1 USDC (baalGas 8M)"], account: A.account, chain: A.chain } as never);
    const receipt = await A.publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === "success", "submitProposal with baalGas 8,000,000 accepted");
    await warp(mirror, 1, "let votingStarts become past");
    await vote(mirror, "A", 1, true);
    step("B submits #2 'pay O 2 USDC' (prevProposalId = 1) and votes YES");
    const p2 = await propose(mirror, "B", [transferCall(mirror, O, 2n * SETTLEMENT_UNIT)], "B: pay O 2 USDC");
    await vote(mirror, "B", p2.id, true);
    await warpPastGrace(mirror, p2.id);
    logLine(LOG, `   #1 state ${await stateOf(mirror, 1)} (baalGas ${(await mirror.chain.publicClient.readContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "proposals", args: [1] } as never) as readonly unknown[])[6]}), #2 state ${await stateOf(mirror, p2.id)}`);

    step("processProposal(#1) with 5,000,000 gas -> reverts 'not enough gas'; #2 -> 'prev!processed' (a delay, not a lock)");
    const low = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], 5_000_000n);
    logLine(LOG, `   processProposal(#1) gas=5000000 status=${low.status}`);
    assert(low.status === "reverted", "#1 cannot be processed at 5 M gas");
    await expectRevert(simulate(mirror, "W", "baal", "processProposal", [p2.id, p2.data]), "prev!processed", "#2 waits behind #1");

    step("a transaction under Base's 16,777,216 cap clears #1: processProposal(#1) with 8,500,000 gas");
    const cap = 16_777_216n;
    const clearGas = 8_500_000n;
    assert(clearGas < cap, `the clearing transaction fits under the EIP-7825 cap (${clearGas} < ${cap})`);
    const high = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], clearGas);
    const info1 = await proposalInfo(mirror, 1);
    logLine(LOG, `   processProposal(#1) gas=${clearGas} status=${high.status} gasUsed=${high.gasUsed} passed=${info1.status.passed} actionFailed=${info1.status.actionFailed}; O USDC ${fmtS(await usdcOf(mirror, O))}`);
    assert(high.status === "success" && info1.status.passed && !info1.status.actionFailed, "#1 processed with 8.5 M gas");
    const done2 = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [p2.id, p2.data], 5_000_000n);
    logLine(LOG, `   processProposal(#2) gas=5000000 status=${done2.status} state=${await stateOf(mirror, p2.id)}`);
    assert(done2.status === "success", "#2 processes once #1 is terminal");
    logLine(LOG, `   worst case for a member holding 1 share: every later proposal waits until someone pays one 8.5 M gas transaction (Base: cents); never permanent`);
    passed = true;
  } finally {
    verdict("GOV-05 baalGas capped at 8M: no proposal can block the chain permanently (phase 5 fork; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
