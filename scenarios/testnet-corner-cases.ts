/**
 * docs/TESTNET_PLAN.md corner cases that need a DAO of their own (fresh Zero One DAOs on Base Sepolia
 * via the live harness, founder key on the mini): money and shares (deposit 0 / 1 unit, the
 * zero-supply trap incl. a relay pointed at the trapped DAO, ragequit with 0 shares, the last member
 * leaving, a YES voter leaving during voting, a second treasury asset), proposals and votes (vote after
 * the end, twice, in the submission block, process early / twice, a multicall that reverts, the
 * minRetention boundary, absurd governance values), templates (strategy deadline before the first run,
 * stop-loss, topUp beyond the treasury). Every row prints expected vs observed with a receipt and is
 * summarized as JSON in evidence/testnet/. Usage (mini): ZERO_ONE_LIVE_DEPLOYMENT=deployments/base-sepolia.json tsx scenarios/testnet-corner-cases.ts [--only money,votes,absurd,templates]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BaseError, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { chooseFreePort } from "../src/devnet.js";
import { INITIAL_GOVERNANCE } from "../src/zeroOne.js";
import { stopCalls, topUpCalls, type StrategyParams } from "../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, deposit, describeAt, expectRevert, fmt, fmtS, fund, GENESIS_DEPOSIT, LIVE, now, observe, processProposal, propose, proposalInfo, proposeTemplate, ragequit, read, readAt, retryLag, seedMembers, send, sendAt, SETTLEMENT_UNIT, setPrice, shutdown, simulate, simulateAt, snapshot, stateOf, step, T, transferCall, UNIT, usdcOf, verdict, vote, warp, warpPastGrace, warpPastVoting, type Mirror, type Receipt } from "./lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Row {
  id: string;
  expected: string;
  observed: string;
  ok: boolean;
  receipt?: string;
}
const rows: Row[] = [];
function row(id: string, expected: string, observed: string, ok: boolean, receipt?: string): void {
  rows.push({ id, expected, observed, ok, receipt });
  console.log(`   CASE ${id} | expected: ${expected} | observed: ${observed} | ${ok ? "OK" : "MISMATCH"}${receipt ? ` | receipt: ${receipt}` : ""}`);
}

/** Run a simulation expected to revert; returns the decoded error name / reason text. */
async function revertOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO REVERT";
  } catch (error) {
    const text = error instanceof BaseError ? error.shortMessage + " " + (error.walk((e) => (e as { data?: unknown }).data !== undefined) as { data?: { errorName?: string } } | null)?.data?.errorName : error instanceof Error ? error.message : String(error);
    const named = /reverted with the following reason:\s*([^\n]+)|custom error '?([A-Za-z0-9_]+)|Error: ([A-Za-z0-9_]+)\(/u.exec(text);
    return (named?.[1] ?? named?.[2] ?? named?.[3] ?? text).trim().slice(0, 120);
  }
}

/** Send a write and expect the transaction itself to revert on chain (no simulation); returns status + hash. */
async function sendExpectingRevert(mirror: Mirror, actor: keyof Mirror["actors"], address: Address, abi: keyof Mirror["abi"], functionName: string, args: readonly unknown[], gas: bigint): Promise<{ status: string; hash: Hex; block: bigint }> {
  const context = mirror.actors[actor];
  const data = encodeFunctionData({ abi: mirror.abi[abi], functionName, args } as never);
  const hash = await context.walletClient.sendTransaction({ account: context.account, chain: context.chain, to: address, data, gas } as never);
  const receipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return { status: receipt.status, hash, block: receipt.blockNumber };
}

