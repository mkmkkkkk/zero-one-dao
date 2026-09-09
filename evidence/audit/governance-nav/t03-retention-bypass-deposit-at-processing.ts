/**
 * GOV-03 (phase 5, FLIPPED) — minRetention (66%) cannot be bypassed by a deposit in the same
 * transaction as processProposal.
 *
 * Invariant (DESIGN.md §3.3, constitution): if more than 34% of the shares that existed when voting
 * started exit during vote + grace the proposal fails, which protects the members who stayed.
 *
 * Fix (decision.md phase 5 ruling 2): the Zero One Baal fork replaces the high-water-mark check with
 * NavShareToken.exitedSince(id) <= 34% x supply at votingStarts, where exitedSince counts shares that
 * existed at votingStarts and were burned since. Deposits move neither side: M's refill deposit mints
 * shares but cannot un-burn B's and C's.
 *
 * Steps: seed → contract member M (1000 USDC deposit) → M proposes "Safe pays M 2000 USDC", votes YES →
 * B and C (2000 of 4050 shares = 49.4%) ragequit during grace → control: plain processProposal fails →
 * attack: M deposits the refill amount and processes in ONE transaction → still passed = false, the
 * deposit stays in the Safe at NAV, F and A (asleep) lose nothing.
 */
import { assert, boot, fmt, fmtS, fund, processProposal, proposalInfo, ragequit, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, snapshot, stateOf, step, transferCall, usdcOf, verdict, warp, warpPastGrace, warpPastVoting } from "../../../scenarios/lib.js";
import { approveCall, depositCall, deployHelper, logLine, pct2, processCall, revertChain, runCalls, safeUsdc, sharesOf, snapshotChain, submitCall, totalShares, transferUsdcCall, voteCall } from "./audit-lib.js";

const LOG = "t03-retention-bypass-deposit-at-processing";

