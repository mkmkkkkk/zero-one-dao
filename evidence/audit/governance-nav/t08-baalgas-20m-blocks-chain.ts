/**
 * GOV-05 — a proposal submitted with baalGas = 20,000,000 (Baal's maximum) blocks the sponsorship
 * chain until someone sends a >20.4 M gas transaction; the relay's fixed 5 M execute can never do it.
 *
 * Invariant that should hold: every Ready proposal can be processed by anyone with the harness's
 * explicit 5,000,000 gas; later proposals are never held hostage by an earlier one.
 *
 * Where it fails: Baal.processProposal requires `gasleft() >= prop.baalGas` and later proposals
 * require the previous sponsored proposal to be terminal ("prev!processed"). Zero One passes
 * baalGas = 0 itself, but submitProposal is public: any member (1 share) submits with baalGas =
 * 20,000,000. On a chain with a per-transaction gas cap below ~20.4 M (EIP-7825 = 16,777,216) the
 * chain is blocked forever; on anvil (30 M block limit) a 20.1 M transaction clears it.
 *
 * Steps: seed → A submits #1 with baalGas 20 M, votes YES → B submits #2 (prev = #1), votes YES →
 * grace → processProposal(#1) at 5 M reverts "not enough gas" → processProposal(#2) reverts
 * "prev!processed" → processProposal(#1) at 20,100,000 gas succeeds → #2 processes.
 */
import { encodeFunctionData } from "viem";

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
    step("A submits #1 'pay O 1 USDC' with baalGas = 20,000,000 (the maximum Baal accepts) and votes YES");
    const data1 = encodeProposalData([transferCall(mirror, O, SETTLEMENT_UNIT)]);
    const A = mirror.actors.A;
    const hash = await A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data1, 0, 20_000_000n, "A: pay O 1 USDC (baalGas 20M)"], account: A.account, chain: A.chain } as never);
    const receipt = await A.publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === "success", "submitProposal with baalGas 20,000,000 accepted");
    await warp(mirror, 1, "let votingStarts become past");
    await vote(mirror, "A", 1, true);
    step("B submits #2 'pay O 2 USDC' (prevProposalId = 1) and votes YES");
    const p2 = await propose(mirror, "B", [transferCall(mirror, O, 2n * SETTLEMENT_UNIT)], "B: pay O 2 USDC");
    await vote(mirror, "B", p2.id, true);
    await warpPastGrace(mirror, p2.id);
    logLine(LOG, `   #1 state ${await stateOf(mirror, 1)} (baalGas ${(await mirror.chain.publicClient.readContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "proposals", args: [1] } as never) as readonly unknown[])[6]}), #2 state ${await stateOf(mirror, p2.id)}`);

    step("processProposal(#1) with the harness/relay gas limit 5,000,000 -> reverts 'not enough gas'; #2 -> 'prev!processed'");
    const low = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], 5_000_000n);
    logLine(LOG, `   processProposal(#1) gas=5000000 status=${low.status}`);
    assert(low.status === "reverted", "#1 cannot be processed at 5 M gas");
    await expectRevert(simulate(mirror, "W", "baal", "processProposal", [p2.id, p2.data]), "prev!processed", "#2 is blocked behind #1");
    const relayGas = 5_600_000n;
    const relay = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], relayGas);
    logLine(LOG, `   processProposal(#1) gas=${relayGas} (relay: PROCESS_GAS + 600k) status=${relay.status}`);
    assert(relay.status === "reverted", "#1 cannot be processed at the relay's execute gas either");

    step("only a 20,400,000-gas transaction clears #1 (impossible under a 16,777,216 per-tx cap)");
    const high = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], 20_400_000n);
    const info1 = await proposalInfo(mirror, 1);
    logLine(LOG, `   processProposal(#1) gas=20400000 status=${high.status} gasUsed=${high.gasUsed} passed=${info1.status.passed} actionFailed=${info1.status.actionFailed}; O USDC ${fmtS(await usdcOf(mirror, O))}`);
    assert(high.status === "success" && info1.status.passed, "#1 processed with 20.1 M gas");
    const done2 = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [p2.id, p2.data], 5_000_000n);
    logLine(LOG, `   processProposal(#2) gas=5000000 status=${done2.status} state=${await stateOf(mirror, p2.id)}`);
    assert(done2.status === "success", "#2 processes once #1 is terminal");
    logLine(LOG, `   attacker cost: 1 share (1 USDC) + one submitProposal; effect: every later proposal waits until someone pays a 20.4 M gas tx (Base: ~$0.02 at 1 gwei); permanent if the chain caps tx gas below 20.4 M`);
    passed = true;
  } finally {
    verdict("GOV-05 baalGas 20M blocks the chain against the fixed 5M executor (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
