/**
 * GOV-04 — universal veto: any holder of 1 share defeats any proposal with a same-transaction
 * deposit + vote + ragequit (flash-loanable), by pushing the minRetention high-water mark up and
 * then pulling supply below 66% of it.
 *
 * Invariant that should hold (DESIGN.md §3.3): minRetention fails a proposal only when real
 * members leave; a member with 1 share cannot stop a proposal the others support.
 *
 * Why it fails: Baal raises maxTotalSharesAndLootAtVote to totalSupply() on EVERY vote (yes or
 * no), deposits are open and instant, ragequit is instant, and the retention check compares live
 * supply with that mark at processing.
 *
 * Steps: seed → contract V holds 1 share (1 USDC deposited before the proposal) → A proposes
 * "pay O 100 USDC", A and B YES (2000 vs 0) → V in ONE transaction: deposit 1600 USDC, vote NO
 * with its 1 share, ragequit the 1600 shares → grace → processProposal: passed = false. V's USDC
 * is unchanged (± rounding).
 */
import { assert, boot, fmt, fmtS, fund, processProposal, proposalInfo, propose, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, transferCall, UNIT, usdcOf, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { approveCall, depositCall, deployHelper, logLine, ragequitCall, runCalls, safeUsdc, sharesOf, totalShares, voteCall } from "./audit-lib.js";

const LOG = "t07-retention-veto-flash";

/**
 * Run GOV-04 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t07");
  let passed = false;
  try {
    await seedMembers(mirror);
    step("V = a contract holding exactly 1 share (deposited 1 USDC before the proposal exists)");
    const helper = await deployHelper(mirror, "D");
    const V = helper.address;
    await fund(mirror, "D", 5_000n * SETTLEMENT_UNIT);
    await mirror.actors.D.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [V, 3_000n * SETTLEMENT_UNIT], account: mirror.actors.D.account, chain: mirror.actors.D.chain } as never);
    await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, SETTLEMENT_UNIT), depositCall(mirror, SETTLEMENT_UNIT)], "V deposits 1 USDC");
    assert((await sharesOf(mirror, V)) === UNIT, "V holds 1 share");
    const vStart = await usdcOf(mirror, V);

    step("A proposes 'pay O 100 USDC'; A and B vote YES (2000 of 3051 shares)");
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, 100n * SETTLEMENT_UNIT)], "A: pay O 100 USDC");
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    const supply0 = await totalShares(mirror);

    step("V in ONE transaction: deposit 1600 USDC, vote NO (weight 1), ragequit the 1600 shares");
    const stake = 1_600n * SETTLEMENT_UNIT;
    const expectedShares = (stake * supply0) / (await safeUsdc(mirror));
    const receipt = await runCalls(mirror, "D", helper, [approveCall(mirror, mirror.dao.depositShaman, stake), depositCall(mirror, stake), voteCall(mirror, proposal.id, false), ragequitCall(mirror, V, expectedShares)], "V deposit + vote NO + ragequit");
    const info = await proposalInfo(mirror, proposal.id);
    const vEnd = await usdcOf(mirror, V);
    const supply1 = await totalShares(mirror);
    const hwm = supply0 + expectedShares;
    logLine(LOG, `   tx ${receipt.hash}: yes ${fmt(info.yesVotes)} no ${fmt(info.noVotes)}; high-water mark ${fmt(hwm)} (66% = ${fmt((hwm * 66n) / 100n)}), live supply ${fmt(supply1)}; V USDC ${fmtS(vStart)} -> ${fmtS(vEnd)} (net ${fmtS(vEnd - vStart)}), V shares ${fmt(await sharesOf(mirror, V))}`);
    assert(supply1 < (hwm * 66n) / 100n, "supply is below 66% of the high-water mark although no real member left");

    step("grace passes; processProposal -> defeated by minRetention; O unpaid");
    await warpPastGrace(mirror, proposal.id);
    const oBefore = await usdcOf(mirror, mirror.actors.O.account.address);
    const processed = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   passed=${processed.info.status.passed} actionFailed=${processed.info.status.actionFailed}; O USDC ${fmtS(oBefore)} -> ${fmtS(await usdcOf(mirror, mirror.actors.O.account.address))}; A+B YES 2000 shares overruled by V's 1 share + 1600 USDC for one transaction`);
    assert(!processed.info.status.passed, "the proposal did not pass");
    logLine(LOG, `   attacker cost: gas + rounding (${fmtS(vStart - vEnd)} USDC); repeatable against every proposal; requires 1 share held before the proposal's votingStarts`);
    passed = true;
  } finally {
    verdict("GOV-04 minRetention veto with same-tx deposit + vote + exit (finding demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
