/**
 * Base mainnet rehearsal on one owned loopback Anvil fork of Base (chain 8453): the deployment entry
 * module, the 50 USDC genesis, and the lifecycle phase 5 introduced.
 *
 * The fork comes from `startBaseFork` (FORK_RPC first, then https://mainnet.base.org,
 * https://base-rpc.publicnode.com, https://base.drpc.org; the block is pinned by src/baseFork.ts so the
 * run replays the same upstream state and anvil keeps its on-disk RPC cache). chain id 8453 and "anvil
 * reports a forked Base network" are asserted here before the first write, and again inside
 * `fundForkUsdc` and inside `deployNetwork --fork`; no transaction ever reaches a public network.
 *
 * What it exercises that the phase 3 rehearsal could not (all of it phase 5 code):
 *   - the vendored Baal fork (contracts/vendor/Baal.sol) as the deployed singleton: its runtime size,
 *     its 8,000,000 baalGas ceiling and its exit-based retention rule replacing the high-water mark;
 *   - MultiSendCallOnly as the Safe's multisend library;
 *   - the TreasuryLedger the TemplateFactory creates in its constructor, as the deposit NAV numerator:
 *     a voted Project keeps part of the treasury outside the Safe and inside the ledger;
 *   - DepositShaman pricing the WorkManager's Active task rewards as an unminted share liability;
 *   - Baal.ragequit under the per-epoch lot accounting, measured for a member holding lots from
 *     several proposals (the number decision.md phase 5 ruling 2 costs).
 *
 * Receipts: evidence/phase5/base-fork/{e2e-base-fork.log, deploy-base-fork.json, measurements.json,
 * verification-base/}. Scenario K (real Uniswap v3) stays the separate `npm run scenario:K` rehearsal;
 * set FORK_SCENARIO_K=1 to append it to this run on the same fork.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";

import { erc20Abi, getAddress, keccak256, stringToHex, type Abi, type Address, type Hex } from "viem";

import { loadBaalArtifact, loadLocalAbi, loadLocalArtifact, type WriteContext } from "../src/baal.js";
import { startBaseFork, fundForkUsdc, assertBaseFork } from "../src/baseFork.js";
import { stopDevnet } from "../src/devnet.js";
import { assertInvariant, connectDevnet, increaseTime, simulateSettled, writeAndWait } from "../src/onchain.js";
import { BAAL_GAS_CAP, submitTemplateProposal, type SubmittedProposal, type Tranche } from "../src/proposals.js";
import { BASE_USDC, DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit, SETTLEMENT_UNIT, UNIT, type ZeroOneDao } from "../src/zeroOne.js";
import { runUniswapFork } from "../scenarios/K-uniswap-v3-fork.js";
import { deployNetwork } from "./deploy-network.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "evidence", "phase5", "base-fork");
mkdirSync(DIR, { recursive: true });
let log = path.join(DIR, "e2e-base-fork.log");
writeFileSync(log, "");
const originalLog = console.log, originalError = console.error;
console.log = (...args: unknown[]) => { appendFileSync(log, format(...args) + "\n"); originalLog(...args); };
console.error = (...args: unknown[]) => { appendFileSync(log, format(...args) + "\n"); originalError(...args); };

/** USDC the member that exercises deposits and the ragequit measurement is funded with. */
const MEMBER_USDC = 50n * SETTLEMENT_UNIT;
/** Settlement the voted Project keeps outside the Safe (its single, not-yet-due tranche). */
const PROJECT_BUDGET = 10n * SETTLEMENT_UNIT;
/** Share reward of the task the DAO votes Active: the liability DepositShaman prices in. */
const TASK_REWARD = 10n * UNIT;

/** Bigints as decimal strings, for the measurement receipts. */
const stringify = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);

/**
 * The newest commit in HEAD's history that the public origin advertises.
 *
 * The constitution can only ever pin a pushed commit (`deployNetwork` refuses anything else, on a fork
 * too). When the working tree carries unpublished commits the rehearsal pins the newest pushed ancestor
 * instead of HEAD, which still proves the whole gate: the raw URL is fetched and its bytes must hash to
 * the immutable `Constitution.textHash` compiled from the local docs/CONSTITUTION.md.
 *
 * Returns:
 *   The 40-hex commit to pin (FORK_GENESIS_COMMIT overrides the search).
 *
 * Raises:
 *   Error: When the override is malformed, or no commit in HEAD's recent history is published.
 */