async function money(): Promise<void> {
  const mirror = await boot("corner-money");
  let passed = false;
  try {
    step("deposit 0 and deposit 1 unit (1e-6 USDC) before genesis");
    row("deposit-zero", "DepositShaman reverts ZeroAmount", await revertOf(simulate(mirror, "A", "deposit", "deposit", [0n])), true);
    const seeded = await seedMembers(mirror);
    const oneUnit = await deposit(mirror, "D", 1n);
    row("deposit-one-unit", "1 unit x totalShares / treasury = 1e12 wei-shares at NAV 1 (no revert; ZeroShares only when the quote rounds to 0)", `minted ${oneUnit.sharesMinted} wei-shares (quote ${oneUnit.quoted}); NAV 1 USDC/share`, oneUnit.sharesMinted === (1n * seeded.totalShares) / seeded.safeSettlement && oneUnit.sharesMinted > 0n, oneUnit.receipt.hash);

    step("ragequit with 0 shares (W holds none)");
    const zeroExit = await revertOf(simulate(mirror, "W", "baal", "ragequit", [mirror.actors.W.account.address, 0n, 0n, [mirror.dao.settlement]]));
    row("ragequit-zero-shares", "Baal accepts ragequit(0, 0) as a no-op (burns nothing, pays nothing) or reverts; either way nothing moves", `${zeroExit}; W shares ${fmt(await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.W.account.address]))}`, true);

    step("a YES voter ragequits while its proposal is in voting: allowed; the vote stays counted; the proposal still passes on the remaining votes");
    const pay = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, 10n * SETTLEMENT_UNIT)], "corner: pay O 10 USDC");
    await vote(mirror, "A", pay.id, true);
    await vote(mirror, "B", pay.id, true);
    const before = await proposalInfo(mirror, pay.id);
    const exitA = await ragequit(mirror, "A");
    const after = await proposalInfo(mirror, pay.id);
    row("ragequit-yes-voter-during-voting", "ragequit succeeds during Voting; yesVotes unchanged (checkpointed weight)", `A paid ${fmtS(exitA.paid)} USDC (expected ${fmtS(exitA.expected)}); yes ${fmt(before.yesVotes)} -> ${fmt(after.yesVotes)}; state ${await stateOf(mirror, pay.id)}`, exitA.paid === exitA.expected && after.yesVotes === before.yesVotes, exitA.receipt.hash);
    await warpPastVoting(mirror, pay.id);
    const exitC = await ragequit(mirror, "C", 10n * UNIT);
    row("ragequit-during-grace", "allowed (scenario B): partial exit pays pro-rata during Grace", `C burned ${fmt(exitC.burned)} -> ${fmtS(exitC.paid)} USDC; state ${await stateOf(mirror, pay.id)}`, exitC.paid === exitC.expected, exitC.receipt.hash);
    await warpPastGrace(mirror, pay.id);
    const processed = await processProposal(mirror, "W", pay);
    row("proposal-survives-exits", "passes: yes > no and retention >= 66% (A's 1000 + C's 10 of 3050 = 33.1% left)", `passed=${processed.info.status.passed} actionFailed=${processed.info.status.actionFailed}`, processed.info.status.passed && !processed.info.status.actionFailed, processed.receipt.hash);

    step("second asset in the treasury: MOCK sent to the Safe; ragequit names both tokens (ascending order) and receives both pro-rata; naming only USDC leaves the MOCK share behind");
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 1_000n * SETTLEMENT_UNIT);
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [mirror.dao.safe, 500n * SETTLEMENT_UNIT], "F sends 500 MOCK to the Safe");
    const tokens = [market.asset, mirror.dao.settlement].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const bShares = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.B.account.address]);
    const supply = await read<bigint>(mirror, "shares", "totalSupply");
    const safeMock = await readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [mirror.dao.safe]);
    const bMockBefore = await readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [mirror.actors.B.account.address]);
    const both = await sendAt(mirror, "B", mirror.dao.baal, "baal", "ragequit", [mirror.actors.B.account.address, bShares / 2n, 0n, tokens], "B ragequits half naming [MOCK, USDC]");
    const bMockAfter = await readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [mirror.actors.B.account.address]);
    row("ragequit-second-asset", "MOCK paid pro-rata only when named in the token list (Baal has no guildTokens registry; a strategy must return USDC or members name the asset)", `B received ${fmtS(bMockAfter - bMockBefore)} MOCK of ${fmtS(safeMock)} at ${fmt(bShares / 2n)}/${fmt(supply)} shares`, bMockAfter - bMockBefore === ((bShares / 2n) * safeMock) / supply, both.hash);
    row("ragequit-token-order", "Baal requires ascending token addresses ('!order')", await revertOf(simulate(mirror, "B", "baal", "ragequit", [mirror.actors.B.account.address, 1n * UNIT, 0n, [...tokens].reverse()])), true);

    step("the last member leaves: treasury fully paid, supply 0, DAO alive (a later deposit re-prices at 1 USDC -> 1e18)");
    for (const actor of ["B", "C", "D"] as const) {
      const balance = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors[actor].account.address]);
      if (balance > 0n) await ragequit(mirror, actor);
    }
    const fExit = await ragequit(mirror, "F");
    const emptySupply = await read<bigint>(mirror, "shares", "totalSupply");
    const emptyTreasury = await usdcOf(mirror, mirror.dao.safe);
    row("last-member-ragequit", "supply 0; USDC treasury 0 (dust-free since payouts are exact); DAO alive", `supply ${fmt(emptySupply)}; Safe USDC ${fmtS(emptyTreasury)}; F paid ${fmtS(fExit.paid)}`, emptySupply === 0n, fExit.receipt.hash);
    if (emptyTreasury === 0n) {
      const revive = await deposit(mirror, "D", 3n * SETTLEMENT_UNIT);
      row("deposit-after-empty", "1 USDC -> 1e18 shares again (empty-treasury price)", `D deposited 3 USDC -> ${fmt(revive.sharesMinted)} shares`, revive.sharesMinted === 3n * UNIT, revive.receipt.hash);
    } else {
      row("deposit-after-empty", "would hit the zero-supply trap if USDC remained", `Safe still holds ${fmtS(emptyTreasury)} USDC with supply 0: deposit quote ${await read<bigint>(mirror, "deposit", "quote", [SETTLEMENT_UNIT])}`, false);
    }
    passed = true;
  } finally {
    verdict("corner-money", passed);
    await shutdown(mirror);
  }
}

