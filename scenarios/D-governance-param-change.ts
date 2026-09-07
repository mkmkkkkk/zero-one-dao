/**
 * DESIGN.md §11 D: a governance parameter change by proposal (votingPeriod 6 h -> 1 h) takes effect;
 * the next proposal honors the 1 h voting period. The change goes through the Config template
 * (DESIGN.md §7.5): the voted multicall is [Baal.setGovernanceConfig(params), instance.start()] and
 * start() verifies Baal holds exactly the voted values.
 */
import { INITIAL_GOVERNANCE } from "../src/zeroOne.js";
import { assert, boot, describeAt, HOUR, processProposal, propose, proposalInfo, proposeTemplate, read, runIfMain, seedMembers, shutdown, stateOf, step, verdict, vote, warp, warpPastGrace } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-D");
  let passed = false;
  try {
    await seedMembers(mirror);
    assert(Number(await read<number>(mirror, "baal", "votingPeriod")) === 6 * HOUR, "initial votingPeriod is 6 h");

    step("A proposes a Config template instance (votingPeriod = 1 h, everything else unchanged): multicall = [Baal.setGovernanceConfig, instance.start()]");
    const newConfig = { ...INITIAL_GOVERNANCE, votingPeriod: 1 * HOUR };
    const change = await proposeTemplate(mirror, "A", { template: "Config", params: newConfig }, "A: votingPeriod 6h -> 1h");
    assert(change.calls.length === 2 && change.calls[0]!.to === mirror.dao.baal, "the voted multicall is [Baal.setGovernanceConfig(params), instance.start()]");
    assert((await describeAt(mirror, change.instance.address, "before vote")).status === "Pending", "Config instance is Pending");
    const changeInfo = await proposalInfo(mirror, change.id);
    assert(changeInfo.votingEnds - changeInfo.votingStarts === 6 * HOUR, "the change proposal itself runs under the old 6 h voting period");
    await vote(mirror, "A", change.id, true);
    await vote(mirror, "B", change.id, true);
    await warpPastGrace(mirror, change.id);
    const processed = await processProposal(mirror, "C", change);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "parameter change executed");
    assert((await describeAt(mirror, change.instance.address, "after vote")).status === "Complete", "Config instance verified Baal's parameters and is Complete");
    assert(Number(await read<number>(mirror, "baal", "votingPeriod")) === 1 * HOUR, "votingPeriod is now 1 h");
    assert(Number(await read<number>(mirror, "baal", "gracePeriod")) === 6 * HOUR, "gracePeriod still 6 h");
    assert((await read<bigint>(mirror, "baal", "minRetentionPercent")) === 66n, "minRetention still 66%");
    assert((await read<bigint>(mirror, "baal", "sponsorThreshold")) === INITIAL_GOVERNANCE.sponsorThreshold, "sponsorThreshold still 1 share");

    step("next proposal (B, text-only, empty multicall) honors the 1 h voting period");
    const next = await propose(mirror, "B", [], "B: text-only proposal after the change");
    const nextInfo = await proposalInfo(mirror, next.id);
    assert(nextInfo.votingEnds - nextInfo.votingStarts === 1 * HOUR, "votingEnds - votingStarts == 3600");
    assert(nextInfo.graceEnds - nextInfo.votingEnds === 6 * HOUR, "grace still 6 h");
    await vote(mirror, "A", next.id, true);
    await warp(mirror, HOUR - 2, "to 1 s before voting ends");
    assert((await stateOf(mirror, next.id)) === "Voting", "still Voting 1 s before the 1 h mark");
    await warp(mirror, 2, "past the 1 h mark");
    assert((await stateOf(mirror, next.id)) === "Grace", "in Grace right after 1 h (would still be Voting under 6 h)");
    await warpPastGrace(mirror, next.id);
    const processedNext = await processProposal(mirror, "A", next);
    assert(processedNext.info.status.passed && !processedNext.info.status.actionFailed, "the 1 h proposal processed");
    passed = true;
  } finally {
    verdict("D", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