function pushedGenesisCommit(): string {
  const override = process.env.FORK_GENESIS_COMMIT?.trim();
  if (override !== undefined && override !== "") {
    if (!/^[0-9a-f]{40}$/u.test(override)) throw new Error(`FORK_GENESIS_COMMIT must be a full 40-hex SHA, got ${override}`);
    return override;
  }
  const advertised = new Set(
    execFileSync("git", ["ls-remote", "origin"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
      .split("\n").map((line) => line.split("\t")[0]?.trim()).filter((sha): sha is string => /^[0-9a-f]{40}$/u.test(sha ?? "")),
  );
  const history = execFileSync("git", ["rev-list", "--max-count=500", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  const found = history.find((sha) => advertised.has(sha));
  if (found === undefined) throw new Error("BLOCKED: no commit among HEAD's last 500 is advertised by the public origin; the constitution can only pin a pushed commit (push, or set FORK_GENESIS_COMMIT)");
  const ahead = history.indexOf(found);
  console.log(`ASSERT constitution pins ${found}${ahead === 0 ? " (= local HEAD, pushed)" : ` (newest pushed ancestor; local HEAD ${history[0]} is ${ahead} unpublished commit(s) ahead)`}`);
  return found;
}

/**
 * Move an existing fork record aside so the rehearsal can rerun; a real deployment record is never
 * touched (only a record whose own `fork` flag is true is superseded).
 *
 * Args:
 *   file: The record path `deployNetwork` is asked to write.
 */
function supersedeForkRecord(file: string): void {
  if (!existsSync(file)) return;
  const previous = JSON.parse(readFileSync(file, "utf8")) as { fork?: unknown };
  if (previous.fork !== true) throw new Error(`REFUSED: ${file} is not a fork record; move it aside deliberately`);
  const aside = `${file.replace(/\.json$/u, "")}.superseded.json`;
  renameSync(file, aside);
  console.log(`superseded the previous fork record -> ${path.relative(ROOT, aside)}`);
}

/**
 * Total gas of every transaction the deployer sent in a block range (the authoritative deployment cost).
 *
 * Args:
 *   publicClient: Client of the owned fork.
 *   deployer: The deploying EOA.
 *   fromBlock: First block to scan (exclusive of the pre-deployment block).
 *   toBlock: Last block to scan.
 *
 * Returns:
 *   The summed gas and one row per transaction, in block order.
 */
async function deployerGas(
  publicClient: ReturnType<typeof connectDevnet>["publicClient"],
  deployer: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ total: bigint; rows: { block: bigint; hash: Hex; gasUsed: bigint }[] }> {
  let total = 0n;
  const rows: { block: bigint; hash: Hex; gasUsed: bigint }[] = [];
  for (let number = fromBlock; number <= toBlock; number += 1n) {
    const block = await publicClient.getBlock({ blockNumber: number, includeTransactions: true });
    for (const transaction of block.transactions) {
      if (typeof transaction === "string") continue;
      if (getAddress(transaction.from) !== getAddress(deployer)) continue;
      const receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash });
      total += receipt.gasUsed;
      rows.push({ block: number, hash: transaction.hash, gasUsed: receipt.gasUsed });
    }
  }
  return { total, rows };
}

async function main(): Promise<void> {
  const devnet = await startBaseFork(`phase5-base-fork-${Date.now()}`);
  try {
    await assertBaseFork(devnet.rpcUrl);
    const chain = connectDevnet(devnet);
    const { publicClient } = chain;
    const chainId = await publicClient.getChainId();
    assertInvariant(chainId === 8453, `loopback chain id is 8453 (got ${chainId})`);
    const forkedFrom = (await publicClient.request({ method: "anvil_metadata" as never, params: [] as never })) as { forkedNetwork?: { chainId?: number | string } };
    assertInvariant(Number(forkedFrom.forkedNetwork?.chainId) === 8453, "anvil reports a forked Base network");
    console.log(`ASSERT before any write: loopback ${devnet.rpcUrl} chainId=${chainId} forkedNetwork=${Number(forkedFrom.forkedNetwork?.chainId)}`);

    const founder = chain.contexts[0]!;
    const payee = chain.contexts[1]!;
    const member = chain.contexts[2]!;
    const worker = chain.contexts[3]!;
    const verifiers = [chain.contexts[4]!, chain.contexts[5]!];

    // ---------------------------------------------------------------- deployment + genesis
    await fundForkUsdc(devnet, founder.account.address, GENESIS_DEPOSIT);
    await fundForkUsdc(devnet, member.account.address, MEMBER_USDC);
    const keyFile = path.join(devnet.stateDir, "deployer.env");
    writeFileSync(keyFile, `ANCHOR_PRIVATE_KEY=${devnet.privateKeys[0]}\n`, { mode: 0o600 });
    const recordFile = path.join(DIR, "deploy-base-fork.json");
    supersedeForkRecord(recordFile);
    const result = await deployNetwork(8453, [
      "--i-confirmed-parameters", "--fork",
      "--fork-genesis-commit", pushedGenesisCommit(),
      "--rpc", devnet.rpcUrl,
      "--key-file", keyFile,
      "--out", recordFile,
    ]);
    if (!result) throw new Error("deployment returned no DAO");
    const { dao, record } = result;
    const governance = dao.params.governance;

    const baalAbi = loadBaalArtifact("Baal").abi;
    const sharesAbi = loadLocalArtifact("NavShareToken").abi;
    const ledgerAbi = loadLocalAbi("TreasuryLedger");
    const depositAbi = loadLocalArtifact("DepositShaman").abi;
    const workAbi = loadLocalArtifact("WorkManager").abi;
    const projectAbi = loadLocalArtifact("ProjectProposal").abi;
    const at = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> =>
      publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
    const usdc = (holder: Address) => at<bigint>(BASE_USDC, erc20Abi, "balanceOf", [holder]);
    const baal = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(dao.baal, baalAbi, functionName, args);
    const shares = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(dao.shares, sharesAbi, functionName, args);
    const ledger = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(dao.treasuryLedger, ledgerAbi, functionName, args);
    const shaman = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(dao.depositShaman, depositAbi, functionName, args);
    const work = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(dao.workManager, workAbi, functionName, args);

    // ---------------------------------------------------------------- measurement 1 + 2
    const head = await publicClient.getBlockNumber();
    const scanned = await deployerGas(publicClient, founder.account.address, BigInt(record.startBlock) + 1n, head);
    const labelled: [string, Hex][] = [
      ...Object.entries(record.txHashes) as [string, Hex][],
      ["genesis:approve", record.genesis.approveHash],
      ["genesis:deposit", record.genesis.depositHash],
    ];
    let labelledTotal = 0n;
    const breakdown: { step: string; gasUsed: string }[] = [];
    for (const [name, hash] of labelled) {
      const { gasUsed } = await publicClient.getTransactionReceipt({ hash });
      labelledTotal += gasUsed;
      breakdown.push({ step: name, gasUsed: gasUsed.toString() });
    }
    assertInvariant(labelledTotal === scanned.total, `the recorded tx hashes account for every deployer transaction (${labelledTotal} vs ${scanned.total} scanned)`);
    console.log(`ASSERT deployment + genesis total gas ${scanned.total} over ${scanned.rows.length} transactions (record txHashes sum to the same)`);
    for (const row of breakdown) console.log(`   gas ${row.gasUsed.padStart(9)} ${row.step}`);

    const baalCode = await publicClient.getCode({ address: dao.infrastructure.baalSingleton });
    if (baalCode === undefined || baalCode === "0x") throw new Error("no code at the deployed Baal singleton");
    const baalRuntime = (baalCode.length - 2) / 2;
    assertInvariant(baalRuntime < 24_576, `Baal fork runtime ${baalRuntime} bytes is under the 24576-byte EIP-170 limit`);
    const library = await baal<Address>("multisendLibrary");
    assertInvariant(getAddress(library) === getAddress(dao.infrastructure.multiSend), "Baal's multisend library is the deployed MultiSendCallOnly, not the vendored MultiSend");
    const multiSendCode = await publicClient.getCode({ address: library });
    const multiSendRuntime = ((multiSendCode ?? "0x").length - 2) / 2;
    assertInvariant(multiSendRuntime === ((loadLocalArtifact("MultiSendCallOnly").deployedBytecode ?? "0x").length - 2) / 2, "the deployed multisend library is exactly the locally compiled MultiSendCallOnly");
    console.log(`ASSERT Baal fork runtime ${baalRuntime} bytes < 24576 at ${dao.infrastructure.baalSingleton}; MultiSendCallOnly runtime ${multiSendRuntime} bytes at ${library}`);
    let refusedAboveCap = "";
    try {
      await publicClient.simulateContract({ address: dao.baal, abi: baalAbi, functionName: "submitProposal", args: ["0x", 0, BAAL_GAS_CAP + 1n, "above the cap"], account: founder.account } as never);
    } catch (error) { refusedAboveCap = error instanceof Error ? error.message : String(error); }
    assertInvariant(/baalGas to high/u.test(refusedAboveCap), `the Baal fork refuses baalGas above ${BAAL_GAS_CAP} (got: ${refusedAboveCap.split("\n")[0]})`);
    console.log(`ASSERT the Baal fork caps baalGas at ${BAAL_GAS_CAP}: a submitProposal one wei of gas above it reverts "baalGas to high"`);
    assertInvariant((await shares<bigint>("balanceOf", [founder.account.address])) === 50n * UNIT, "genesis minted 50e18 shares to the founder");
    assertInvariant((await ledger<bigint>("depositTreasury")) === GENESIS_DEPOSIT, "ledger deposit NAV after genesis is the 50 USDC in the Safe");

    // ---------------------------------------------------------------- voted rounds
    /**
     * Vote a submitted proposal through and process it, asserting the expected Baal verdict.
     *
     * Args:
     *   id: Baal proposal id.
     *   data: The exact multisend bytes the proposal carries.
     *   label: Line label for the assertion.
     *   expectPassed: Whether Baal must record the proposal as passed (false for a retention veto).
     *   alreadyVoted: Skip the vote when the founder voted earlier (a proposal left open on purpose).
     */
    const process_ = async (id: number, data: Hex, label: string, expectPassed = true, alreadyVoted = false): Promise<{ hash: Hex; gasUsed: bigint }> => {
      await increaseTime(founder, 2);
      const voted = alreadyVoted ? { hash: "0x (voted earlier)" as string } : await writeAndWait(founder, { address: dao.baal, abi: baalAbi, functionName: "submitVote", args: [id, true] });
      await increaseTime(founder, governance.votingPeriod + governance.gracePeriod + 2);
      const executed = await writeAndWait(founder, { address: dao.baal, abi: baalAbi, functionName: "processProposal", args: [id, data], gas: 8_000_000n });
      const status = await baal<readonly boolean[]>("getProposalStatus", [id]);
      assertInvariant(status[1] === true && status[2] === expectPassed && status[3] === false, `${label}: proposal #${id} processed=${status[1]} passed=${status[2]} (expected ${expectPassed}) actionFailed=${status[3]}`);
      console.log(`ASSERT ${label}: proposal #${id} processed passed=${status[2]} actionFailed=false vote=${voted.hash} process=${executed.hash} gas=${executed.receipt.gasUsed}`);
      return { hash: executed.hash, gasUsed: executed.receipt.gasUsed };
    };
    /** One voted Payment of `amount` to `to`, asserting the exact transfer out of the Safe. */
    const payment = async (to: Address, amount: bigint, label: string): Promise<SubmittedProposal> => {
      const before = await usdc(to);
      const safeBefore = await usdc(dao.safe);
      const proposal = await submitTemplateProposal(founder, dao, { template: "Payment", params: { recipients: [to], amounts: [amount] } }, label);
      await process_(proposal.id, proposal.data, label);
      assertInvariant((await usdc(to)) - before === amount, `${label}: recipient received exactly ${amount}`);
      assertInvariant(safeBefore - (await usdc(dao.safe)) === amount, `${label}: the Safe paid exactly ${amount}`);
      return proposal;
    };

    console.log("\n== Payment round (the phase 3 rehearsal's step, on the phase 5 relay of contracts)");
    await payment(payee.account.address, SETTLEMENT_UNIT, "Payment 1 USDC");

    console.log("\n== Project round: a voted instance holds settlement outside the Safe, inside the ledger");
    const now = (await publicClient.getBlock()).timestamp;
    const tranche: Tranche = { amount: PROJECT_BUDGET, releaseType: "date", releaseAt: now + 30n * 86_400n, verifiers: [], threshold: 0 };
    const project = await submitTemplateProposal(founder, dao, { template: "Project", params: { tranches: [tranche], deadline: 0n } }, "Project: one 10 USDC tranche due in 30 days");
    const safeBeforeProject = await usdc(dao.safe);
    await process_(project.id, project.data, "Project start");
    const safeAfterProject = await usdc(dao.safe);
    const heldByProject = await usdc(project.instance.address);
    assertInvariant(heldByProject === PROJECT_BUDGET && safeBeforeProject - safeAfterProject === PROJECT_BUDGET, "the voted budget left the Safe and sits in the open instance");
    assertInvariant((await at<number>(project.instance.address, projectAbi, "status")) === 1, "the Project instance is Running");
    assertInvariant((await ledger<Address[]>("openInstances")).map(getAddress).includes(getAddress(project.instance.address)), "the instance is in the ledger's open set");
    const ledgerNav = await ledger<bigint>("depositTreasury");
    assertInvariant(ledgerNav === safeAfterProject + heldByProject && ledgerNav !== safeAfterProject, `deposit NAV ${ledgerNav} = Safe ${safeAfterProject} + open instance ${heldByProject}, and differs from the Safe balance`);
    assertInvariant((await ledger<boolean>("settled")) === true, "no open instance holds a registered non-settlement asset: deposits stay open");
    assertInvariant((await shares<bigint>("treasuryValue")) === safeAfterProject, "NavShareToken.treasuryValue still reads the Safe only: exit NAV and deposit NAV are different numbers (phase 5 disclosure)");
    console.log(`ASSERT ledger NAV ${ledgerNav} > Safe ${safeAfterProject}; instance ${project.instance.address} holds ${heldByProject}`);

    console.log("\n== Task round: the reward of an Active task is an unminted share liability");
    const submitted = await writeAndWait(founder, (await simulateSettled<{ request: Record<string, unknown> }>(founder, {
      address: dao.workManager, abi: workAbi, functionName: "submitTask",
      args: [verifiers.map((v) => v.account.address), 2, TASK_REWARD, 0, "task: rehearse the phase 5 share liability"],
    })).request);
    const taskId = await work<bigint>("taskCount");
    const task = await work<{ proposalId: number; rewardShares: bigint; status: number }>("getTask", [taskId]);
    assertInvariant(task.rewardShares === TASK_REWARD && task.status === 1, `task #${taskId} recorded Proposed with a ${TASK_REWARD} share reward (tx ${submitted.hash})`);
    assertInvariant((await work<bigint>("activeRewardShares")) === 0n, "a Proposed task is not a liability yet");
    await increaseTime(founder, 1);
    const sponsored = await writeAndWait(founder, { address: dao.baal, abi: baalAbi, functionName: "sponsorProposal", args: [task.proposalId] });
    console.log(`   WorkManager holds no shares, so the founder sponsors proposal #${task.proposalId} (tx ${sponsored.hash})`);
    const activationData = await work<Hex>("activationData", [taskId]);
    await process_(task.proposalId, activationData, "Task activation");
    assertInvariant((await work<{ status: number }>("getTask", [taskId])).status === 2, `task #${taskId} is Active`);
    const liability = await work<bigint>("activeRewardShares");
    assertInvariant(liability === TASK_REWARD && (await shaman<bigint>("shareLiability")) === TASK_REWARD, `the Active task's ${TASK_REWARD} shares are the liability DepositShaman prices in`);

    // ---------------------------------------------------------------- deposits priced by the ledger
    /** One deposit, asserted against `amount x (supply + liability) / ledger.depositTreasury()`. */
    const deposit = async (context: WriteContext, amount: bigint, label: string) => {
      const treasury = await ledger<bigint>("depositTreasury");
      const supply = await shares<bigint>("totalSupply");
      const owed = await shaman<bigint>("shareLiability");
      const expected = supply === 0n || treasury === 0n ? (amount * UNIT) / SETTLEMENT_UNIT : (amount * (supply + owed)) / treasury;
      const quoted = await shaman<bigint>("quote", [amount]);
      assertInvariant(quoted === expected, `${label}: quote ${quoted} = ${amount} x (supply ${supply} + liability ${owed}) / ledger NAV ${treasury} = ${expected}`);
      await writeAndWait(context, (await simulateSettled<{ request: Record<string, unknown> }>(context, { address: BASE_USDC, abi: erc20Abi, functionName: "approve", args: [dao.depositShaman, amount] })).request);
      const before = await shares<bigint>("balanceOf", [context.account.address]);
      const sent = await writeAndWait(context, (await simulateSettled<{ request: Record<string, unknown> }>(context, { address: dao.depositShaman, abi: depositAbi, functionName: "deposit", args: [amount] })).request);
      const minted = (await shares<bigint>("balanceOf", [context.account.address])) - before;
      assertInvariant(minted === expected, `${label}: minted ${minted} shares, expected ${expected}`);
      console.log(`ASSERT ${label}: ${amount} USDC -> ${minted} shares at ledger NAV ${treasury} (Safe ${await usdc(dao.safe)}) with liability ${owed}; tx ${sent.hash}`);
      return { minted, treasury, supply, owed, lots: await shares<bigint>("lotCount", [context.account.address]) };
    };

    console.log("\n== Deposit priced by the TreasuryLedger and by the task liability");
    const safeOnly = await usdc(dao.safe);
    const first = await deposit(member, 25n * SETTLEMENT_UNIT, "deposit #1 (25 USDC)");
    const withoutLiability = (25n * SETTLEMENT_UNIT * first.supply) / first.treasury;
    const safeOnlyPrice = (25n * SETTLEMENT_UNIT * (first.supply + first.owed)) / safeOnly;
    assertInvariant(first.minted !== withoutLiability && first.minted !== safeOnlyPrice, `the price is neither the pre-phase-5 supply-only price (${withoutLiability}) nor a Safe-only NAV (${safeOnlyPrice})`);
    console.log(`ASSERT phase 5 pricing bites: ${first.minted} minted, supply-only would be ${withoutLiability}, Safe-only NAV would be ${safeOnlyPrice}`);

    console.log("\n== The task is delivered: exactly the voted reward mints and the liability clears");
    const evidence = stringToHex("evidence: zero-one phase 5 base fork rehearsal");
    await writeAndWait(worker, { address: dao.workManager, abi: workAbi, functionName: "claim", args: [taskId] });
    await writeAndWait(worker, { address: dao.workManager, abi: workAbi, functionName: "deliver", args: [taskId, keccak256(evidence)] });
    const workerBefore = await shares<bigint>("balanceOf", [worker.account.address]);
    const supplyBefore = await shares<bigint>("totalSupply");
    for (const verifier of verifiers) await writeAndWait(verifier, { address: dao.workManager, abi: workAbi, functionName: "confirm", args: [taskId, evidence] });
    assertInvariant((await shares<bigint>("balanceOf", [worker.account.address])) - workerBefore === TASK_REWARD, `the worker received exactly the voted ${TASK_REWARD} shares`);
    assertInvariant((await shares<bigint>("totalSupply")) - supplyBefore === TASK_REWARD, "supply grew by exactly the reward");
    assertInvariant((await work<bigint>("activeRewardShares")) === 0n && (await shaman<bigint>("shareLiability")) === 0n, "the liability is gone once the reward is minted");
    console.log(`ASSERT task #${taskId} Complete: ${TASK_REWARD} shares minted to the worker, liability back to 0`);

    console.log("\n== Three more voted Payment rounds, each stamping a new retention epoch, each followed by a deposit");
    const deposits = [first];
    for (const [index, amount] of [10n, 10n, 5n].entries()) {
      await payment(payee.account.address, SETTLEMENT_UNIT, `Payment 1 USDC (round ${index + 2})`);
      deposits.push(await deposit(member, amount * SETTLEMENT_UNIT, `deposit #${index + 2} (${amount} USDC)`));
    }
    const lots = await shares<bigint>("lotCount", [member.account.address]);
    const memberShares = await shares<bigint>("balanceOf", [member.account.address]);
    assertInvariant(lots === 4n, `the member holds ${lots} mint lots, one per proposal epoch it deposited in`);
    console.log(`ASSERT the member holds ${memberShares} shares in ${lots} lots from ${lots} different proposal epochs (epoch now ${await shares<bigint>("epoch")})`);

    // ---------------------------------------------------------------- measurement 3: ragequit
    console.log("\n== Retention: a proposal is sponsored, then the multi-lot member exits during its vote");
    const open = await submitTemplateProposal(founder, dao, { template: "Payment", params: { recipients: [payee.account.address], amounts: [SETTLEMENT_UNIT] } }, "Payment 1 USDC (retention probe)");
    const supplyAtStart = await shares<bigint>("supplyAtRegistration", [await shares<bigint>("registrationOf", [BigInt(open.id)])]);
    await increaseTime(founder, 2);
    await writeAndWait(founder, { address: dao.baal, abi: baalAbi, functionName: "submitVote", args: [open.id, true] });

    /**
     * One full ragequit, asserting the pro-rata payout and returning the gas it cost.
     *
     * Args:
     *   target: The DAO to exit from (the rehearsal DAO, or the single-lot control DAO).
     *   context: The exiting member.
     *   label: Line label for the assertion.
     *
     * Returns:
     *   Shares burned, lots consumed, USDC paid out and the gas the transaction used.
     */
    const ragequit = async (target: ZeroOneDao, context: WriteContext, label: string) => {
      const held = <T>(functionName: string, args: readonly unknown[] = []) => at<T>(target.shares, sharesAbi, functionName, args);
      const holding = await held<bigint>("balanceOf", [context.account.address]);
      const heldLots = await held<bigint>("lotCount", [context.account.address]);
      const totalSupply = await at<bigint>(target.baal, baalAbi, "totalSupply");
      const safeUsdc = await usdc(target.safe);
      const walletBefore = await usdc(context.account.address);
      const expected = (holding * safeUsdc) / totalSupply;
      const sent = await writeAndWait(context, (await simulateSettled<{ request: Record<string, unknown> }>(context, {
        address: target.baal, abi: baalAbi, functionName: "ragequit", args: [context.account.address, holding, 0n, [BASE_USDC]],
      })).request);
      const paid = (await usdc(context.account.address)) - walletBefore;
      assertInvariant(paid === expected, `${label}: paid ${paid} = ${holding} shares x Safe ${safeUsdc} / supply ${totalSupply}`);
      assertInvariant((await held<bigint>("balanceOf", [context.account.address])) === 0n && (await held<bigint>("lotCount", [context.account.address])) === 0n, `${label}: every share and every lot is gone`);
      console.log(`ASSERT ${label}: burned ${holding} shares from ${heldLots} lots, paid ${paid} USDC, gas ${sent.receipt.gasUsed} (tx ${sent.hash})`);
      return { label, shares: holding, lots: heldLots, paid, gasUsed: sent.receipt.gasUsed, hash: sent.hash };
    };

    const memberExit = await ragequit(dao as ZeroOneDao, member, `ragequit: member with ${lots} lots (first exit of this DAO, cold retention tree)`);
    const exited = await shares<readonly [bigint, bigint]>("exitedSince", [BigInt(open.id)]);
    assertInvariant(exited[0] === memberShares && exited[1] === supplyAtStart, `exitedSince(#${open.id}) = ${exited[0]} of ${exited[1]} at votingStarts: every burned lot predates the registration`);
    const retained = exited[0] * 100n <= (100n - governance.minRetentionPercent) * exited[1];
    console.log(`ASSERT retention rule on the fork: ${exited[0]} exited of ${exited[1]} at votingStarts, bound (100-${governance.minRetentionPercent})% -> proposal must ${retained ? "pass" : "fail"}`);
    await process_(open.id, open.data, `retention verdict on proposal #${open.id}`, retained, true);

    const workerExit = await ragequit(dao as ZeroOneDao, worker, "ragequit: worker with 1 lot (warm retention tree)");
    const founderExit = await ragequit(dao as ZeroOneDao, founder, "ragequit: founder with 1 genesis lot (warm retention tree)");
    assertInvariant((await shares<bigint>("totalSupply")) === 0n, "every share has exited; supply is back to zero and the next deposit prices at the genesis rate");

    // The Fenwick tree of a fresh NavShareToken is all zeroes, so the first burn pays the cold SSTORE
    // price on every node it touches; a later burn in the same DAO writes non-zero slots and costs a
    // fraction. Separating the two is the only way to read the ragequit number honestly, so the control
    // is a second DAO on the same fork (reusing the singletons) with one genesis lot and nothing else.
    console.log("\n== Control: the same exit with a single genesis lot, on a fresh DAO whose retention tree is also cold");
    await fundForkUsdc(devnet, founder.account.address, GENESIS_DEPOSIT);
    const control = await deployZeroOne(founder, {
      ...DEFAULT_PARAMS, salt: 2n, founder: founder.account.address, settlement: BASE_USDC,
      constitutionTextUrl: record.constitution.textUrl, infrastructure: dao.infrastructure,
    });
    await genesisDeposit(founder, control, GENESIS_DEPOSIT);
    const controlExit = await ragequit(control, founder, "ragequit: 1 genesis lot, fresh DAO (cold retention tree)");

    // ---------------------------------------------------------------- receipts
    const measurements = {
      chain: "Base fork (8453)",
      fork: true,
      loopbackRpc: devnet.rpcUrl,
      forkBlock: record.startBlock,
      sourceCommit: record.sourceCommit,
      genesisCommit: record.genesisCommit,
      deployment: { totalGas: scanned.total, transactions: scanned.rows.length, breakdown },
      baalFork: { address: dao.infrastructure.baalSingleton, runtimeBytes: baalRuntime, eip170Limit: 24_576, baalGasCap: BAAL_GAS_CAP, multiSendCallOnly: { address: dao.infrastructure.multiSend, runtimeBytes: multiSendRuntime } },
      ragequit: [memberExit, workerExit, founderExit, controlExit].map(({ label, shares: burned, lots: count, paid, gasUsed, hash }) => ({ label, sharesBurned: burned, lots: count, usdcPaid: paid, gasUsed, hash })),
      deposits: deposits.map(({ minted, treasury, supply, owed, lots: count }) => ({ sharesMinted: minted, ledgerNav: treasury, supplyBefore: supply, shareLiability: owed, lotsAfter: count })),
      retention: { proposalId: open.id, exited: exited[0], supplyAtVotingStarts: exited[1], minRetentionPercent: governance.minRetentionPercent, passed: retained },
    };
    writeFileSync(path.join(DIR, "measurements.json"), `${stringify(measurements)}\n`);
    console.log(`\nASSERT phase 5 Base fork rehearsal PASS: deployment ${scanned.total} gas, Baal fork ${baalRuntime} bytes, ragequit ${memberExit.gasUsed} gas with ${lots} lots`);
    console.log("ASSERT no Etherscan verification invoked and no public-network transaction sent");

    if (process.env.FORK_SCENARIO_K === "1") {
      log = path.join(DIR, "uniswap-v3-fork.log");
      writeFileSync(log, `ASSERT same fork as the deployment rpc=${devnet.rpcUrl} safe=${dao.safe} genesisTx=${record.genesis.depositHash}\n`);
      await runUniswapFork({ devnet, dao: dao as ZeroOneDao, founder, stranger: payee });
    } else {
      console.log("scenario K skipped (set FORK_SCENARIO_K=1 to append the real Uniswap v3 rehearsal to this fork)");
    }
  } finally {
    await stopDevnet(devnet);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
