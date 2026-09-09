/**
 * Audit rows T-7, T-8, T-9 (ProjectProposal tranche edges and ConfigProposal NotApplied / terminal
 * configurations, security-audit component 4) on the anvil mirror — phase 5 (decision.md phase 5
 * ruling 10).
 *
 * T-7 FLIPPED: after a Project's deadline `release(i)` and `confirm(i)` revert `DeadlinePassed`; only
 *     `end()` applies, so a due-but-unreleased tranche always returns to the Safe (no transaction race).
 * T-8 documented: `amend` on a Pending Project reverts Overcommitted (held() == 0); TEMPLATES.md says
 *     "Running" for Project amend. Shown, asserted as the documented behaviour.
 * T-9 documented (ruling: no on-chain cap on Config values, rejected): a period of 0 fails atomically
 *     (NotApplied); quorumPercent > 100 is accepted and makes the DAO terminal for collective action;
 *     ragequit still works. Shown, asserted as the documented behaviour; the relay's /me flags such
 *     Config proposals (phase 5 stage C).
 *
 * Run: `npx tsx evidence/audit/work-templates/project-config-edges.ts` (exit code 1 = an invariant is violated).
 */
import { decodeErrorResult, encodeFunctionData, type Hex } from "viem";

import {
  assert,
  boot,
  DAY,
  describeAt,
  expectRevert,
  fmt,
  fmtS,
  now,
  processProposal,
  proposeTemplate,
  ragequit,
  read,
  runIfMain,
  seedMembers,
  sendAt,
  SETTLEMENT_UNIT,
  shutdown,
  simulateAt,
  stateOf,
  step,
  usdcOf,
  vote,
  warp,
  warpPastGrace,
} from "../../../scenarios/lib.js";
import { deployTemplate, encodeAmendParams, type ProjectParams, type Tranche } from "../../../src/proposals.js";
import { INITIAL_GOVERNANCE } from "../../../src/zeroOne.js";
import { finish, invariant } from "./_harness.js";

