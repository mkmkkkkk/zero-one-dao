/**
 * GOV-06 — minRetention 66 boundary: exactly 34% of the high-water mark leaving keeps a proposal
 * alive; one more wei-share defeats it. Holds as documented (PARAMETERS.md), recorded with numbers.
 *
 * Steps: seed (3050 shares) → A proposes, A YES → grace → on a snapshot B (1000) and C (37) ragequit 1037 shares
 * (supply 2013 = floor(3050 x 66 / 100)) → processed passed = true; revert → B and C ragequit
 * 1037 shares + 1 wei (supply 2013 - 1 wei) → processed passed = false.
 */
import { assert, boot, fmt, processProposal, propose, ragequit, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, transferCall, UNIT, verdict, vote, warpPastVoting } from "../../../scenarios/lib.js";
import { logLine, revertChain, snapshotChain, totalShares } from "./audit-lib.js";

const LOG = "t09-minretention-boundary";

/**
 * Run GOV-06 on a fresh mirror.
 *
 * Raises:
 *   Error: when the boundary differs from floor(HWM x 66 / 100).
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t09");
  let passed = false;
  try {
    await seedMembers(mirror);
    const hwm = await totalShares(mirror);
    const floor = (hwm * 66n) / 100n;
    step(`A proposes 'pay O 1 USDC' and votes YES; high-water mark ${fmt(hwm)} shares, 66% floor ${fmt(floor)}`);
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, SETTLEMENT_UNIT)], "A: pay O 1 USDC");
    await vote(mirror, "A", proposal.id, true);
    await warpPastVoting(mirror, proposal.id);
    const snap = await snapshotChain(mirror);
    step("B ragequits 1000 shares and C exactly hwm - floor - 1000 = 37 shares (34.0% in total): supply == floor -> still executes");
    await ragequit(mirror, "B");
    await ragequit(mirror, "C", hwm - floor - 1_000n * UNIT);
    const s1 = await totalShares(mirror);
    const { increaseTime } = await import("../../../src/onchain.js");
    await increaseTime(mirror.actors.F, 6 * 3600 + 2);
    const alive = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   supply ${fmt(s1)} == floor ${fmt(floor)} -> passed=${alive.info.status.passed}`);
    assert(s1 === floor && alive.info.status.passed, "supply == 66% of HWM keeps the proposal alive");
    await revertChain(mirror, snap);
    step("B 1000 shares and C 37 shares + 1 wei: supply == floor - 1 wei -> defeated");
    await ragequit(mirror, "B");
    await ragequit(mirror, "C", hwm - floor - 1_000n * UNIT + 1n);
    const s2 = await totalShares(mirror);
    await increaseTime(mirror.actors.F, 6 * 3600 + 2);
    const dead = await processProposal(mirror, "W", proposal);
    logLine(LOG, `   supply ${fmt(s2)} == floor - 1 wei -> passed=${dead.info.status.passed}`);
    assert(s2 === floor - 1n && !dead.info.status.passed, "one wei-share below 66% of HWM defeats the proposal");
    logLine(LOG, `   boundary = floor(HWM x 66 / 100) = ${floor} wei-shares; the exit that trips it may come from any member, at any time before processProposal (including the proposer's own re-deposit reversing it, see GOV-03)`);
    passed = true;
  } finally {
    verdict("GOV-06 minRetention boundary (holds as documented)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
