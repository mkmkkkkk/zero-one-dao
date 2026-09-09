/**
 * Audit rows T-1, T-2, T-3, T-16 (TemplateFactory CREATE2 and ProposalBase onlySafe, security-audit
 * component 4) on the anvil mirror.
 *
 * T-1  code substitution between quote and submission is impossible: the instance address binds the
 *      deployer, the salt and keccak256(creationCode ‖ abi.encode(safe, settlement, member, params));
 *      the deployers hold no storage and have no admin.
 * T-2  permissionless deploy side effects: a stranger pre-deploying a member's instance changes
 *      nothing (same code, operator = member, idempotent redeploy).
 * T-16 one instance, two proposals (same salt): the second fund + start actionFails atomically and
 *      the treasury is not charged twice.
 * T-3  start / topUp / amend / stop / migrate revert OnlySafe for everyone; the Safe has one owner
 *      (Baal) and one module (Baal).
 *
 * Run: `npx tsx evidence/audit/work-templates/factory-create2-onlysafe.ts`.
 */
import { getAddress, keccak256, numberToHex, type Address, type Hex } from "viem";

import {
  assert,
  boot,
  describeAt,
  expectRevert,
  fmtS,
  processProposal,
  read,
  readAt,
  runIfMain,
  seedMembers,
  sendAt,
  SETTLEMENT_UNIT,
  shutdown,
  simulateAt,
  snapshot,
  step,
  usdcOf,
  vote,
  warp,
  warpPastGrace,
} from "../../../scenarios/lib.js";
import { loadLocalArtifact } from "../../../src/baal.js";
import { deployTemplate, encodeParams, predictInstance, submitTemplateProposal, TEMPLATE_IDS, type TemplateSpec } from "../../../src/proposals.js";
import { finish, invariant } from "./_harness.js";

/**
 * Names of the non-view, non-pure functions of an ABI.
 *
 * Args:
 *   abi: A contract ABI.
 *
 * Returns:
 *   Function names that can change state.
 */
function mutators(abi: readonly unknown[]): string[] {
  return abi
    .filter((item) => (item as { type: string }).type === "function")
    .filter((item) => !["view", "pure"].includes((item as { stateMutability: string }).stateMutability))
    .map((item) => (item as { name: string }).name);
}