/**
 * Run GOV-03 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t03");
  let passed = false;
  try {
    await seedMembers(mirror);
    step("attacker M = a contract member: D funds it with 2000 USDC, it deposits 1000 USDC at NAV");
    const helper = await deployHelper(mirror, "D");
    const M = helper.address;
    await fund(mirror, "D", 2_000n * SETTLEMENT_UNIT);
    await mirror.actors.D.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [M, 2_000n * SETTLEMENT_UNIT], account: mirror.actors.D.account, chain: mirror.actors.D.chain } as never);
    await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, 1_000n * SETTLEMENT_UNIT), depositCall(mirror, 1_000n * SETTLEMENT_UNIT)], "M approve + deposit 1000 USDC");
    const mStart = await usdcOf(mirror, M);
    logLine(LOG, `   M shares ${fmt(await sharesOf(mirror, M))} of ${fmt(await totalShares(mirror))}; Safe ${fmtS(await safeUsdc(mirror))} USDC; M USDC ${fmtS(mStart)}`);

    step("M proposes 'Safe pays M 2000 USDC' (self-sponsored) and votes YES; nobody votes NO");
    const pay = 2_000n * SETTLEMENT_UNIT;
    const submit = submitCall(mirror, [transferCall(mirror, M, pay)], "M: pay M 2000 USDC");
    await runCalls(mirror, "D", helper, [submit], "M submitProposal");
    const id = Number(await mirror.chain.publicClient.readContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "proposalCount" } as never));
    await warp(mirror, 1, "let votingStarts become past");
    await runCalls(mirror, "D", helper, [voteCall(mirror, id, true)], `M votes YES on #${id}`);
    const proposal = { id, data: submit.proposalData, submit: { hash: "0x" as const, blockNumber: 0n, gasUsed: 0n } };
    const hwm = await totalShares(mirror);
    logLine(LOG, `   #${id}: yes ${fmt((await proposalInfo(mirror, id)).yesVotes)} no 0; supply at votingStarts ${fmt(hwm)} shares; 34% = ${fmt((hwm * 34n) / 100n)} may exit`);

    step("B and C disagree with their feet: both ragequit during grace (2000 of 4050 shares = 49.4% > 34%)");
    await warpPastVoting(mirror, id);
    await ragequit(mirror, "B");
    await ragequit(mirror, "C");
    const supplyAfterExits = await totalShares(mirror);
    const safeAfterExits = await safeUsdc(mirror);
    logLine(LOG, `   supply ${fmt(supplyAfterExits)} < ${fmt((hwm * 66n) / 100n)} (66% of HWM): the proposal should now fail; Safe ${fmtS(safeAfterExits)} USDC`);
    assert(supplyAfterExits < (hwm * 66n) / 100n, "exits exceed 34% of the high-water mark");
    await warpPastGrace(mirror, id);
    assert((await stateOf(mirror, id)) === "Ready", "state is Ready (yes > no); retention is checked inside processProposal");

    step("control (snapshot): plain processProposal -> passed = false, nothing moves");
    const snap = await snapshotChain(mirror);
    const plain = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   control: passed=${plain.info.status.passed} actionFailed=${plain.info.status.actionFailed} Safe ${fmtS(await safeUsdc(mirror))} M USDC ${fmtS(await usdcOf(mirror, M))}`);
    assert(!plain.info.status.passed, "control: minRetention defeats the proposal");
    await revertChain(mirror, snap);

    step("attack: M deposits what would have lifted supply back to 66% of the old HWM and processes in the SAME transaction");
    const need = (hwm * 66n) / 100n - supplyAfterExits; // shares
    const price = safeAfterExits; // NAV: shares = amount * supply / treasury
    const amount = (need * price + supplyAfterExits - 1n) / supplyAfterExits + 1n; // ceil + 1 unit
    const exited = (await mirror.chain.publicClient.readContract({ address: mirror.dao.shares, abi: mirror.abi.shares, functionName: "exitedSince", args: [id] } as never)) as readonly [bigint, bigint];
    logLine(LOG, `   exitedSince(#${id}) = ${fmt(exited[0])} of ${fmt(exited[1])} shares at votingStarts (${pct2(exited[0], exited[1])} > 34%)`);
    const receipt = await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, amount), depositCall(mirror, amount), processCall(mirror, id, submit.proposalData)], `M deposit ${fmtS(amount)} USDC + processProposal #${id}`);
    const info = await proposalInfo(mirror, id);
    const mEnd = await usdcOf(mirror, M);
    const safeEnd = await safeUsdc(mirror);
    const supplyEnd = await totalShares(mirror);
    logLine(LOG, `   one tx ${receipt.hash}: processed=${info.status.processed} passed=${info.status.passed} actionFailed=${info.status.actionFailed}; Safe ${fmtS(safeAfterExits)} -> ${fmtS(safeEnd)} USDC; M USDC ${fmtS(mStart)} -> ${fmtS(mEnd)} (net ${fmtS(mEnd - mStart)}; holds ${fmt(await sharesOf(mirror, M))} shares)`);
    assert(info.status.processed && !info.status.passed, "the proposal was processed as not passed: > 34% of the shares at votingStarts had exited and the deposit changes nothing");
    assert(safeEnd === safeAfterExits + amount && mEnd === mStart - amount, "M's deposit went into the Safe at NAV and no payment left it");
    for (const actor of ["F", "A"] as const) {
      const shares = await sharesOf(mirror, mirror.actors[actor].account.address);
      const before = (shares * safeAfterExits) / supplyAfterExits;
      const after = (shares * safeEnd) / supplyEnd;
      logLine(LOG, `   sleeping ${actor}: ${fmt(shares)} shares worth ${fmtS(before)} -> ${fmtS(after)} USDC`);
      assert(after + 1n >= before, `${actor} (asleep) lost nothing beyond rounding`);
    }
    await snapshot(mirror, "end", ["F", "A", "B", "C"]);
    passed = true;
  } finally {
    verdict("GOV-03 minRetention cannot be bypassed by deposit + process in one transaction (phase 5 retention rule; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
