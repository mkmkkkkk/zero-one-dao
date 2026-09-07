/**
 * DESIGN.md §11 F: the founder is an ordinary member. Genesis deposit of 50 USDC -> 50e18 shares =
 * 100% of supply; a second depositor of 50 USDC receives 50e18 shares at NAV and the founder falls
 * to 50%; the founder submits an operations task denominated in shares with verifiers != founder,
 * the members vote, and the reward mints only after the verifiers' confirmations. Finally, every
 * mint that ever happened is enumerated from the share token's Transfer(0x0 -> x) logs and every
 * Baal shaman from ShamanSet logs: no code path mints to the founder without a passed proposal
 * (task) or a deposit. Fresh mirror, no standard seed: this scenario is the genesis path itself.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, parseAbiItem, stringToHex, zeroAddress, type Hex } from "viem";

import { assert, assertOnlyMintPaths, boot, deposit, expectRevert, fmt, fmtS, fund, GENESIS_DEPOSIT, pct, processProposal, read, runIfMain, SETTLEMENT_UNIT, send, shutdown, simulate, snapshot, sponsor, stateOf, step, UNIT, verdict, vote, warp, warpPastGrace, type Mirror, type Receipt } from "./lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = ["None", "Proposed", "Active", "Complete", "Cancelled"] as const;

interface Task {
  proposer: string;
  worker: string;
  rewardShares: bigint;
  verifierThreshold: number;
  confirmations: number;
  round: number;
  proposalId: number;
  status: number;
  evidenceHash: Hex;
}

interface Mint {
  to: `0x${string}`;
  amount: bigint;
  txHash: Hex;
}

/**
 * Every share mint since block 0, read from NavShareToken Transfer(from = 0x0) logs.
 *
 * @param mirror The booted mirror.
 * @returns Mints in log order with recipient, amount and transaction hash.
 */
async function allMints(mirror: Mirror): Promise<Mint[]> {
  const logs = await mirror.chain.publicClient.getLogs({
    address: mirror.dao.shares,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 amount)"),
    args: { from: zeroAddress },
    fromBlock: mirror.dao.startBlock,
    toBlock: "latest",
  });
  return logs.map((log) => ({ to: getAddress(log.args.to ?? zeroAddress), amount: log.args.amount ?? 0n, txHash: log.transactionHash }));
}