/**
 * Run the factory / onlySafe audit demonstrations.
 *
 * Returns:
 *   Nothing; prints receipts, numbers and the verdict block.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-factory");
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;
    const B = mirror.actors.B.account.address;
    const O = mirror.actors.O.account.address;
    const factory = mirror.dao.templateFactory;
    const spec: TemplateSpec = { template: "Payment", params: { recipients: [O], amounts: [100n * SETTLEMENT_UNIT] } };
    const params = encodeParams(spec);
    const salt = numberToHex(0xa0d17, { size: 32 });

    // ---------------------------------------------------------------- T-1 / T-2
    step("T-1/T-2: A predicts its Payment instance; stranger W deploys it through the factory with member = A (W pays gas)");
    const predicted = await predictInstance(mirror.actors.A, mirror.dao, spec, A, salt);
    console.log(`   predicted = ${predicted} for (template 0, params keccak ${keccak256(params)}, member A, salt ${salt})`);
    const wDeploy = await sendAt(mirror, "W", factory, "factory", "deploy", [TEMPLATE_IDS.Payment, params, A, salt], "W factory.deploy(0, params, A, salt)");
    const code1 = (await mirror.chain.publicClient.getCode({ address: predicted })) as Hex;
    const codeHash1 = keccak256(code1);
    const d1 = await describeAt(mirror, predicted, "deployed by W");
    invariant("T-2", getAddress(d1.operator) === getAddress(A) && d1.status === "Pending" && d1.budget === 100n * SETTLEMENT_UNIT, `operator of the stranger-deployed instance is the member A (${d1.operator}), Pending, budget 100 USDC`);

    step("T-1: A's own builder finds the instance already deployed: same address, same runtime code hash; predict is a pure function of (deployer, salt, initCode)");
    const mine = await deployTemplate(mirror.actors.A, mirror.dao, spec, A, salt);
    invariant("T-1", mine.deployHash === undefined && getAddress(mine.address) === getAddress(predicted) && mine.codeHash === codeHash1, `A's deployTemplate reused the instance (no deploy tx) with code hash ${mine.codeHash} == ${codeHash1}`);
    const otherSalt = await predictInstance(mirror.actors.A, mirror.dao, spec, A, numberToHex(0xa0d18, { size: 32 }));
    const otherMember = await predictInstance(mirror.actors.A, mirror.dao, spec, B, salt);
    const otherParams = await predictInstance(mirror.actors.A, mirror.dao, { template: "Payment", params: { recipients: [O], amounts: [101n * SETTLEMENT_UNIT] } }, A, salt);
    invariant("T-1", new Set([predicted, otherSalt, otherMember, otherParams]).size === 4, `salt, member and params each change the address (${predicted}, ${otherSalt}, ${otherMember}, ${otherParams})`);
    const deployerAbi = loadLocalArtifact("PaymentDeployer").abi;
    const code = (await mirror.chain.publicClient.readContract({ address: mirror.dao.templateDeployers[0]!, abi: deployerAbi, functionName: "initCode", args: [A, params, mirror.dao.treasuryLedger] })) as Hex;
    const creation = loadLocalArtifact("PaymentProposal").bytecode as Hex;
    invariant("T-1", code.toLowerCase().startsWith(creation.toLowerCase()), `deployer.initCode(member, params, ledger) == PaymentProposal.creationCode (${creation.length / 2 - 1} bytes) ‖ abi.encode(safe, settlement, member, params)`);
    const expected = getAddress(`0x${keccak256(`0xff${mirror.dao.templateDeployers[0]!.slice(2)}${salt.slice(2)}${keccak256(code).slice(2)}` as Hex).slice(26)}`);
    invariant("T-1", expected === getAddress(predicted), `keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))[12:] == predicted (${expected})`);
    for (const [name, deployer] of [["PaymentDeployer", mirror.dao.templateDeployers[0]!], ["StrategyDeployer", mirror.dao.templateDeployers[1]!], ["ProjectDeployer", mirror.dao.templateDeployers[2]!], ["ConfigDeployer", mirror.dao.templateDeployers[3]!]] as const) {
      const abi = loadLocalArtifact(name).abi;
      const writes = mutators(abi);
      invariant("T-1", writes.length === 1 && writes[0] === "deploy", `${name} @ ${deployer} has exactly one state-changing function: ${writes.join(", ")} (no owner, no setter, no upgrade)`);
    }
    const factoryWrites = mutators(mirror.abi.factory);
    invariant("T-1", factoryWrites.every((name) => name === "deploy" || name === "quote"), `TemplateFactory state-changing functions: ${factoryWrites.join(", ")} (quote = deploy + describe for eth_call)`);
    console.log(`   cost to W: ${wDeploy.gasUsed} gas; effect on A: none (A's next propose reuses the instance; the relay skips the sponsored deploy)`);

    // ---------------------------------------------------------------- T-16 one instance, two proposals
    step("T-16: A submits two Baal proposals for the SAME instance (same salt); both pass; the second fund+start must not pay O twice");
    const p1 = await submitTemplateProposal(mirror.actors.A, mirror.dao, spec, "A: pay O 100 (first)", 0, salt);
    await warp(mirror, 1, "votingStarts of #1");
    const p2 = await submitTemplateProposal(mirror.actors.A, mirror.dao, spec, "A: pay O 100 (second, same instance)", 0, salt);
    await warp(mirror, 1, "votingStarts of #2");
    assert(getAddress(p1.instance.address) === getAddress(p2.instance.address) && getAddress(p1.instance.address) === getAddress(predicted), "both proposals target the one instance");
    for (const id of [p1.id, p2.id]) {
      await vote(mirror, "A", id, true);
      await vote(mirror, "B", id, true);
    }
    await warpPastGrace(mirror, p2.id);
    const oBefore = await usdcOf(mirror, O);
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    const r1 = await processProposal(mirror, "C", p1);
    assert(r1.info.status.passed && !r1.info.status.actionFailed, "#1 executed: O paid 100");
    const r2 = await processProposal(mirror, "C", p2);
    const oAfter = await usdcOf(mirror, O);
    const safeAfter = await usdcOf(mirror, mirror.dao.safe);
    console.log(`   #2: passed=${r2.info.status.passed} actionFailed=${r2.info.status.actionFailed}; O ${fmtS(oBefore)} -> ${fmtS(oAfter)} USDC; Safe ${fmtS(safeBefore)} -> ${fmtS(safeAfter)} USDC`);
    invariant("T-16", oAfter === oBefore + 100n * SETTLEMENT_UNIT && safeAfter === safeBefore - 100n * SETTLEMENT_UNIT && r2.info.status.actionFailed, "one instance is funded at most once: the second fund+start reverted inside MultiSend (start WrongStatus) and the transfer was rolled back with it");

    // ---------------------------------------------------------------- T-3 onlySafe
    step("T-3: on a fresh Pending instance every management entry point reverts OnlySafe for the proposer and a stranger");
    const fresh = await deployTemplate(mirror.actors.A, mirror.dao, spec, A, numberToHex(0xa0d19, { size: 32 }));
    const calls: [string, unknown[]][] = [["start", []], ["topUp", [1n]], ["amend", [params]], ["stop", []], ["migrate", [predicted]]];
    for (const actor of ["A", "W", "F"] as const) {
      for (const [fn, args] of calls) await expectRevert(simulateAt(mirror, actor, fresh.address, "proposal", fn, args), "OnlySafe", `${actor} ${fn}() -> OnlySafe`);
    }
    const owners = await read<Address[]>(mirror, "safe", "getOwners");
    const threshold = await read<bigint>(mirror, "safe", "getThreshold");
    const [modules] = await read<[Address[], Address]>(mirror, "safe", "getModulesPaginated", ["0x0000000000000000000000000000000000000001", 10n]);
    console.log(`   Safe owners ${owners.join(", ")} threshold ${threshold}; modules ${modules.join(", ")}; Baal ${mirror.dao.baal}`);
    invariant("T-3", owners.length === 1 && getAddress(owners[0]!) === getAddress(mirror.dao.baal) && threshold === 1n && modules.length === 1 && getAddress(modules[0]!) === getAddress(mirror.dao.baal), "the only Safe owner and the only Safe module is Baal; Baal calls exec only from processProposal (vendored Baal.sol processActionProposal)");

    console.log(`\n   treasury at start ${fmtS(seeded.safeSettlement)} USDC, at end ${fmtS((await snapshot(mirror, "end", [])).safeSettlement)} USDC (one payment of 100)`);
  } finally {
    finish("factory-create2-onlysafe");
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