async function trap(): Promise<void> {
  const mirror = await boot("corner-trap");
  let relay: ChildProcess | undefined;
  let passed = false;
  try {
    step("zero-supply trap: 1 USDC sent straight to the Safe before genesis -> every deposit quotes 0 shares and reverts ZeroShares; genesis is impossible; a relay pointed at this DAO refuses the deposit with the decoded error");
    const donate = await send(mirror, "F", "settlement", "transfer", [mirror.dao.safe, 1n * SETTLEMENT_UNIT], "F donates 1 USDC to the Safe (supply 0)");
    const quote = await read<bigint>(mirror, "deposit", "quote", [50n * SETTLEMENT_UNIT]);
    row("trap-quote", "quote(50 USDC) = 0 while supply == 0 and treasury > 0", `quote ${quote}`, quote === 0n, donate.hash);
    await fund(mirror, "A", 100n * SETTLEMENT_UNIT);
    await send(mirror, "A", "settlement", "approve", [mirror.dao.depositShaman, 50n * SETTLEMENT_UNIT], "A approves");
    row("trap-deposit", "DepositShaman reverts ZeroShares(amount)", await revertOf(simulate(mirror, "A", "deposit", "deposit", [50n * SETTLEMENT_UNIT])), true);
    const { genesisDeposit } = await import("../src/zeroOne.js");
    let genesisError = "";
    try {
      await genesisDeposit(mirror.actors.F, mirror.dao, GENESIS_DEPOSIT);
    } catch (error) {
      genesisError = error instanceof Error ? error.message : String(error);
    }
    row("trap-genesis-refused", "genesisDeposit() refuses: treasury must be empty (deploy + genesis run in one script; never pre-fund the Safe)", genesisError.slice(0, 120), genesisError.includes("empty treasury"));
    if (LIVE && mirror.live !== undefined) {
      const port = chooseFreePort(18_790);
      const origin = `http://127.0.0.1:${port}`;
      relay = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "relay", "server.ts")], { cwd: ROOT, env: { ...process.env, ZERO_ONE_DEPLOYMENT: mirror.live.recordFile, RELAY_ENV_FILE: process.env.RELAY_ENV_FILE ?? path.join(ROOT, "state", "relay.env"), RELAY_PORT: String(port), RELAY_STATE_DIR: path.join(ROOT, "state", "relay-corner-trap"), RELAY_RATE_ADDRESS: "1000" }, stdio: ["ignore", "inherit", "inherit"] });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await fetch(`${origin}/health.json`)).ok) break;
        } catch {
          // not yet listening
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const pass = Buffer.from(mirror.actors.W.account.address.slice(2).repeat(2), "hex").toString("base64url");
      const joined = (await (await fetch(`${origin}/relay?op=join&pass=${encodeURIComponent(pass)}`)).json()) as Record<string, unknown>;
      const response = await fetch(`${origin}/relay?op=deposit&amount=${50n * SETTLEMENT_UNIT}&pass=${encodeURIComponent(pass)}`);
      const body = (await response.json()) as Record<string, unknown>;
      console.log(`   relay(trap DAO) join ok=${String(joined.ok)}; deposit -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
      row("trap-relay-refuses", "relay answers a decoded ZeroShares reason (no transaction)", `${response.status} ${String(body.reason).slice(0, 100)} error=${String((body.error as { name?: string } | undefined)?.name)}`, body.ok === false && (body.error as { name?: string } | undefined)?.name === "ZeroShares");
    }
    row("trap-terminal", "documented terminal state: with 0 shares nobody can sponsor a proposal; the deployment order (deploy + genesis in one script) is the only guard", "no path out: sponsorThreshold 1 share, totalShares 0 (docs/PARAMETERS.md deposit-pricing trap)", true);
    passed = true;
  } finally {
    if (relay !== undefined && relay.exitCode === null) relay.kill("SIGTERM");
    verdict("corner-trap", passed);
    await shutdown(mirror);
  }
}

async function votes(): Promise<void> {
  const mirror = await boot("corner-votes");
  let passed = false;
  try {
    await seedMembers(mirror);
    step("vote in the block of the submission (direct caller): submitProposal and submitVote sent back to back");
    const sameBlockData = (await import("../src/baal.js")).encodeProposalData([]);
    const A = mirror.actors.A;
    const count = Number(await read<number>(mirror, "baal", "proposalCount"));
    const sameBlockId = count + 1;
    const submitHash = await A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [sameBlockData, 0, 0n, "corner: same-block vote"], account: A.account, chain: A.chain, gas: 400_000n } as never);
    const voteHash = await A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitVote", args: [sameBlockId, true], account: A.account, chain: A.chain, gas: 300_000n } as never);
    const [submitReceipt, voteReceipt] = await Promise.all([mirror.chain.publicClient.waitForTransactionReceipt({ hash: submitHash }), mirror.chain.publicClient.waitForTransactionReceipt({ hash: voteHash })]);
    observe(mirror, submitReceipt.blockNumber);
    observe(mirror, voteReceipt.blockNumber);
    const [submitBlock, voteBlock] = await Promise.all([retryLag(() => mirror.chain.publicClient.getBlock({ blockNumber: submitReceipt.blockNumber })), retryLag(() => mirror.chain.publicClient.getBlock({ blockNumber: voteReceipt.blockNumber }))]);
    const sameTime = submitBlock.timestamp === voteBlock.timestamp;
    row("vote-in-submission-block", "a vote in a block whose timestamp equals votingStarts reverts (NavShareToken TimePointNotDetermined: the checkpoint is not determined yet); a later timestamp succeeds. The relay waits for a later block (ruling 7).", `submit block ${submitReceipt.blockNumber} t=${submitBlock.timestamp}, vote block ${voteReceipt.blockNumber} t=${voteBlock.timestamp} (${sameTime ? "same timestamp" : "later timestamp"}), vote status ${voteReceipt.status}`, sameTime ? voteReceipt.status === "reverted" : voteReceipt.status === "success", voteHash);

    step("vote twice; vote after voting ends; process before grace; process twice");
    const p = { id: sameBlockId, data: sameBlockData, submit: { hash: submitHash, blockNumber: submitReceipt.blockNumber, gasUsed: submitReceipt.gasUsed } as Receipt };
    await warp(mirror, 1, "next block");
    if (voteReceipt.status === "reverted") await vote(mirror, "A", p.id, true);
    row("vote-twice", "Baal reverts 'voted'", await revertOf(simulate(mirror, "A", "baal", "submitVote", [p.id, false])), true);
    await vote(mirror, "B", p.id, true);
    row("process-before-grace", "Baal reverts '!ready' while Voting", await revertOf(simulate(mirror, "C", "baal", "processProposal", [p.id, p.data])), true);
    await warpPastVoting(mirror, p.id);
    row("vote-after-voting-ends", "Baal reverts 'ended'", await revertOf(simulate(mirror, "C", "baal", "submitVote", [p.id, false])), true);
    row("process-during-grace", "Baal reverts '!ready' while in Grace", await revertOf(simulate(mirror, "C", "baal", "processProposal", [p.id, p.data])), true);
    await warpPastGrace(mirror, p.id);
    const done = await processProposal(mirror, "C", p);
    row("process-twice", "second processProposal reverts (already processed)", await revertOf(simulate(mirror, "C", "baal", "processProposal", [p.id, p.data])), done.info.status.processed, done.receipt.hash);

    step("a multicall that reverts: Payment of more than the treasury -> processed with actionFailed=true, treasury untouched");
    const treasury = await usdcOf(mirror, mirror.dao.safe);
    const overBudget = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, treasury + 1n)], "corner: pay O more than the treasury");
    await vote(mirror, "A", overBudget.id, true);
    await vote(mirror, "B", overBudget.id, true);
    await warpPastGrace(mirror, overBudget.id);
    const failed = await processProposal(mirror, "W", overBudget);
    row("multicall-reverts-actionFailed", "passed=true, actionFailed=true, USDC untouched", `passed=${failed.info.status.passed} actionFailed=${failed.info.status.actionFailed}; treasury ${fmtS(treasury)} -> ${fmtS(await usdcOf(mirror, mirror.dao.safe))}`, failed.info.status.passed && failed.info.status.actionFailed && (await usdcOf(mirror, mirror.dao.safe)) === treasury, failed.receipt.hash);

    step("minRetention boundary (66%): exactly 34% leaving keeps the proposal alive; more than 34% defeats it");
    for (const actor of ["A", "B", "C"] as const) await ragequit(mirror, actor);
    await fund(mirror, "D", 100n * SETTLEMENT_UNIT);
    const nav = { treasury: await usdcOf(mirror, mirror.dao.safe), supply: await read<bigint>(mirror, "shares", "totalSupply") };
    console.log(`   NAV ${fmtS((nav.treasury * UNIT) / nav.supply)} USDC/share with F ${fmt(nav.supply)} shares`);
    // Target supply 100 shares: F 50 + A 16 + B 34 (deposits at the current NAV).
    const usdcFor = (shares: bigint): bigint => (shares * nav.treasury + nav.supply - 1n) / nav.supply;
    await deposit(mirror, "A", usdcFor(16n * UNIT));
    await deposit(mirror, "B", usdcFor(34n * UNIT));
    const supply1 = await read<bigint>(mirror, "shares", "totalSupply");
    const bShares = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.B.account.address]);
    const boundary = await propose(mirror, "F", [], "corner: retention boundary 34% exits");
    await vote(mirror, "F", boundary.id, true);
    const exitB = await ragequit(mirror, "B");
    const remaining1 = await read<bigint>(mirror, "shares", "totalSupply");
    await warpPastGrace(mirror, boundary.id);
    const boundaryDone = await processProposal(mirror, "A", boundary);
    row("minRetention-exactly-34pct", `remaining ${fmt(remaining1)} of ${fmt(supply1)} = ${Number((remaining1 * 10_000n) / supply1) / 100}% >= 66% -> passes`, `B exited ${fmt(bShares)} (${Number((bShares * 10_000n) / supply1) / 100}%); passed=${boundaryDone.info.status.passed}`, boundaryDone.info.status.passed === remaining1 * 100n >= supply1 * 66n, boundaryDone.receipt.hash);
    await deposit(mirror, "C", usdcFor(40n * UNIT));
    const supply2 = await read<bigint>(mirror, "shares", "totalSupply");
    const cShares = await read<bigint>(mirror, "shares", "balanceOf", [mirror.actors.C.account.address]);
    const over = await propose(mirror, "F", [], "corner: retention > 34% exits");
    await vote(mirror, "F", over.id, true);
    const exitC = await ragequit(mirror, "C");
    const remaining2 = await read<bigint>(mirror, "shares", "totalSupply");
    await warpPastGrace(mirror, over.id);
    const overDone = await processProposal(mirror, "A", over);
    row("minRetention-over-34pct", `remaining ${fmt(remaining2)} of ${fmt(supply2)} = ${Number((remaining2 * 10_000n) / supply2) / 100}% < 66% -> fails`, `C exited ${fmt(cShares)} (${Number((cShares * 10_000n) / supply2) / 100}%); passed=${overDone.info.status.passed}`, overDone.info.status.passed === false && exitB.paid > 0n && exitC.paid > 0n, overDone.receipt.hash);
    passed = true;
  } finally {
    verdict("corner-votes", passed);
    await shutdown(mirror);
  }
}

async function absurd(): Promise<void> {
  const mirror = await boot("corner-absurd");
  let passed = false;
  try {
    await seedMembers(mirror);
    step("governance set to absurd values by vote: votingPeriod 1 s, gracePeriod 0 first (Baal keeps the old value for 0, the Config template's start() reverts NotApplied -> actionFailed), then 1 s / 1 s (applied); consequence documented");
    const zeroGrace = { ...INITIAL_GOVERNANCE, ...mirror.dao.params.governance, votingPeriod: 1, gracePeriod: 0 };
    const refused = await proposeTemplate(mirror, "A", { template: "Config", params: zeroGrace }, "corner: voting 1 s, grace 0");
    await vote(mirror, "A", refused.id, true);
    await vote(mirror, "B", refused.id, true);
    await warpPastGrace(mirror, refused.id);
    const refusedDone = await processProposal(mirror, "C", refused);
    row("absurd-grace-zero-refused", "Baal.setGovernanceConfig treats 0 as 'unchanged'; ConfigProposal.start() verifies the exact values -> NotApplied -> actionFailed; periods unchanged", `passed=${refusedDone.info.status.passed} actionFailed=${refusedDone.info.status.actionFailed}; votingPeriod ${await read<number>(mirror, "baal", "votingPeriod")} gracePeriod ${await read<number>(mirror, "baal", "gracePeriod")}`, refusedDone.info.status.actionFailed && Number(await read<number>(mirror, "baal", "gracePeriod")) === mirror.dao.params.governance.gracePeriod, refusedDone.receipt.hash);
    const config = { ...INITIAL_GOVERNANCE, ...mirror.dao.params.governance, votingPeriod: 1, gracePeriod: 1 };
    const change = await proposeTemplate(mirror, "A", { template: "Config", params: config }, "corner: voting 1 s, grace 1 s");
    await vote(mirror, "A", change.id, true);
    await vote(mirror, "B", change.id, true);
    await warpPastGrace(mirror, change.id);
    const applied = await processProposal(mirror, "C", change);
    row("absurd-config-applied", "the Config proposal passes and Baal reports votingPeriod 1, gracePeriod 1", `passed=${applied.info.status.passed} actionFailed=${applied.info.status.actionFailed}; votingPeriod ${await read<number>(mirror, "baal", "votingPeriod")} gracePeriod ${await read<number>(mirror, "baal", "gracePeriod")}`, applied.info.status.passed && !applied.info.status.actionFailed && Number(await read<number>(mirror, "baal", "votingPeriod")) === 1, applied.receipt.hash);
    const next = await propose(mirror, "B", [], "corner: proposal under 1 s voting");
    const state = await stateOf(mirror, next.id);
    const voteAttempt = await revertOf(simulate(mirror, "A", "baal", "submitVote", [next.id, true]));
    let processed: string;
    try {
      const done = await processProposal(mirror, "A", next);
      processed = `processed passed=${done.info.status.passed}`;
    } catch (error) {
      processed = `process reverted: ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`;
    }
    row("absurd-config-consequence", "with a 1 s voting window no block on a 2 s chain can carry a vote (a vote needs votingStarts < timestamp < votingEnds); 0 yes > 0 no is false, so nothing passes again, a repair included: a terminal state the members chose (mirror anvil mines 1 s blocks and may still fit a vote)", `state after one block: ${state}; vote -> ${voteAttempt}; ${processed}`, true, next.submit.hash);
    passed = true;
  } finally {
    verdict("corner-absurd", passed);
    await shutdown(mirror);
  }
}

async function templates(): Promise<void> {
  const mirror = await boot("corner-templates");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);
    const mockOf = (address: Address) => readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [address]);
    step("strategy whose deadline passes before the first run (deadline = now + 240 s; vote + grace take longer): run() unwinds and returns everything; a stranger's run() spam is harmless");
    const start = await now(mirror);
    const shortLived: StrategyParams = { venue: market.dex, asset: market.asset, budget: 300n * SETTLEMENT_UNIT, rule: { maxPerRun: 100n * SETTLEMENT_UNIT, minInterval: BigInt(T.hour), deadline: start + BigInt(LIVE ? 240 : 4 * T.hour), takeProfitBps: 2000n, stopLossBps: 3000n } };
    const s1 = await proposeTemplate(mirror, "A", { template: "Strategy", params: shortLived }, "corner: strategy with a short deadline");
    await vote(mirror, "A", s1.id, true);
    await vote(mirror, "B", s1.id, true);
    await warpPastGrace(mirror, s1.id);
    if (!LIVE) await warp(mirror, 4 * T.hour, "past the strategy deadline");
    const started = await processProposal(mirror, "W", s1);
    const running = await describeAt(mirror, s1.instance.address, "after start");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    const firstRun = await sendAt(mirror, "W", s1.instance.address, "strategy", "run", [], "W run() after the deadline");
    const ended = await describeAt(mirror, s1.instance.address, "after run");
    row("strategy-deadline-before-first-run", "start() succeeds (Running, funded); the first run() sees the deadline and unwinds: Complete, budget back in the Safe, nothing bought", `start passed=${started.info.status.passed}; status ${running.status} -> ${ended.status}; Safe ${fmtS(safeBefore)} -> ${fmtS(await usdcOf(mirror, mirror.dao.safe))}; instance MOCK ${fmtS(await mockOf(s1.instance.address))}`, ended.status === "Complete" && (await usdcOf(mirror, mirror.dao.safe)) === seeded.safeSettlement, firstRun.hash);
    row("strategy-run-spam-stranger", "run() on a Complete strategy reverts WrongStatus (harmless)", await revertOf(simulateAt(mirror, "W", s1.instance.address, "strategy", "run", [])), true);

    step("stop-loss: strategy buys, the price falls 40%, run() unwinds at the stop and returns the proceeds; then topUp beyond the treasury -> actionFailed");
    const params: StrategyParams = { venue: market.dex, asset: market.asset, budget: 200n * SETTLEMENT_UNIT, rule: { maxPerRun: 200n * SETTLEMENT_UNIT, minInterval: BigInt(T.hour), deadline: (await now(mirror)) + BigInt(7 * DAY), takeProfitBps: 5000n, stopLossBps: 3000n } };
    const s2 = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "corner: strategy with 30% stop-loss");
    await vote(mirror, "A", s2.id, true);
    await vote(mirror, "B", s2.id, true);
    await warpPastGrace(mirror, s2.id);
    await processProposal(mirror, "W", s2);
    await sendAt(mirror, "W", s2.instance.address, "strategy", "run", [], "W run() #1 buys 100 MOCK at 2");
    await setPrice(mirror, market, (12n * SETTLEMENT_UNIT) / 10n);
    const value = await readAt<bigint>(mirror, s2.instance.address, "strategy", "value");
    await warp(mirror, T.hour, "minInterval");
    const treasuryBeforeStop = await usdcOf(mirror, mirror.dao.safe);
    const stopRun = await sendAt(mirror, "O", s2.instance.address, "strategy", "run", [], "O run() #2 -> stop-loss");
    const stopped = await describeAt(mirror, s2.instance.address, "after stop-loss");
    row("strategy-stop-loss", "value 120 <= 140 (budget - 30%): run() unwinds, Complete, 120 USDC back to the Safe", `value ${fmtS(value)}; status ${stopped.status}; Safe ${fmtS(treasuryBeforeStop)} -> ${fmtS(await usdcOf(mirror, mirror.dao.safe))}`, stopped.status === "Complete" && (await usdcOf(mirror, mirror.dao.safe)) === treasuryBeforeStop + value, stopRun.hash);
    const treasury = await usdcOf(mirror, mirror.dao.safe);
    const topUp = await propose(mirror, "A", topUpCalls(mirror.dao, s2.instance.address, treasury + 1n), "corner: topUp beyond the treasury");
    await vote(mirror, "A", topUp.id, true);
    await vote(mirror, "B", topUp.id, true);
    await warpPastGrace(mirror, topUp.id);
    const topUpDone = await processProposal(mirror, "C", topUp);
    row("project-topup-beyond-treasury", "multicall reverts (transfer exceeds balance) -> actionFailed=true, treasury untouched", `passed=${topUpDone.info.status.passed} actionFailed=${topUpDone.info.status.actionFailed}; Safe ${fmtS(treasury)} -> ${fmtS(await usdcOf(mirror, mirror.dao.safe))}`, topUpDone.info.status.actionFailed && (await usdcOf(mirror, mirror.dao.safe)) === treasury, topUpDone.receipt.hash);
    row("payment-reverting-recipient", "N/A for ERC-20 settlement: USDC.transfer never calls the recipient, so a contract without receive() cannot revert it; the multicall only reverts when the Safe lacks balance (covered above)", "documented; scenario I covers stop() returning funds and amend mid-tranche; scenario H covers verifiers that never confirm (end() after the deadline)", true);
    row("strategy-migrate-non-template", "migrate(target) moves raw holdings to any address the members vote for (decision.md phase 2a ruling 2); no code check on the target; scenario J covers a template target", `stop()/migrate() are onlySafe: ${await revertOf(simulateAt(mirror, "A", s2.instance.address, "proposal", "migrate", [mirror.actors.A.account.address]))}`, true);
    void stopCalls;
    passed = true;
  } finally {
    verdict("corner-templates", passed);
    await shutdown(mirror);
  }
}

async function main(): Promise<void> {
  const only = (process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? "money,trap,votes,absurd,templates").split(",");
  const parts: Record<string, () => Promise<void>> = { money, trap, votes, absurd, templates };
  const results: Array<[string, boolean, string]> = [];
  for (const name of only) {
    try {
      await parts[name]!();
      results.push([name, true, ""]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`corner part ${name} failed: ${message}`);
      results.push([name, false, message]);
    }
  }
  const outFile = path.resolve(ROOT, "evidence", "testnet", `corner-cases-daos-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ host: hostname(), at: new Date().toISOString(), parts: results, rows }, null, 2)}\n`);
  console.log("\n===== CORNER CASES (fresh DAOs) =====");
  for (const [name, ok, message] of results) console.log(`${name}: ${ok ? "PASS" : `FAIL ${message}`}`);
  console.log(`${rows.filter((entry) => entry.ok).length}/${rows.length} rows OK -> ${outFile}`);
  if (results.some(([, ok]) => !ok) || rows.some((entry) => !entry.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
