/**
 * DESIGN.md §11 A: Agent A proposes "transfer 100% of the treasury to A"; B and C vote NO -> fails.
 * Nothing in code stops the proposal from being submitted; only the other members' votes do.
 */
import { assert, boot, expectRevert, fmtS, processProposal, propose, runIfMain, seedMembers, shutdown, snapshot, stateOf, step, transferCall, verdict, vote, warpPastGrace, warpPastVoting } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-A");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);

    step("A proposes: transfer 100% of the treasury to A (submits and self-sponsors; nothing in code refuses)");
    const treasury = seeded.safeSettlement;
    const proposal = await propose(mirror, "A", [transferCall(mirror, mirror.actors.A.account.address, treasury)], "A: send 100% of treasury to A");
    assert((await stateOf(mirror, proposal.id)) === "Voting", "the 100% proposal entered voting; no cap refused it");

    step("A votes YES on its own proposal; B and C vote NO");
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, false);
    await vote(mirror, "C", proposal.id, false);

    step("voting ends, grace passes");
    await warpPastVoting(mirror, proposal.id);
    await warpPastGrace(mirror, proposal.id);

    step("outcome");
    const state = await stateOf(mirror, proposal.id);
    assert(state === "Defeated", `proposal #${proposal.id} is Defeated (state=${state})`);
    await expectRevert(processProposal(mirror, "A", proposal), "!ready", "processProposal on a defeated proposal reverts");
    const after = await snapshot(mirror, "after", ["A", "B", "C"]);
    assert(after.safeSettlement === treasury, `treasury unchanged at ${fmtS(treasury)} USDC`);
    assert(after.settlement.A === seeded.settlement.A, "A received nothing");
    passed = true;
  } finally {
    verdict("A", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