/**
 * Run the Project / Config edge demonstrations.
 *
 * Returns:
 *   Nothing; prints receipts, numbers and the verdict block.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-project-config");
  try {
    await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const C = mirror.actors.C.account.address;
    const O = mirror.actors.O.account.address;

    // ---------------------------------------------------------------- T-7 release vs end after the deadline
    step("T-7: Project P1: tranche 0 = 300 USDC by date (due day 2), tranche 1 = 200 USDC by verifiers B, C; deadline day 3; voted and started");
    const start = await now(mirror);
    const t0: Tranche = { amount: 300n * SETTLEMENT_UNIT, releaseType: "date", releaseAt: start + BigInt(2 * DAY), verifiers: [], threshold: 0 };
    const t1: Tranche = { amount: 200n * SETTLEMENT_UNIT, releaseType: "verifiers", releaseAt: 0n, verifiers: [B, C], threshold: 2 };
    const deadline = start + BigInt(3 * DAY);
    const p1 = await proposeTemplate(mirror, "A", { template: "Project", params: { tranches: [t0, t1], deadline } }, "A: P1 two tranches, 3 d deadline");
    await vote(mirror, "A", p1.id, true);
    await vote(mirror, "B", p1.id, true);
    await warpPastGrace(mirror, p1.id);
    const processed = await processProposal(mirror, "D", p1);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "P1 funded (500) and Running");
    const project = p1.instance.address;
    step("T-7: nobody calls release(0) on day 2; the deadline passes; release(0) and confirm(1) revert DeadlinePassed, only end() applies");
    await warp(mirror, Number(deadline + 1n - (await now(mirror))), "past the project deadline");
    let releaseOk = true;
    let confirmOk = true;
    let endOk = true;
    try { await simulateAt(mirror, "A", project, "project", "release", [0]); } catch { releaseOk = false; }
    try { await simulateAt(mirror, "B", project, "project", "confirm", [1]); } catch { confirmOk = false; }
    try { await simulateAt(mirror, "W", project, "project", "end", []); } catch { endOk = false; }
    console.log(`   at deadline + 1: release(0) by the operator ${releaseOk ? "succeeds" : "reverts"}; confirm(1) by a verifier ${confirmOk ? "succeeds" : "reverts"}; end() by anyone ${endOk ? "succeeds" : "reverts"}`);
    invariant("T-7", !releaseOk && !confirmOk && endOk, "after the deadline exactly one of {pay the operator, return to the Safe} is possible for a due tranche (end() only)");
    await expectRevert(simulateAt(mirror, "A", project, "project", "release", [0]), "DeadlinePassed", "release(0) after the deadline reverts DeadlinePassed");
    await expectRevert(simulateAt(mirror, "B", project, "project", "confirm", [1]), "DeadlinePassed", "confirm(1) after the deadline reverts DeadlinePassed");
    const aBefore = await usdcOf(mirror, A);
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "W", project, "project", "end", [], "W end()");
    const paidLate = (await usdcOf(mirror, A)) - aBefore;
    const returned = (await usdcOf(mirror, mirror.dao.safe)) - safeBefore;
    console.log(`   end(): ${fmtS(returned)} USDC (both unreleased tranches) back to the Safe; operator A received ${fmtS(paidLate)} USDC after the deadline; ${(await describeAt(mirror, project, "P1")).status}`);
    invariant("T-7", paidLate === 0n && returned === 500n * SETTLEMENT_UNIT, `no tranche is paid after the project deadline (paid ${fmtS(paidLate)} USDC; ${fmtS(returned)} USDC returned)`);

    step("T-7: a Project whose deadline has already come cannot start (the funding multicall fails atomically, nothing moves)");
    const late = await proposeTemplate(mirror, "A", { template: "Project", params: { tranches: [{ ...t0, releaseAt: 0n }], deadline: (await now(mirror)) + BigInt(2 * DAY) } }, "A: P-late, deadline before its own grace ends");
    await vote(mirror, "A", late.id, true);
    await vote(mirror, "B", late.id, true);
    await warpPastGrace(mirror, late.id);
    await warp(mirror, 2 * DAY, "past the late project's deadline before processing");
    const safeBeforeLate = await usdcOf(mirror, mirror.dao.safe);
    const lateResult = await processProposal(mirror, "D", late);
    invariant("T-7", lateResult.info.status.passed && lateResult.info.status.actionFailed && (await usdcOf(mirror, mirror.dao.safe)) === safeBeforeLate && (await describeAt(mirror, late.instance.address, "P-late")).status === "Pending", "a Project started after its deadline reverts DeadlinePassed inside start(): actionFailed, the Safe keeps the budget");

    // ---------------------------------------------------------------- T-8 amend while Pending
    step("T-8: a Pending Project cannot be amended by the Safe (eth_call from the Safe): Overcommitted(scheduled, held = 0)");
    const p2Params: ProjectParams = { tranches: [{ ...t0, releaseAt: 0n }], deadline: 0n };
    const p2 = await deployTemplate(mirror.actors.A, mirror.dao, { template: "Project", params: p2Params }, A);
    const amendData = encodeFunctionData({ abi: mirror.abi.project, functionName: "amend", args: [encodeAmendParams({ template: "Project", params: { tranches: [{ ...t0, releaseAt: 0n, amount: 100n * SETTLEMENT_UNIT }], deadline: 0n } })] });
    let amendError = "no revert";
    try {
      await mirror.chain.publicClient.call({ account: mirror.dao.safe, to: p2.address, data: amendData });
    } catch (error) {
      const withData = (error as { walk?: (fn: (e: unknown) => boolean) => { data?: Hex } | null }).walk?.((e) => typeof (e as { data?: unknown }).data === "string");
      amendError = withData?.data ? decodeErrorResult({ abi: mirror.abi.project, data: withData.data }).errorName : (error instanceof Error ? error.message.split("\n")[0]! : String(error));
    }
    console.log(`   Safe -> amend(Pending P2 @ ${p2.address}) : ${amendError}`);
    invariant("T-8", amendError === "Overcommitted", `Project amend while Pending reverts Overcommitted (a Pending instance holds 0): documented in TEMPLATES.md (Project amend: Running); observed ${amendError}`);

    // ---------------------------------------------------------------- T-9 Config
    step("T-9a: Config with gracePeriod 0: Baal keeps the old value, start() reverts NotApplied, the whole action fails; nothing applied");
    const graceBefore = await read<number>(mirror, "baal", "gracePeriod");
    const c0 = await proposeTemplate(mirror, "A", { template: "Config", params: { ...INITIAL_GOVERNANCE, gracePeriod: 0 } }, "A: grace 0");
    await vote(mirror, "A", c0.id, true);
    await vote(mirror, "B", c0.id, true);
    await warpPastGrace(mirror, c0.id);
    const r0 = await processProposal(mirror, "D", c0);
    invariant("T-9", r0.info.status.passed && r0.info.status.actionFailed && (await read<number>(mirror, "baal", "gracePeriod")) === graceBefore, `grace 0 -> actionFailed=${r0.info.status.actionFailed}, gracePeriod still ${graceBefore} (documented; holds)`);

    step("T-9b: Config with quorumPercent 101 (Baal only checks minRetention <= 100): A and B vote YES; it applies");
    const c1 = await proposeTemplate(mirror, "A", { template: "Config", params: { ...INITIAL_GOVERNANCE, quorumPercent: 101n } }, "A: quorum 101%");
    await vote(mirror, "A", c1.id, true);
    await vote(mirror, "B", c1.id, true);
    await warpPastGrace(mirror, c1.id);
    const r1 = await processProposal(mirror, "D", c1);
    const quorum = await read<bigint>(mirror, "baal", "quorumPercent");
    console.log(`   quorumPercent now ${quorum}; Config instance ${(await describeAt(mirror, c1.instance.address, "C1")).status}`);
    invariant("T-9", quorum === 101n, `Baal accepts a quorum above 100% (applied quorumPercent = ${quorum}): no on-chain cap by ruling; disclosed in PARAMETERS and flagged by the relay's /me`);

    step("T-9b: a Payment (10 USDC to O) with 100% of shares voting YES is processed as not passed; a repair Config (quorum 0) with 100% YES fails the same way");
    const pay = await proposeTemplate(mirror, "A", { template: "Payment", params: { recipients: [O], amounts: [10n * SETTLEMENT_UNIT] } }, "A: pay O 10");
    for (const actor of ["A", "B", "C", "F"] as const) await vote(mirror, actor, pay.id, true);
    await warpPastGrace(mirror, pay.id);
    const rp = await processProposal(mirror, "D", pay);
    const supply = await read<bigint>(mirror, "shares", "totalSupply");
    console.log(`   payment: yes ${fmt(rp.info.yesVotes)} of ${fmt(supply)} shares (100%), passed=${rp.info.status.passed}, state ${await stateOf(mirror, pay.id)}, O got ${fmtS(await usdcOf(mirror, O))} USDC`);
    invariant("T-9", !rp.info.status.passed, "with quorum 101% a proposal approved by 100% of shares is processed as not passed (yes*100 < 101*supply for every vote): terminal for collective action, documented");
    const repair = await proposeTemplate(mirror, "A", { template: "Config", params: { ...INITIAL_GOVERNANCE } }, "A: repair quorum -> 0");
    for (const actor of ["A", "B", "C", "F"] as const) await vote(mirror, actor, repair.id, true);
    await warpPastGrace(mirror, repair.id);
    const rr = await processProposal(mirror, "D", repair);
    invariant("T-9", !rr.info.status.passed && (await read<bigint>(mirror, "baal", "quorumPercent")) === 101n, `a unanimous repair proposal cannot pass either (passed=${rr.info.status.passed}; quorumPercent still ${await read<bigint>(mirror, "baal", "quorumPercent")}): the documented terminal shape; exit is the remedy`);

    step("T-9b: exit still works: C ragequits 1000 shares and is paid pro-rata (the constitution's remedy survives the terminal config)");
    const exit = await ragequit(mirror, "C");
    invariant("T-9", exit.paid === exit.expected && exit.paid > 0n, `C exited with ${fmtS(exit.paid)} USDC (expected pro-rata ${fmtS(exit.expected)}): exit protects every member; only collective action is dead`);
    assert(C.length > 0, "C address present");
  } finally {
    finish("project-config-edges");
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
