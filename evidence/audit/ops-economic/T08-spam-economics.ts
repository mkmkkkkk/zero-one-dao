/**
 * Component 7, row ECO-05: proposal volume at sponsor threshold 1 share (1 USDC at NAV 1). W deposits 1
 * USDC and submits 20 self-sponsored proposals with baalGas at the phase 5 maximum and a failing action,
 * voting YES on each with its single share. Measures: gas per submit / vote / NO-vote / process; that a
 * YES-voted spam proposal that nobody processes blocks every later-sponsored proposal (prev!processed);
 * that processing it needs a gas limit above the relay's 8,000,000 execute cap, so a member must self-pay;
 * and that an unsponsored submission is free (proposalOffering 0). Expected: demonstrated; cost to block
 * the DAO's execution queue ≈ 20 × submit gas per 12 h.
 *
 * Phase 5 (ruling 1): submitProposal now refuses baalGas above 8,000,000, so the worst case a spammer can
 * set is 8,000,000 (this test) instead of 20,000,000, and clearing the queue fits in one Base block
 * (16,777,216) — which is the whole point of the cap (GOV-05). It does not make the queue free to clear.
 */
import { assert, deposit, fmt, fund, processProposal, propose, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulate, stateOf, step, transferCall, verdict, vote, warp, warpPastGrace, type Proposal } from "../../../scenarios/lib.js";
import { encodeProposalData } from "../../../src/baal.js";
import { bootAudit, mustRevert } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco05");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const W = mirror.actors.W;
    step("W deposits 1 USDC -> 1e18 shares = exactly the sponsor threshold");
    await fund(mirror, "W", 10n * SETTLEMENT_UNIT);
    const dep = await deposit(mirror, "W", SETTLEMENT_UNIT);
    assert(dep.sharesMinted === (await read<bigint>(mirror, "baal", "sponsorThreshold")), `W holds ${fmt(dep.sharesMinted)} shares = sponsorThreshold`);

    step("W submits 20 spam proposals (baalGas 8,000,000 = the phase 5 maximum; action = transfer above the treasury) and votes YES on each");
    const spam: Proposal[] = [];
    let submitGas = 0n;
    let voteGas = 0n;
    const data = encodeProposalData([transferCall(mirror, W.account.address, seeded.safeSettlement * 1_000n)]);
    for (let i = 0; i < 20; i += 1) {
      const before = await read<number>(mirror, "baal", "proposalCount");
      // Registration may cross a timestamp boundary after estimation and write a fresh supply
      // snapshot. Give this fixture headroom, and never count a reverted submission as a record.
      const hash = await W.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data, 0, 8_000_000n, `spam ${i}`], account: W.account, chain: W.chain, gas: 1_000_000n });
      const receipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash });
      assert(receipt.status === "success" && Number(await read<number>(mirror, "baal", "proposalCount")) === Number(before) + 1, `spam submit #${Number(before) + 1} status=${receipt.status} gas=${receipt.gasUsed} tx=${hash}`);
      submitGas += receipt.gasUsed;
      spam.push({ id: Number(before) + 1, data, submit: { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed } });
    }
    await warp(mirror, 1, "let votingStarts become past");
    for (const p of spam) voteGas += (await vote(mirror, "W", p.id, true)).gasUsed;
    console.log(`   20 submits: ${submitGas} gas total (${submitGas / 20n} each); 20 YES votes: ${voteGas} gas (${voteGas / 20n} each); public gas price, L1 data fee and USD cost: unknown`);
    const noVote = await vote(mirror, "B", spam[0]!.id, false);
    console.log(`   one NO vote by B costs ${noVote.gasUsed} gas: defending 20 spam proposals costs each awake member ~${noVote.gasUsed * 20n} gas per batch`);

    step("A's legitimate proposal sponsored after the spam cannot execute until every earlier YES-voted spam is processed");
    const legit = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, 10n * SETTLEMENT_UNIT)], "A: pay O 10");
    await vote(mirror, "A", legit.id, true);
    await warpPastGrace(mirror, legit.id);
    assert((await stateOf(mirror, legit.id)) === "Ready", "A's proposal is Ready");
    assert((await stateOf(mirror, spam[19]!.id)) === "Ready", `spam #${spam[19]!.id} is Ready too (yes 1 > no 0; B's NO defeated only #${spam[0]!.id})`);
    await mustRevert(simulate(mirror, "A", "baal", "processProposal", [legit.id, legit.data]), "processProposal(legit) reverts prev!processed");
    await mustRevert(mirror.chain.publicClient.simulateContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "processProposal", args: [spam[1]!.id, spam[1]!.data], account: mirror.actors.A.account, gas: 5_000_000n }), "processProposal(spam) with the mirror/relay 5,000,000 gas limit reverts 'not enough gas' (baalGas 8,000,000)");
    let clearGas = 0n;
    for (const p of spam.slice(1)) {
      const hash = await mirror.actors.A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "processProposal", args: [p.id, p.data], account: mirror.actors.A.account, chain: mirror.actors.A.chain, gas: 9_000_000n });
      const receipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash });
      assert(receipt.status === "success", `spam clear #${p.id} status=${receipt.status} tx=${hash}`);
      clearGas += receipt.gasUsed;
    }
    console.log(`   clearing 19 spam proposals: ${clearGas} gas used (${clearGas / 19n} each) but each needs a gas LIMIT above baalGas 8,000,000 (Baal.processProposal requires gasleft() >= baalGas): above the relay execute cap (8,000,000; relay/server.ts) and the mirror PROCESS_GAS; a member must self-pay with a raised limit, and one Base block (16,777,216) now holds two such clears (phase 5 ruling 1)`);
    const done = await processProposal(mirror, "A", legit);
    assert(done.info.status.passed && !done.info.status.actionFailed, "A's proposal executes only after the queue is cleared");

    step("unsponsored submissions are free: proposalOffering = 0");
    const before = await read<number>(mirror, "baal", "proposalCount");
    const hash = await mirror.actors.D.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data, 0, 0n, "unsponsored junk"], account: mirror.actors.D.account, chain: mirror.actors.D.chain, gas: 1_000_000n });
    const receipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === "success", `unsponsored submit status=${receipt.status} tx=${hash}`);
    assert((await read<number>(mirror, "baal", "proposalCount")) === Number(before) + 1 && (await stateOf(mirror, Number(before) + 1)) === "Submitted", `D (0 shares) submitted #${Number(before) + 1} for ${receipt.gasUsed} gas; it sits in Submitted forever (no expiry, no cancel)`);
    passed = true;
  } finally {
    verdict("ECO-05 spam-economics", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
