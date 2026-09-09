/**
 * Component 6, row OPS-01: founder / deployer key compromise. Enumerates what the founder key can
 * still do after deployment (no contract privilege) and quantifies what its shares alone can pass:
 * at genesis the founder holds 100% of supply, so an attacker holding the key passes "pay me the
 * treasury" with nobody able to vote NO; after a second depositor the same proposal needs the other
 * member to stay asleep. Expected: every privileged call reverts; the share-weight attack succeeds
 * exactly when the founder's checkpointed weight > NO weight.
 */
import { assert, deposit, fmt, fmtS, fund, processProposal, propose, ragequit, runIfMain, SETTLEMENT_UNIT, shutdown, simulate, snapshot, step, transferCall, UNIT, verdict, vote, warpPastGrace } from "../../../scenarios/lib.js";
import { GENESIS_DEPOSIT } from "../../../src/zeroOne.js";
import { bootAudit, mustRevert } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-ops01");
  let passed = false;
  try {
    const F = mirror.actors.F.account.address;
    const D = mirror.actors.D.account.address;
    step("genesis: founder deposits 50 USDC -> 50e18 shares (100%)");
    await deposit(mirror, "F", GENESIS_DEPOSIT);

    step("privileges of the founder/deployer key after deployment: every privileged path reverts");
    await mustRevert(simulate(mirror, "F", "baal", "mintShares", [[F], [UNIT]]), "Baal.mintShares by founder");
    await mustRevert(simulate(mirror, "F", "baal", "setShamans", [[F], [7n]]), "Baal.setShamans by founder");
    await mustRevert(simulate(mirror, "F", "baal", "setGovernanceConfig", ["0x"]), "Baal.setGovernanceConfig by founder");
    await mustRevert(simulate(mirror, "F", "baal", "executeAsBaal", [F, 0n, "0x"]), "Baal.executeAsBaal by founder");
    await mustRevert(simulate(mirror, "F", "baal", "burnShares", [[F], [1n]]), "Baal.burnShares by founder");
    await mustRevert(simulate(mirror, "F", "shares", "mint", [F, UNIT]), "NavShareToken.mint by founder");
    await mustRevert(simulate(mirror, "F", "work", "activateTask", [1n]), "WorkManager.activateTask by founder");
    await mustRevert(simulate(mirror, "F", "safe", "execTransaction", [F, 0n, "0x", 0, 0n, 0n, 0n, F, F, "0x"]), "Safe.execTransaction by founder (not an owner)");
    const owners = await mirror.chain.publicClient.readContract({ address: mirror.dao.safe, abi: mirror.abi.safe, functionName: "getOwners" }) as string[];
    assert(owners.length === 1 && owners[0]!.toLowerCase() === mirror.dao.baal.toLowerCase(), `Safe owners = [Baal] only (${owners.join(",")}); the deployer is not an owner`);
    console.log("   founder-key privileges on chain: 0 (only its shares)");

    step("attacker with the founder key at genesis (founder = 100%): 'pay attacker the whole treasury' passes alone");
    const before = await snapshot(mirror, "genesis", ["F"]);
    const p1 = await propose(mirror, "F", [transferCall(mirror, F, before.safeSettlement)], "attacker(F key): pay F everything");
    await vote(mirror, "F", p1.id, true);
    await warpPastGrace(mirror, p1.id);
    const r1 = await processProposal(mirror, "F", p1);
    const after1 = await snapshot(mirror, "after P1", ["F"]);
    assert(r1.info.status.passed && !r1.info.status.actionFailed, "P1 passed: yes 50 / no 0");
    assert(after1.safeSettlement === 0n, `Safe holds 0 USDC (was ${fmtS(before.safeSettlement)}); founder-key holder took 100% = its own genesis deposit`);
    console.log(`   loss to others: 0 USDC (no other member exists); loss to the founder = 50 USDC = whatever the key holds`);

    step("re-seed: founder deposits 50 again, D deposits 50 (founder = 50%)");
    await deposit(mirror, "F", GENESIS_DEPOSIT);
    await fund(mirror, "D", 1_000n * SETTLEMENT_UNIT);
    await deposit(mirror, "D", 50n * SETTLEMENT_UNIT);
    const seeded = await snapshot(mirror, "seeded", ["F", "D"]);
    assert(seeded.shares.F === seeded.shares.D, `F and D hold equal weight: ${fmt(seeded.shares.F)} each`);

    step("P2: attacker proposes 'pay F everything'; D is awake and votes NO -> yes 50 = no 50 -> Defeated");
    const p2 = await propose(mirror, "F", [transferCall(mirror, F, seeded.safeSettlement)], "attacker(F key): pay F everything (D awake)");
    await vote(mirror, "F", p2.id, true);
    await vote(mirror, "D", p2.id, false);
    await warpPastGrace(mirror, p2.id);
    await mustRevert(simulate(mirror, "F", "baal", "processProposal", [p2.id, p2.data]), "processProposal of a Defeated proposal (!ready)");
    const after2 = await snapshot(mirror, "after P2", ["F", "D"]);
    assert(after2.safeSettlement === seeded.safeSettlement, "treasury untouched: a NO of equal weight defeats the founder key");

    step("P3: same proposal, D asleep (no vote, no exit) -> passes; D loses its 50 USDC to the key holder");
    const p3 = await propose(mirror, "F", [transferCall(mirror, F, seeded.safeSettlement)], "attacker(F key): pay F everything (D asleep)");
    await vote(mirror, "F", p3.id, true);
    await warpPastGrace(mirror, p3.id);
    const r3 = await processProposal(mirror, "F", p3);
    const after3 = await snapshot(mirror, "after P3", ["F", "D"]);
    assert(r3.info.status.passed && after3.safeSettlement === 0n, `P3 passed with yes ${fmt(r3.info.yesVotes)} / no 0; Safe 0`);
    console.log(`   D's loss = 50 USDC (its whole deposit); attacker's gain beyond its own stake = ${fmtS(after3.settlement.F - after2.settlement.F - 50n * SETTLEMENT_UNIT)} USDC; cost = 3 tx gas`);
    const exitD = await ragequit(mirror, "D");
    assert(exitD.paid === 0n, `D's exit now pays ${fmtS(exitD.paid)} USDC: nothing left`);
    passed = true;
  } finally {
    verdict("OPS-01 founder-key-compromise", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
