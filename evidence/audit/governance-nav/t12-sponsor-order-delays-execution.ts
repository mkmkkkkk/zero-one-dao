/**
 * GOV-08 — sponsorship-order processing: a later proposal cannot execute before every earlier
 * sponsored proposal is terminal, so a Config that shortens the periods delays executions, and
 * one long-period proposal parked in Ready holds every later one (decision.md 2026-09-08).
 *
 * Steps: seed → #1 Config(1 h / 1 h) submitted under 6 h / 6 h → #2 'pay O 1 USDC' submitted
 * 11 h later, still under 6 h / 6 h (prev = #1; grace ends 23 h after #1's submission) → 12 h later #1 executes (periods now 1 h / 1 h) →
 * #3 'pay O 2 USDC' submitted under 1 h / 1 h, Ready after 2 h → processProposal(#3) reverts
 * "prev!processed" until #2 (Ready only 12 h after its own submission) is processed. Then a
 * variant: #2 is left unprocessed on purpose by its proposer; anyone else must process it first.
 */
import { encodeFunctionData } from "viem";

import { assert, boot, expectRevert, HOUR, processProposal, proposalInfo, propose, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulate, stateOf, step, transferCall, UNIT, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { encodeGovernanceConfig } from "../../../src/baal.js";
import { logLine } from "./audit-lib.js";

const LOG = "t12-sponsor-order-delays-execution";

/**
 * Run GOV-08 on a fresh mirror.
 *
 * Raises:
 *   Error: when the ordering constraint does not behave as described.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t12");
  let passed = false;
  try {
    await seedMembers(mirror);
    const O = mirror.actors.O.account.address;
    const config = { to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "setGovernanceConfig", args: [encodeGovernanceConfig({ votingPeriod: HOUR, gracePeriod: HOUR, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: UNIT, minRetentionPercent: 66n })] }) };
    step("#1 Config 1 h / 1 h submitted; 11 h later #2 'pay O 1 USDC' is submitted, still under 6 h / 6 h");
    const p1 = await propose(mirror, "A", [config], "A: config 1h/1h");
    await vote(mirror, "A", p1.id, true);
    await warp(mirror, 11 * HOUR, "11 h into #1's vote + grace");
    const p2 = await propose(mirror, "B", [transferCall(mirror, O, SETTLEMENT_UNIT)], "B: pay O 1 USDC (6 h / 6 h)");
    await vote(mirror, "A", p2.id, true);
    await warpPastGrace(mirror, p1.id);
    const done1 = await processProposal(mirror, "W", p1);
    assert(done1.info.status.passed && !done1.info.status.actionFailed, "#1 executed: periods are now 1 h / 1 h");
    logLine(LOG, `   votingPeriod ${await read<number>(mirror, "baal", "votingPeriod")} s; #2 state ${await stateOf(mirror, p2.id)} (graceEnds ${(await proposalInfo(mirror, p2.id)).graceEnds})`);
    step("#3 'pay O 2 USDC' submitted under 1 h / 1 h; Ready after 2 h but blocked behind #2");
    const p3 = await propose(mirror, "C", [transferCall(mirror, O, 2n * SETTLEMENT_UNIT)], "C: pay O 2 USDC");
    await vote(mirror, "C", p3.id, true);
    await warpPastGrace(mirror, p3.id);
    const i2 = await proposalInfo(mirror, p2.id);
    const i3 = await proposalInfo(mirror, p3.id);
    logLine(LOG, `   #3 state ${await stateOf(mirror, p3.id)} (graceEnds ${i3.graceEnds}); #2 state ${await stateOf(mirror, p2.id)} (graceEnds ${i2.graceEnds}, ${i2.graceEnds - i3.graceEnds} s later)`);
    await expectRevert(simulate(mirror, "W", "baal", "processProposal", [p3.id, p3.data]), "prev!processed", "#3 cannot execute before #2 is terminal");
    await warpPastGrace(mirror, p2.id);
    logLine(LOG, `   #2 now ${await stateOf(mirror, p2.id)}; still blocking #3 until someone processes it (permissionless, but nobody is obliged)`);
    await expectRevert(simulate(mirror, "W", "baal", "processProposal", [p3.id, p3.data]), "prev!processed", "#3 still blocked while #2 is Ready-but-unprocessed");
    await processProposal(mirror, "W", p2);
    const done3 = await processProposal(mirror, "W", p3);
    assert(done3.info.status.passed, "#3 executes once #2 is processed");
    logLine(LOG, `   #3 executed ${i2.graceEnds - i3.graceEnds} s later than its own grace end; cost to a delayer: one earlier proposal; remedy: anyone processes the earlier one (5 M gas unless GOV-05)`);
    passed = true;
  } finally {
    verdict("GOV-08 sponsorship-order processing delays later executions (holds as documented)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
