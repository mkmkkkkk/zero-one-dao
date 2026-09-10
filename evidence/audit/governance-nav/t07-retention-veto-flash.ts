import { settleRetention } from '../../../src/retention.js';
/**
 * GOV-04 (phase 5, FLIPPED) — no flash veto: a holder of 1 share cannot defeat a proposal with a
 * same-transaction deposit + vote + ragequit.
 *
 * Invariant (DESIGN.md §3.3): minRetention fails a proposal only when members who were in at
 * votingStarts leave; a member with 1 share cannot stop a proposal the others support.
 *
 * Fix (decision.md phase 5 ruling 2): the Zero One Baal fork compares NavShareToken.exitedSince(id)
 * (the sum of each account's positive balance deficit relative to votingStarts) with 34% of the supply at votingStarts. There is no
 * high-water mark to push up, and V's 1600 fresh shares are not "exits".
 *
 * Steps: seed → contract V holds 1 share → A proposes "pay O 100 USDC", A and B YES (2000 vs 0) → V in
 * ONE transaction: deposit 1600 USDC, vote NO with weight 1, ragequit the 1600 shares → exitedSince = 0
 * → grace → processProposal: passed = true, O paid. V's USDC unchanged (± rounding).
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
    await settleRetention(mirror.actors.W, mirror.dao.shares, proposal.id);
    const exited = (await mirror.chain.publicClient.readContract({ address: mirror.dao.shares, abi: mirror.abi.shares, functionName: "exitedSince", args: [proposal.id] } as never)) as readonly [bigint, bigint];
    logLine(LOG, `   tx ${receipt.hash}: yes ${fmt(info.yesVotes)} no ${fmt(info.noVotes)}; supply at votingStarts ${fmt(exited[1])}, live supply ${fmt(supply1)}; exitedSince(#${proposal.id}) = ${fmt(exited[0])} (V's ${fmt(expectedShares)} burned shares were minted after votingStarts: not counted); V USDC ${fmtS(vStart)} -> ${fmtS(vEnd)} (net ${fmtS(vEnd - vStart)}), V shares ${fmt(await sharesOf(mirror, V))}`);
    assert(exited[0] === 0n && exited[1] === supply0, "exitedSince counts none of V's flash shares; the retention base is the supply at votingStarts");
    assert(supply1 === supply0, "live supply is back where it was");

    step("grace passes; processProposal -> passed; O paid");
    await warpPastGrace(mirror, proposal.id);
    const oBefore = await usdcOf(mirror, mirror.actors.O.account.address);
    const processed = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   passed=${processed.info.status.passed} actionFailed=${processed.info.status.actionFailed}; O USDC ${fmtS(oBefore)} -> ${fmtS(await usdcOf(mirror, mirror.actors.O.account.address))}; A+B YES 2000 shares stand against V's 1 share + 1600 USDC for one transaction`);
    assert(processed.info.status.passed && !processed.info.status.actionFailed && (await usdcOf(mirror, mirror.actors.O.account.address)) === oBefore + 100n * SETTLEMENT_UNIT, "the proposal passed and paid O");
    logLine(LOG, `   V spent gas + rounding (${fmtS(vStart - vEnd)} USDC) for nothing`);
    passed = true;
  } finally {
    verdict("GOV-04 same-tx deposit + vote + exit cannot veto (phase 5 retention counts only shares held at votingStarts; fixed)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
