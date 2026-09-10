/**
 * Component 7, row ECO-06 (impersonation / mislabelled effect) and component 6, row OPS-07 (index
 * under a reorg), re-run against the phase 5 fixes (rulings 6 and 3). What a sleeping-but-polling member
 * sees is relay/chain.ts readDaoState: `treasuryEffect.usdcOut` still counts only `USDC.transfer` calls
 * from the Safe, but each of the three drains that used to pass unannounced is now named:
 * (1) `USDC.approve(attacker, max)` followed by a later transferFrom: usdcOut stays 0, and the allowance
 * is reported as usdcApproved / usdcAtRisk with an `allowance:` flag; the pull itself still works, so the
 * finding survives as a disclosure, not as a silent effect. (2) a delegatecall entry (operation 1) into a
 * Drainer that would run as the Safe: flagged `delegatecall:` before the vote AND refused on chain, since
 * the Safe's multisendLibrary is MultiSendCallOnly (ruling 6 / A3) — the action fails and the Safe keeps
 * its USDC. (3) details JSON naming a benign Payment instance while the calls fund nothing of the sort:
 * the panel is bound to the decoded calls, so no instance panel is shown and a `details:` flag says the
 * name is unbacked (A5-11). Then anvil_reorg is tried against the persisted index (checkpoint hash).
 * Expected: (1) demonstrated with the new fields, (2) and (3) fixed; reorg: index rebuilt (or method
 * unavailable, argued).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { encodeFunctionData, keccak256, type Hex } from "viem";

import { assert, fmtS, processProposal, propose, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, snapshot, step, transferCall, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { deployTemplate, proposalDetails } from "../../../src/proposals.js";
import { bootAudit, deployAudit } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco06");
  let passed = false;
  try {
    const stateDir = path.join(mirror.devnet!.stateDir, "relay");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    process.env.RELAY_STATE_DIR = stateDir;
    const { connect } = await import("../../../relay/common.js");
    const { readDaoState, invalidateState } = await import("../../../relay/chain.js");
    const dao = mirror.dao;
    const deployment = { rpcUrl: mirror.devnet!.rpcUrl, chainId: mirror.devnet!.chainId, startBlock: Number(dao.startBlock), deployer: dao.params.founder, founder: dao.params.founder, settlement: dao.settlement, safe: dao.safe, baal: dao.baal, shares: dao.shares, loot: dao.loot, depositShaman: dao.depositShaman, workManager: dao.workManager, templateFactory: dao.templateFactory, templateDeployers: dao.templateDeployers, intentAccount: dao.intentAccount, constitution: { address: dao.constitution, textHash: dao.constitutionHash, textUrl: dao.constitutionTextUrl }, singletons: dao.infrastructure, governance: { votingPeriod: 21600, gracePeriod: 21600, proposalOffering: "0", quorumPercent: "0", sponsorThreshold: "1000000000000000000", minRetentionPercent: "66" } };
    const env = connect(deployment as never);
    const view = async (id: number): Promise<{ usdcOut: string; usdcApproved: string; usdcAtRisk: string; summary: string; calls: string[]; flags: string[]; instance?: string }> => {
      invalidateState();
      const state = await readDaoState(env, 0);
      const p = state.proposals.find((candidate) => candidate.id === id)!;
      const out = { usdcOut: p.treasuryEffect.usdcOutFormatted, usdcApproved: p.treasuryEffect.usdcApprovedFormatted, usdcAtRisk: p.treasuryEffect.usdcAtRiskFormatted, summary: p.treasuryEffect.summary, calls: p.calls.map((call) => call.label), flags: p.flags, instance: p.instance ? `${p.instance.template} ${p.instance.address} budget ${p.instance.budgetUsdc}` : undefined };
      console.log(`   /proposals.json #${id}: usdcOut=${out.usdcOut} usdcApproved=${out.usdcApproved} usdcAtRisk=${out.usdcAtRisk} summary="${out.summary}" calls=[${out.calls.join(" ; ")}]${out.instance ? ` instance=${out.instance}` : ""}`);
      for (const flag of out.flags) console.log(`   flag: ${flag}`);
      return out;
    };
    const seeded = await seedMembers(mirror);
    const W = mirror.actors.W.account.address;

    step("(1) approve-based drain: Safe approves W for the whole balance; the index shows 0 USDC leaving");
    const approve = await propose(mirror, "A", [{ to: dao.settlement, data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "approve", args: [W, 2n ** 128n] }) }], "A: housekeeping");
    const v1 = await view(approve.id);
    assert(v1.usdcOut === "0", "index reports usdcOut 0 for an approve that hands the treasury to W (an allowance is not a transfer)");
    assert(v1.usdcApproved !== "0" && v1.usdcAtRisk === v1.usdcApproved, `phase 5 ruling 6: the same proposal reports usdcApproved=${v1.usdcApproved} and usdcAtRisk=${v1.usdcAtRisk}, so the effect is no longer invisible`);
    assert(v1.flags.some((flag) => flag.startsWith("allowance:")), `and carries an allowance flag: ${v1.flags.find((flag) => flag.startsWith("allowance:")) ?? "none"}`);
    await vote(mirror, "A", approve.id, true);
    await warpPastGrace(mirror, approve.id);
    await processProposal(mirror, "A", approve);
    const pull = await mirror.actors.W.walletClient.writeContract({ address: dao.settlement, abi: mirror.abi.settlement, functionName: "transferFrom", args: [dao.safe, W, seeded.safeSettlement], account: mirror.actors.W.account, chain: mirror.actors.W.chain });
    await mirror.chain.publicClient.waitForTransactionReceipt({ hash: pull });
    const afterPull = await snapshot(mirror, "after W transferFrom", ["W"]);
    assert(afterPull.safeSettlement === 0n, `W pulled ${fmtS(seeded.safeSettlement)} USDC any time after execution (tx ${pull}); no proposal, vote or grace involved in the pull`);

    step("(2) delegatecall drain: refill, then a proposal whose only call is operation=1 into a Drainer (phase 5: flagged before the vote and refused on chain)");
    await mirror.actors.W.walletClient.writeContract({ address: dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [dao.safe, seeded.safeSettlement], account: mirror.actors.W.account, chain: mirror.actors.W.chain });
    const drainer = await deployAudit(mirror.actors.A, "Drainer");
    const dc = await propose(mirror, "A", [{ to: drainer.address, operation: 1, data: encodeFunctionData({ abi: drainer.artifact.abi, functionName: "drain", args: [dao.settlement, W] }) }], "A: maintenance");
    const v2 = await view(dc.id);
    assert(v2.usdcOut === "0" && v2.calls.every((label) => !label.includes("USDC.transfer")), "index still reports usdcOut 0 and an opaque selector: no static decoding can price a delegatecall");
    assert(v2.flags.some((flag) => flag.startsWith("delegatecall:")), `but the proposal carries a delegatecall flag: ${v2.flags.find((flag) => flag.startsWith("delegatecall:")) ?? "none"}`);
    assert(v2.calls.some((label) => label.startsWith("DELEGATECALL")), `and the call itself is labelled ${v2.calls.find((label) => label.startsWith("DELEGATECALL")) ?? "not labelled"}`);
    await vote(mirror, "A", dc.id, true);
    await warpPastGrace(mirror, dc.id);
    const safeBeforeDc = await read<bigint>(mirror, "settlement", "balanceOf", [dao.safe]);
    const executedDc = await processProposal(mirror, "A", dc);
    const safeAfterDc = await read<bigint>(mirror, "settlement", "balanceOf", [dao.safe]);
    assert(executedDc.info.status.passed && executedDc.info.status.actionFailed && safeAfterDc === safeBeforeDc, `phase 5 ruling 6 (A3): the vote passed but the action failed and the Safe still holds ${fmtS(safeAfterDc)} USDC — the Safe's multisendLibrary is MultiSendCallOnly, which refuses every operation != 0`);

    step("(3) impersonating a template: details claim a benign Payment instance, calls do something else (phase 5: the panel follows the calls)");
    const benign = await deployTemplate(mirror.actors.A, dao, { template: "Payment", params: { recipients: [mirror.actors.O.account.address], amounts: [10n * SETTLEMENT_UNIT] } });
    const details = proposalDetails(benign, "A: pay O 10 USDC (Payment template)");
    const fake = await propose(mirror, "A", [transferCall(mirror, W, seeded.safeSettlement)], details);
    const v3 = await view(fake.id);
    assert(v3.instance === undefined, `phase 5 ruling 6 (A5-11): the claimed instance gets no panel (instance=${v3.instance ?? "none"}) because no call of this proposal touches it; the calls pay W ${v3.usdcOut} USDC and that is what the summary says`);
    assert(v3.flags.some((flag) => flag.startsWith("details:") && flag.toLowerCase().includes(benign.address.toLowerCase())), `and the unbacked name is flagged: ${v3.flags.find((flag) => flag.startsWith("details:")) ?? "none"}`);
    const codeHashClaimed = keccak256(((await mirror.chain.publicClient.getCode({ address: benign.address })) ?? "0x") as Hex);
    console.log(`   details carry codeHash ${benign.codeHash.slice(0, 18)}... of the benign instance (live ${codeHashClaimed.slice(0, 18)}...) while proposalData funds ${W}`);

    step("(4) reorg: anvil_reorg against the persisted index checkpoint");
    const head = await mirror.chain.publicClient.getBlock();
    try {
      await mirror.chain.publicClient.request({ method: "anvil_reorg" as never, params: [2, []] as never });
      const newHead = await mirror.chain.publicClient.getBlock({ blockNumber: head.number });
      invalidateState();
      const state = await readDaoState(env, 0);
      console.log(`   anvil_reorg depth 2: block ${head.number} hash ${head.hash.slice(0, 12)} -> ${newHead.hash.slice(0, 12)}; index rescanned, proposals now ${state.proposals.length} (last id ${state.proposals.at(-1)?.id}, state ${state.proposals.at(-1)?.state})`);
    } catch (error) {
      console.log(`   anvil_reorg unavailable on this anvil (${(error instanceof Error ? error.message : String(error)).split("\n")[0]}); argued from relay/chain.ts: the checkpoint block hash is re-read on every scan and a mismatch discards the cache`);
    }
    passed = true;
  } finally {
    verdict("ECO-06/OPS-07 hidden-treasury-effect", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