export async function main(): Promise<void> {
  const mirror = await boot("scenario-F");
  let passed = false;
  try {
    const F = mirror.actors.F.account.address;
    const D = mirror.actors.D.account.address;
    const O = mirror.actors.O.account.address;

    step("genesis state: no shares, no founder contract, no founder permission");
    assert(!existsSync(path.join(ROOT, "contracts", "FounderStream.sol")) && !existsSync(path.join(ROOT, "contracts", "artifacts", "FounderStream.json")), "no FounderStream contract or artifact exists in the repo");
    assert(!("founderStream" in mirror.dao), "the deployment record has no founder stream address");
    assert((await read<bigint>(mirror, "shares", "totalSupply")) === 0n, "totalSupply == 0 at genesis");
    assert((await read<bigint>(mirror, "shares", "treasuryValue")) === 0n, "treasury == 0 at genesis (never pre-funded)");
    assert((await read<bigint>(mirror, "deposit", "quote", [1n * SETTLEMENT_UNIT])) === UNIT, "empty treasury price: 1 USDC (1e6) -> 1e18 shares");

    step("genesis deposit: the founder deposits 50 USDC through the DepositShaman -> exactly 50e18 shares = 100% of supply");
    const genesis = await deposit(mirror, "F", GENESIS_DEPOSIT);
    assert(genesis.sharesMinted === 50n * UNIT && genesis.quoted === genesis.sharesMinted, "50 USDC (50e6) -> 50e18 shares");
    const g = await snapshot(mirror, "after genesis deposit", ["F"]);
    assert(g.totalShares === 50n * UNIT && g.shares.F === 50n * UNIT && g.safeSettlement === GENESIS_DEPOSIT, `F holds ${pct(g.shares.F, g.totalShares)} of a 50-share supply; Safe holds 50 USDC`);
    assert((await allMints(mirror)).length === 1, "exactly one mint so far (the genesis deposit)");

    step("second depositor D deposits 50 USDC at NAV -> 50e18 shares; the founder falls to 50%");
    await fund(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    const amount = 50n * SETTLEMENT_UNIT;
    const expectedShares = (amount * g.totalShares) / g.safeSettlement;
    const dep = await deposit(mirror, "D", amount);
    assert(expectedShares === 50n * UNIT && dep.sharesMinted === expectedShares && dep.quoted === expectedShares, "D received amount x totalShares / treasury = 50e18 shares");
    const afterD = await snapshot(mirror, "after D's deposit", ["F", "D"]);
    assert(afterD.totalShares === 100n * UNIT && afterD.shares.F === 50n * UNIT && afterD.shares.D === 50n * UNIT, `F ${pct(afterD.shares.F, afterD.totalShares)}, D ${pct(afterD.shares.D, afterD.totalShares)} of supply`);
    assert(afterD.safeSettlement === 100n * SETTLEMENT_UNIT, "Safe holds 100 USDC; NAV per share is still 1 USDC");
    assert((await read<bigint>(mirror, "shares", "navValueForShares", [afterD.shares.F])) === GENESIS_DEPOSIT, "F's 50 shares are still worth exactly 50 USDC at NAV: the deposit diluted weight, not value");

    step("the founder submits an operations task paid in shares: verifiers [D, O] (!= founder), threshold 2, reward 10 shares");
    const reward = 10n * UNIT;
    await expectRevert(simulate(mirror, "F", "work", "submitTask", [[F, D], 2, reward, 0, "ops: F verifies itself"]), "VerifierIsProposer", "the founder cannot name itself as verifier");
    const submit = await send(mirror, "F", "work", "submitTask", [[D, O], 2, reward, 0, "ops: run the relay and beacon for one week (verifiers D, O)"], "F submitTask -> Baal proposal");
    const taskId = await read<bigint>(mirror, "work", "taskCount");
    const task = await read<Task>(mirror, "work", "getTask", [taskId]);
    assert(taskId === 1n && STATUS[task.status] === "Proposed" && task.proposer.toLowerCase() === F.toLowerCase(), "task #1 recorded as Proposed by F");
    assert(task.rewardShares === reward, "rewardShares fixed at submitTask");
    const proposalId = task.proposalId;
    await warp(mirror, 1);
    assert((await stateOf(mirror, proposalId)) === "Submitted", `Baal proposal #${proposalId} is Submitted (needs a member sponsor)`);
    assert(submit.hash !== undefined && (await read<bigint>(mirror, "shares", "balanceOf", [F])) === 50n * UNIT, "submitting a task minted nothing");

    step("members vote: F sponsors and votes YES, D votes YES; grace passes; the Safe activates the task; still nothing minted");
    await sponsor(mirror, "F", proposalId);
    await vote(mirror, "F", proposalId, true);
    await vote(mirror, "D", proposalId, true);
    await warpPastGrace(mirror, proposalId);
    const data = await read<Hex>(mirror, "work", "activationData", [taskId]);
    const processed = await processProposal(mirror, "D", { id: proposalId, data, submit: { hash: "0x", blockNumber: 0n, gasUsed: 0n } });
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "the task proposal passed and the Safe executed activateTask");
    assert(STATUS[(await read<Task>(mirror, "work", "getTask", [taskId])).status] === "Active", "task #1 is Active");
    const afterVote = await snapshot(mirror, "after the vote", ["F", "D"]);
    assert(afterVote.shares.F === 50n * UNIT && afterVote.totalShares === 100n * UNIT, "a passed proposal alone mints nothing: F still holds 50 shares");
    await expectRevert(simulate(mirror, "F", "work", "activateTask", [taskId]), "OnlySafe", "the founder cannot activate a task directly (only the Safe, i.e. a passed proposal)");

    step("the founder does the work: claims, delivers; D confirms (1/2) -> nothing; O confirms (2/2) -> exactly 10 shares mint to F");
    await expectRevert(simulate(mirror, "D", "work", "claim", [taskId]), "VerifierCannotClaim", "verifier D cannot claim");
    await send(mirror, "F", "work", "claim", [taskId], "F claims task #1 (proposer may work; verifiers may not)");
    const evidence = stringToHex("evidence: relay uptime log week 1 sha256=...");
    await send(mirror, "F", "work", "deliver", [taskId, keccak256(evidence)], "F delivers evidence hash");
    await send(mirror, "D", "work", "confirm", [taskId, evidence], "D confirms (1/2)");
    assert((await read<bigint>(mirror, "shares", "balanceOf", [F])) === 50n * UNIT, "no mint below threshold");
    const confirmFinal: Receipt = await send(mirror, "O", "work", "confirm", [taskId, evidence], "O confirms (2/2) -> mint");
    assert(STATUS[(await read<Task>(mirror, "work", "getTask", [taskId])).status] === "Complete", "task #1 Complete");
    const afterWork = await snapshot(mirror, "after verification", ["F", "D"]);
    assert(afterWork.shares.F === 50n * UNIT + reward, `F received exactly rewardShares = ${fmt(reward)} shares`);
    assert(afterWork.totalShares === 110n * UNIT && afterWork.shares.D === 50n * UNIT, `supply 110 shares: F ${pct(afterWork.shares.F, afterWork.totalShares)}, D ${pct(afterWork.shares.D, afterWork.totalShares)}`);
    assert(afterWork.safeSettlement === 100n * SETTLEMENT_UNIT, `verification moved no USDC (treasury ${fmtS(afterWork.safeSettlement)})`);

    step("audit: every mint ever, and every Baal shaman ever: no path mints to the founder without a passed proposal or a deposit");
    const mints = await allMints(mirror);
    for (const mint of mints) console.log(`   mint ${fmt(mint.amount)} -> ${mint.to} in tx ${mint.txHash}`);
    assert(mints.length === 3, "exactly three mints in the whole history");
    const toF = mints.filter((mint) => mint.to === getAddress(F));
    assert(toF.length === 2, "exactly two mints to the founder");
    assert(toF[0]!.txHash === genesis.receipt.hash && toF[0]!.amount === 50n * UNIT, "founder mint #1 is the genesis deposit transaction (DepositShaman)");
    assert(toF[1]!.txHash === confirmFinal.hash && toF[1]!.amount === reward, "founder mint #2 is the final verifier confirmation (WorkManager, after the passed proposal)");
    assert(mints[1]!.txHash === dep.receipt.hash && mints[1]!.to === getAddress(D), "the remaining mint is D's deposit");
    await assertOnlyMintPaths(mirror);
    await expectRevert(simulate(mirror, "F", "baal", "setShamans", [[F], [2n]]), "!baal", "the founder cannot grant itself a shaman permission (only a passed proposal can)");
    passed = true;
  } finally {
    verdict("F", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
