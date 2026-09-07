/**
 * DESIGN.md §11 D: a governance parameter change by proposal (votingPeriod 6 h -> 1 h on the mirror;
 * 120 s -> 60 s on the live testnet, see lib.ts T) takes effect; the next proposal honors the new period. The change goes through the Config template
 * (DESIGN.md §7.5): the voted multicall is [Baal.setGovernanceConfig(params), instance.start()] and
 * start() verifies Baal holds exactly the voted values.
 */
import { INITIAL_GOVERNANCE } from "../src/zeroOne.js";
import { assert, boot, describeAt, now, processProposal, propose, proposalInfo, proposeTemplate, read, runIfMain, seedMembers, shutdown, stateOf, step, T, verdict, vote, warp, warpPastGrace } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-D");
  let passed = false;
  try {
    await seedMembers(mirror);
    // Mirror: 6 h / 6 h (docs/PARAMETERS.md). Live testnet: 120 s / 120 s so the scenario finishes in real time.
    const initial = mirror.dao.params.governance;
    assert(Number(await read<number>(mirror, "baal", "votingPeriod")) === initial.votingPeriod, `initial votingPeriod is ${initial.votingPeriod} s`);

    step(`A proposes a Config template instance (votingPeriod = ${T.hour} s, everything else unchanged): multicall = [Baal.setGovernanceConfig, instance.start()]`);
    const newConfig = { ...INITIAL_GOVERNANCE, ...initial, votingPeriod: T.hour };
    const change = await proposeTemplate(mirror, "A", { template: "Config", params: newConfig }, `A: votingPeriod ${initial.votingPeriod}s -> ${T.hour}s`);
    assert(change.calls.length === 2 && change.calls[0]!.to === mirror.dao.baal, "the voted multicall is [Baal.setGovernanceConfig(params), instance.start()]");
    assert((await describeAt(mirror, change.instance.address, "before vote")).status === "Pending", "Config instance is Pending");
    const changeInfo = await proposalInfo(mirror, change.id);
    assert(changeInfo.votingEnds - changeInfo.votingStarts === initial.votingPeriod, `the change proposal itself runs under the old ${initial.votingPeriod} s voting period`);
    await vote(mirror, "A", change.id, true);
    await vote(mirror, "B", change.id, true);
    await warpPastGrace(mirror, change.id);
    const processed = await processProposal(mirror, "C", change);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "parameter change executed");
    assert((await describeAt(mirror, change.instance.address, "after vote")).status === "Complete", "Config instance verified Baal's parameters and is Complete");
    assert(Number(await read<number>(mirror, "baal", "votingPeriod")) === T.hour, `votingPeriod is now ${T.hour} s`);
    assert(Number(await read<number>(mirror, "baal", "gracePeriod")) === initial.gracePeriod, `gracePeriod still ${initial.gracePeriod} s`);
    assert((await read<bigint>(mirror, "baal", "minRetentionPercent")) === 66n, "minRetention still 66%");
    assert((await read<bigint>(mirror, "baal", "sponsorThreshold")) === INITIAL_GOVERNANCE.sponsorThreshold, "sponsorThreshold still 1 share");

    step(`next proposal (B, text-only, empty multicall) honors the ${T.hour} s voting period`);
    const next = await propose(mirror, "B", [], "B: text-only proposal after the change");
    const nextInfo = await proposalInfo(mirror, next.id);
    assert(nextInfo.votingEnds - nextInfo.votingStarts === T.hour, `votingEnds - votingStarts == ${T.hour}`);
    assert(nextInfo.graceEnds - nextInfo.votingEnds === initial.gracePeriod, `grace still ${initial.gracePeriod} s`);
    await vote(mirror, "A", next.id, true);
    const nowTs = Number(await now(mirror));
    await warp(mirror, nextInfo.votingEnds - T.margin - nowTs, `to ${T.margin} s before voting ends`);
    assert((await stateOf(mirror, next.id)) === "Voting", `still Voting ${T.margin} s before the ${T.hour} s mark`);
    await warp(mirror, T.margin + 1, `past the ${T.hour} s mark`);
    assert((await stateOf(mirror, next.id)) === "Grace", `in Grace right after ${T.hour} s (would still be Voting under ${initial.votingPeriod} s)`);
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
