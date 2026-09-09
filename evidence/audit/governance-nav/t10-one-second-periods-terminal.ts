/**
 * GOV-07 — governance parameters can make the DAO permanently unable to decide: a Config to
 * votingPeriod 1 s / gracePeriod 1 s (documented in PARAMETERS.md) and, less documented, a
 * votingPeriod near uint32 max, after which every submitProposal reverts on checked overflow.
 * Exit still works in both states (accepted by principle; recorded with numbers).
 *
 * Steps: seed → Config(1, 1) passes and executes → B submits #2 at T; the next block is at T + 2
 * (Base block time) → state is already past voting: submitVote reverts "!voting"; with 0 YES the
 * proposal is Defeated; a repair Config cannot be voted either → ragequit still pays.
 * Snapshot variant: Config(votingPeriod = 2^32 - 1) → submitProposal reverts (Panic 0x11).
 */
import { encodeFunctionData } from "viem";

import { assert, boot, expectRevert, fmtS, processProposal, propose, ragequit, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, simulate, stateOf, step, transferCall, UNIT, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { encodeGovernanceConfig } from "../../../src/baal.js";
import { logLine, revertChain, snapshotChain } from "./audit-lib.js";

const LOG = "t10-one-second-periods-terminal";

/**
 * Run GOV-07 on a fresh mirror.
 *
 * Raises:
 *   Error: when the terminal state does not materialise as described.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t10");
  let passed = false;
  try {
    await seedMembers(mirror);
    const configCall = (votingPeriod: number, gracePeriod: number) => ({ to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "setGovernanceConfig", args: [encodeGovernanceConfig({ votingPeriod, gracePeriod, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: UNIT, minRetentionPercent: 66n })] }) });
    const snap = await snapshotChain(mirror);

    step("Config votingPeriod 1 s / gracePeriod 1 s passes (A, B YES) and executes");
    const p1 = await propose(mirror, "A", [configCall(1, 1)], "A: config 1s/1s");
    await vote(mirror, "A", p1.id, true);
    await vote(mirror, "B", p1.id, true);
    await warpPastGrace(mirror, p1.id);
    const done = await processProposal(mirror, "W", p1);
    assert(done.info.status.passed && !done.info.status.actionFailed, "config applied");
    logLine(LOG, `   votingPeriod ${await read<number>(mirror, "baal", "votingPeriod")} s, gracePeriod ${await read<number>(mirror, "baal", "gracePeriod")} s`);

    step("B submits #2 (repair back to 6 h / 6 h); the next block is 2 s later (Base block time)");
    const B = mirror.actors.B;
    const data2 = (await import("../../../src/baal.js")).encodeProposalData([configCall(21_600, 21_600)]);
    const hash = await B.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data2, 0, 0n, "B: repair 6h/6h"], account: B.account, chain: B.chain } as never);
    await B.publicClient.waitForTransactionReceipt({ hash });
    await warp(mirror, 2, "next Base block (+2 s)");
    const state = await stateOf(mirror, 2);
    logLine(LOG, `   #2 state one block later: ${state}`);
    await expectRevert(simulate(mirror, "B", "baal", "submitVote", [2, true]), "!voting", "no block can carry a vote");
    await warp(mirror, 1, "");
    logLine(LOG, `   #2 state after grace: ${await stateOf(mirror, 2)} (0 yes > 0 no is false): the repair is dead; every later proposal meets the same fate`);
    assert((await stateOf(mirror, 2)) === "Defeated", "repair defeated without a vote");
    const exit = await ragequit(mirror, "C");
    logLine(LOG, `   C still exits: paid ${fmtS(exit.paid)} USDC for ${exit.burned / UNIT} shares (exit is unaffected)`);

    step("snapshot variant: Config votingPeriod = 2^32 - 1 -> submitProposal reverts on checked uint32 overflow");
    await revertChain(mirror, snap);
    const p3 = await propose(mirror, "A", [configCall(2 ** 32 - 1, 1)], "A: config votingPeriod max");
    await vote(mirror, "A", p3.id, true);
    await vote(mirror, "B", p3.id, true);
    await warpPastGrace(mirror, p3.id);
    const done3 = await processProposal(mirror, "W", p3);
    assert(done3.info.status.passed && !done3.info.status.actionFailed, "config applied");
    logLine(LOG, `   votingPeriod ${await read<number>(mirror, "baal", "votingPeriod")} s`);
    let reverted = "";
    try {
      await simulate(mirror, "B", "baal", "submitProposal", [data2, 0, 0n, "B: anything"]);
    } catch (error) {
      const lines = (error as Error).message.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      reverted = lines.find((l) => /overflow|Panic|0x11/iu.test(l)) ?? lines.slice(0, 2).join(" | ");
    }
    logLine(LOG, `   submitProposal by a member now reverts: ${reverted}`);
    assert(reverted !== "", "no proposal can be submitted (uint32(block.timestamp) + votingPeriod overflows)");
    passed = true;
  } finally {
    verdict("GOV-07 1 s / 1 s and uint32-max periods are terminal for decisions, not for exit (accepted by principle, demonstrated)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
