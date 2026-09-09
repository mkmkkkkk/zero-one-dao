/**
 * Zero One relay: sponsored GET intents for the eight verbs (join, deposit, task, deliver, propose,
 * vote, execute, ragequit) plus work (submitTask + self-sponsor) and confirm, over the EIP-7702
 * adapter (ZeroOneIntentAccount). Pattern: agent-only-wallet/relay/server.mjs. T1 agents sign with
 * their own key; T0 agents use a passphrase whose key the relay derives (custodial-lite). Every
 * response is JSON; every failure carries a decoded reason (docs/RELAY.md).
 *
 * Endpoints: /health.json, /me/<address>.json, /me/pass/<sha256(pass)>.json, /proposals.json,
 * /state.json, /pending.json, /relay?intent=<base64url envelope>, /relay?op=<verb>&pass=<secret>&..., /relay?op=join,
 * /relay?op=quote (read-only: the op-0 intent to sign for a template + params). Usage: tsx
 * relay/server.ts (env: ZERO_ONE_DEPLOYMENT, RELAY_SPONSOR_KEY, RELAY_PORT, RELAY_STATE_DIR,
 * ZERO_ONE_STATE_FILE, ZERO_ONE_RPC_URL).
 * Relay behaviors ruled in decision.md phase 2b: a propose intent whose instance address is still
 * empty gets the instance deployed by the sponsor first (members holding >= sponsorThreshold only,
 * rate-limited; ruling 3); a vote that follows a fresh submission waits for the next block before it
 * is sent, because Baal reads the share checkpoint at votingStarts (ruling 7).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { decodeEventLog, encodeFunctionData, getAddress, hashTypedData, isAddress, keccak256, numberToHex, recoverTypedDataAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import { awaitCode } from "../src/baal.js";
import { invalidateState, readDaoState } from "./chain.js";
import { atomic, connect, fmtShares, fmtUsdc, json, PROCESS_GAS, sponsorAccount, sponsorContext, ZERO_ADDRESS, type Env } from "./common.js";
import { decodeRevert, explain, fail, RelayError } from "./errors.js";
import { buildIntent, INTENT_TYPES, intentDomain, normalize, normalizeAuthorization, OP_NAMES, OPS, toWire, VERBS, type Envelope, type Intent, type Verb } from "./intents.js";
import { identity, me, type Me } from "./me.js";
import { passEntropyBits, PASS_ENTROPY_FLOOR } from "./pass.js";
import { decodeProposeIntentData, TEMPLATE_IDS } from "../src/proposals.js";
import { assertStateLockHeld, withStateLock } from "./lock.js";
import { parseSpec, quoteProposal } from "./templates.js";

const env: Env = connect();
const sponsor: PrivateKeyAccount = sponsorAccount();
const sponsorCtx = sponsorContext(env, sponsor);
const { deployment: D, policy, publicClient: client } = env;
const adapter = D.intentAccount;
const delegationCode = `0xef0100${adapter.slice(2)}`.toLowerCase() as Hex;
const stateFile = process.env.ZERO_ONE_STATE_FILE;

/** Persistent relay database (accounts, T0 pass hashes, request dedupe, budgets, rate windows). */
interface Db {
  nextSponsorNonce?: number;
  accounts: Record<string, { custodial: boolean; joinedAt?: string; transactions: Array<{ hash: Hex; op: number; verb: string; nonce: string; at: string; status?: string }> }>;
  passes: Record<string, string>;
  requests: Record<string, { hash: Hex; member: Address; op: number; status: string }>;
  budgets: Record<string, { wei: string; usdc: string }>;
  rates: Record<string, { at: number; n: number }>;
}
const dbFile = path.join(env.stateDir, "db.json");
let db: Db = existsSync(dbFile) ? (JSON.parse(readFileSync(dbFile, "utf8")) as Db) : { accounts: {}, passes: {}, requests: {}, budgets: {}, rates: {} };
const persist = (): void => { assertStateLockHeld("sponsor"); atomic(dbFile, db); };
const reload = (): void => { if (existsSync(dbFile)) db = JSON.parse(readFileSync(dbFile, "utf8")) as Db; };
await withStateLock(env.stateDir, "sponsor", async () => {
  const file = path.join(env.stateDir, "identity.json");
  const identity = { chainId: D.chainId, baal: D.baal, sponsor: sponsor.address };
  if (existsSync(file) && JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(identity)) throw new Error("RELAY_STATE_DIR belongs to another chain, DAO or sponsor; use separate state dirs");
  atomic(file, identity);
});
const secretFile = path.join(env.stateDir, "secret");
await withStateLock(env.stateDir, "sponsor", async () => {
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
});
const secret = Buffer.from(readFileSync(secretFile, "utf8").trim(), "hex");
const startedAt = new Date().toISOString();
/** Rate limits per minute (env overrides for mirrors that compress hours into seconds). */
const RATE_ADDRESS = Number(process.env.RELAY_RATE_ADDRESS ?? 6);
const RATE_IP = Number(process.env.RELAY_RATE_IP ?? 30);
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;

/** sha256 hex of a T0 pass (the public handle of a custodial-lite account). */
const hashPass = (pass: string): string => createHash("sha256").update(pass).digest("hex");

/**
 * Derive the custodial-lite key from the service secret and the pass (HMAC-SHA256).
 *
 * `op=identity&pass=` maps a pass to its address for free, so a guessable pass is a guessable member
 * (audit A5-08): the pass must clear a 128-bit entropy floor (phase 5 ruling 9) before any request
 * that uses it, `op=identity` included.
 *
 * @param pass The passphrase from the query.
 * @returns The derived account.
 * @throws RelayError 400 if the pass is the wrong length or below the entropy floor.
 */
function passAccount(pass: unknown): PrivateKeyAccount {
  if (typeof pass !== "string" || pass.length < 32 || pass.length > 256) fail(400, "pass must contain 32..256 characters");
  const bits = passEntropyBits(pass);
  if (bits < PASS_ENTROPY_FLOOR) {
    fail(400, `pass carries about ${Math.floor(bits)} bits of entropy, below the ${PASS_ENTROPY_FLOOR}-bit floor: a guessable pass is a guessable member because op=identity maps any pass to its address for free. Use 32 random bytes, e.g. openssl rand -base64 32 | tr '+/' '-_' (43 characters), openssl rand -hex 32, or at least 10 random words`);
  }
  return privateKeyToAccount(`0x${createHmac("sha256", secret).update(`zero-one-t0-v1:${pass}`).digest("hex")}`);
}

/**
 * Fixed-window rate limit. The request is counted and PERSISTED before it can be rejected (phase 5
 * ruling 9, audit A5-09): every request begins with reload() + recoverJournal(), which rewrote db.json
 * from the pre-increment state, so a counter that lived only in memory was discarded on every rejected
 * path and the limiter never fired.
 *
 * @param key Bucket key (`ip:<address>`, `address:<member>`, `deploy:<member>`).
 * @param limit Requests allowed per window.
 * @param windowMs Window length in ms (default 60,000).
 * @throws RelayError 429 when the bucket is over the limit (after the increment is on disk).
 */
function rate(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  const entry = db.rates[key] ?? { at: now, n: 0 };
  if (now - entry.at >= windowMs) {
    entry.at = now;
    entry.n = 0;
  }
  entry.n += 1;
  db.rates[key] = entry;
  persist();
  if (entry.n > limit) fail(429, "rate limit; retry after 60 seconds");
}

/** Today's budget row. */
function budgetRow(): { day: string; budget: { wei: string; usdc: string } } {
  const day = new Date().toISOString().slice(0, 10);
  const budget = db.budgets[day] ?? { wei: "0", usdc: "0" };
  db.budgets[day] = budget;
  return { day, budget };
}

/** Run a signature recovery; any malformed signature is a 401, never a raw library error. */
async function recovering<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fail(401, `${what}: signature is malformed or not on the curve`);
  }
}

/** Decode a base64url JSON parameter. */
function decodeParam(value: string | null, name: string): unknown {
  if (value === null || value === "") fail(400, `${name} is required`);
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return fail(400, `${name} must be base64url-encoded JSON`);
  }
}

/** Wait for a receipt; on revert, replay the call at the previous block to decode the reason. */
async function confirmReceipt(hash: Hex, replay: { to: Address; data: Hex; account: Address }): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status === "success") return receipt;
  let reason = "transaction reverted";
  let decoded: { name: string; args: Record<string, string> } | undefined;
  try {
    await client.call({ account: replay.account, to: replay.to, data: replay.data, blockNumber: receipt.blockNumber - 1n });
  } catch (error) {
    const explained = explain(env, error);
    reason = explained.reason;
    decoded = explained.error;
  }
  fail(422, `${reason} (tx ${hash})`, { hash, error: decoded });
}

/** What the receipt says happened, for the response. */
function summarizeReceipt(receipt: TransactionReceipt, member: Address): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const log of receipt.logs) {
    for (const [name, abi] of [["baal", env.abi.baal], ["work", env.abi.work], ["shares", env.abi.shares], ["deposit", env.abi.deposit]] as const) {
      if (log.address.toLowerCase() !== ({ baal: D.baal, work: D.workManager, shares: D.shares, deposit: D.depositShaman }[name] as string).toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics });
        const args = event.args as unknown as Record<string, unknown>;
        if (event.eventName === "SubmitProposal") {
          result.proposalId = Number(args.proposal);
          if (Boolean(args.selfSponsor)) result.sponsored = true;
        }
        if (event.eventName === "SponsorProposal") result.sponsored = true;
        if (event.eventName === "SubmitVote") result.vote = { proposalId: Number(args.proposal), approved: Boolean(args.approved), shares: fmtShares(args.balance as bigint) };
        if (event.eventName === "ProcessProposal") result.processed = { proposalId: Number(args.proposal), passed: Boolean(args.passed), actionFailed: Boolean(args.actionFailed) };
        if (event.eventName === "Ragequit") result.ragequit = { sharesBurned: fmtShares(args.sharesToBurn as bigint) };
        if (event.eventName === "Deposited") result.deposit = { usdc: fmtUsdc(args.amount as bigint), sharesMinted: fmtShares(args.sharesMinted as bigint) };
        if (event.eventName === "TaskProposed") result.task = { taskId: Number(args.taskId), proposalId: Number(args.proposalId) };
        if (event.eventName === "TaskClaimed") result.claimed = { taskId: Number(args.taskId) };
        if (event.eventName === "DeliveryCommitted") result.delivered = { taskId: Number(args.taskId), round: Number(args.round) };
        if (event.eventName === "DeliveryConfirmed") result.confirmed = { taskId: Number(args.taskId), confirmations: Number(args.confirmations) };
        if (event.eventName === "TaskVerified") result.verified = { taskId: Number(args.taskId), worker: args.worker, rewardShares: fmtShares(args.rewardShares as bigint) };
        if (event.eventName === "Transfer" && name === "shares") {
          const from = String(args.from);
          const to = String(args.to);
          if (BigInt(from) === 0n && to.toLowerCase() === member.toLowerCase()) result.sharesMinted = fmtShares(args.value as bigint);
          if (BigInt(to) === 0n && from.toLowerCase() === member.toLowerCase()) result.sharesBurned = fmtShares(args.value as bigint);
        }
      } catch {
        // Not one of ours; ignore.
      }
    }
  }
  return result;
}

/** Wall-clock time of the relay's most recent broadcast; reads within 30 s of it tolerate a lagging RPC node. */
let lastWriteAt = 0;
const LAG_WINDOW_MS = 30_000;
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Simulate a sponsored call (with the delegation injected when the account is not yet delegated) and
 * estimate gas. A load-balanced public RPC may answer from a node that has not yet seen a block the
 * relay just confirmed (faucet, instance deployment, join); within LAG_WINDOW_MS of a broadcast a failing
 * simulation is retried a few times before its reason is reported.
 */
async function simulate(member: Address, data: Hex, delegated: boolean): Promise<bigint> {
  const stateOverride = delegated ? undefined : [{ address: member, code: delegationCode }];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.call({ account: sponsor.address, to: member, data, stateOverride } as never);
      return (await client.estimateGas({ account: sponsor.address, to: member, data, stateOverride } as never)) as bigint;
    } catch (error) {
      if (attempt >= 7 || Date.now() - lastWriteAt > LAG_WINDOW_MS) throw error;
      await sleepMs(1_500);
    }
  }
}

/**
 * identity() that tolerates a lagging node right after this relay changed the account: when the db
 * knows the account joined but the node reports no code, or knows a successful intent with a nonce the
 * node has not reflected, re-read for up to ~12 s before answering.
 */
async function settledIdentity(member: Address): Promise<Awaited<ReturnType<typeof identity>>> {
  const local = db.accounts[member.toLowerCase()];
  const highest = local?.transactions.filter((tx) => tx.status === "success" && /^\d+$/u.test(tx.nonce)).reduce((max, tx) => (BigInt(tx.nonce) > max ? BigInt(tx.nonce) : max), -1n) ?? -1n;
  let id = await identity(env, member);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stale = (local?.joinedAt !== undefined && !id.delegated) || (id.delegated && BigInt(id.nonce) <= highest);
    if (!stale) break;
    await sleepMs(1_500);
    id = await identity(env, member);
  }
  return id;
}

/** Journal signed bytes before the first broadcast. Recovery can only resend this exact transaction. */
interface Pending { raw: Hex; hash: Hex; nonce: number; day: string; reserve: string; digest?: string }
const pendingFile = path.join(env.stateDir, "sponsor-pending.json");
let currentDigest: string | undefined;
async function recoverPending(): Promise<TransactionReceipt | undefined> {
  const pending = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf8")) as Pending | null : null;
  if (!pending) return;
  let receipt = await client.getTransactionReceipt({ hash: pending.hash }).catch(() => undefined);
  if (!receipt) {
    // An RPC timeout may mean it accepted the transaction. Never select another nonce here.
    assertStateLockHeld("sponsor");
    await client.sendRawTransaction({ serializedTransaction: pending.raw }).catch(() => undefined);
    receipt = await client.waitForTransactionReceipt({ hash: pending.hash, timeout: 180_000 });
  }
  db.nextSponsorNonce = Math.max(db.nextSponsorNonce ?? 0, pending.nonce + 1);
  const budget = db.budgets[pending.day];
  if (budget) budget.wei = (BigInt(budget.wei) - BigInt(pending.reserve) + receipt.gasUsed * receipt.effectiveGasPrice).toString();
  if (pending.digest && db.requests[pending.digest]) db.requests[pending.digest] = { ...db.requests[pending.digest], hash: pending.hash, status: receipt.status };
  // Persist settlement with a hash marker; recovery after a crash must not debit the budget twice.
  (db as Db & { settled?: Hex }).settled = pending.hash;
  persist();
  atomic(pendingFile, null);
  lastWriteAt = Date.now();
  invalidateState();
  return receipt;
}
async function recoverJournal(): Promise<void> {
  const pending = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf8")) as Pending | null : null;
  if (pending && (db as Db & { settled?: Hex }).settled === pending.hash) { atomic(pendingFile, null); return; }
  await recoverPending();
  // A pending request without a journal never reached the RPC write (crash before signing).
  for (const [digest, row] of Object.entries(db.requests)) if (row.status === "pending" && row.hash === "0x") delete db.requests[digest];
  persist();
}
/** Called only while the entire request holds the cross-process sponsor lock. */
async function sponsored(tx: { to: Address; data: Hex; gas: bigint; authorizationList?: unknown[]; intent?: boolean }): Promise<TransactionReceipt> {
  const { day, budget } = budgetRow();
  const reserve = tx.gas * policy.maxFeePerGas;
  if (BigInt(budget.wei) + reserve > policy.dailyWei) fail(503, "daily gas sponsorship budget reached; retry tomorrow or send the transaction yourself");
  const balance = await client.getBalance({ address: sponsor.address });
  if (balance < reserve + policy.floorWei) fail(503, "sponsor balance below reserve; send the transaction yourself");
  const nonce = Math.max(db.nextSponsorNonce ?? 0, await client.getTransactionCount({ address: sponsor.address, blockTag: "pending" }));
  const request = await sponsorCtx.walletClient.prepareTransactionRequest({ account: sponsor, chain: env.chain, nonce, to: tx.to, data: tx.data, gas: tx.gas, maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas, ...(tx.authorizationList ? { authorizationList: tx.authorizationList } : {}) } as never);
  const raw = await sponsorCtx.walletClient.signTransaction({ ...request, account: sponsor } as never);
  const hash = keccak256(raw);
  budget.wei = (BigInt(budget.wei) + reserve).toString();
  persist();
  atomic(pendingFile, { raw, hash, nonce, day, reserve: reserve.toString(), ...(tx.intent && currentDigest ? { digest: currentDigest } : {}) });
  const receipt = await recoverPending();
  if (receipt!.status !== "success") return confirmReceipt(hash, { to: tx.to, data: tx.data, account: sponsor.address });
  return receipt!;
}

/** Test chains: top the member's settlement up to `amount` from the sponsor's own balance. */
async function faucet(member: Address, amount: bigint): Promise<{ topped: bigint; hash?: Hex }> {
  if (!policy.faucet) return { topped: 0n };
  const balance = (await client.readContract({ address: D.settlement, abi: env.abi.settlement, functionName: "balanceOf", args: [member] })) as bigint;
  if (balance >= amount) return { topped: 0n };
  const needed = amount - balance;
  const { budget } = budgetRow();
  if (BigInt(budget.usdc) + needed > policy.faucetDailyUnits) fail(503, `daily test-USDC faucet budget reached (${fmtUsdc(policy.faucetDailyUnits)} USDC/day)`);
  const sponsorUsdc = (await client.readContract({ address: D.settlement, abi: env.abi.settlement, functionName: "balanceOf", args: [sponsor.address] })) as bigint;
  if (sponsorUsdc < needed) fail(503, `faucet empty: the sponsor holds ${fmtUsdc(sponsorUsdc)} test USDC, ${fmtUsdc(needed)} needed`);
  budget.usdc = (BigInt(budget.usdc) + needed).toString();
  persist();
  const data = encodeFunctionData({ abi: env.abi.settlement, functionName: "transfer", args: [member, needed] });
  const receipt = await sponsored({ to: D.settlement, data, gas: 100_000n });
  const hash = receipt.transactionHash;
  return { topped: needed, hash };
}

/** Shares held and the sponsor threshold. */
async function sharesAndThreshold(member: Address): Promise<{ shares: bigint; threshold: bigint }> {
  const [shares, threshold] = await Promise.all([
    client.readContract({ address: D.shares, abi: env.abi.shares, functionName: "balanceOf", args: [member] }) as Promise<bigint>,
    client.readContract({ address: D.baal, abi: env.abi.baal, functionName: "sponsorThreshold" }) as Promise<bigint>,
  ]);
  return { shares, threshold };
}

/**
 * Ruling 3: deploy the template instance a propose intent names when its CREATE2 address is still
 * empty. Sponsored, members holding >= sponsorThreshold only, rate-limited, under the daily budget.
 *
 * @param member The proposer (operator of the instance).
 * @param data The intent's data: abi.encode(template id, params, salt).
 * @returns The instance address and, when the sponsor deployed it, the deployment hash.
 */
async function ensureInstance(member: Address, data: Hex): Promise<{ instance: Address; template: string; deployHash?: Hex; codeHash: Hex }> {
  let decoded: ReturnType<typeof decodeProposeIntentData>;
  try {
    decoded = decodeProposeIntentData(data);
  } catch (error) {
    return fail(400, `propose data must be abi.encode(uint8 template, bytes params, bytes32 salt) from op=quote: ${error instanceof Error ? error.message : String(error)}`);
  }
  const instance = getAddress((await client.readContract({ address: D.templateFactory, abi: env.abi.factory, functionName: "predict", args: [decoded.templateId, decoded.paramsBytes, member, decoded.salt] })) as Address);
  const existing = await client.getCode({ address: instance });
  if (existing !== undefined && existing !== "0x") {
    // docs/TESTNET_PLAN.md: the same (template, params, member, salt) proposed twice must be refused, not
    // funded twice; a second fund+start of one instance would only actionFail at execution (start() WrongStatus).
    const state = await readDaoState(env, 0);
    const prior = state.proposals.find((proposal) => proposal.instance !== undefined && getAddress(proposal.instance.address) === instance);
    if (prior !== undefined) fail(409, `instance ${instance} is already the subject of proposal #${prior.id} (${prior.state}); quote again with a new salt (op=quote picks a fresh one when salt is omitted)`, { instance, proposalId: prior.id });
    return { instance, template: decoded.template, codeHash: keccak256(existing) };
  }
  const { shares, threshold } = await sharesAndThreshold(member);
  if (shares < threshold) fail(409, `sponsored template deployments need at least ${fmtShares(threshold)} shares (you hold ${fmtShares(shares)}); deposit first`);
  rate(`deploy:${member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  const simulation = await client.simulateContract({ address: D.templateFactory, abi: env.abi.factory, functionName: "deploy", args: [decoded.templateId, decoded.paramsBytes, member, decoded.salt], account: sponsor.address } as never);
  const [predicted] = simulation.result as unknown as [Address, Hex];
  if (getAddress(predicted) !== instance) fail(422, `factory would deploy at ${predicted}, predicted ${instance}`);
  const gas = ((simulation.request as { gas?: bigint }).gas ?? (await client.estimateGas({ account: sponsor.address, to: D.templateFactory, data: encodeFunctionData({ abi: env.abi.factory, functionName: "deploy", args: [decoded.templateId, decoded.paramsBytes, member, decoded.salt] }) } as never))) as bigint;
  const receipt = await sponsored({ to: D.templateFactory, data: encodeFunctionData({ abi: env.abi.factory, functionName: "deploy", args: [decoded.templateId, decoded.paramsBytes, member, decoded.salt] }), gas: (gas * 13n) / 10n + 30_000n });
  const code = await awaitCode(client, instance);
  if (code === undefined || code === "0x") fail(422, `template instance did not appear at ${instance} (tx ${receipt.transactionHash})`, { hash: receipt.transactionHash });
  return { instance, template: decoded.template, deployHash: receipt.transactionHash, codeHash: keccak256(code) };
}

/**
 * Ruling 7: a vote reads the member's share checkpoint at the proposal's votingStarts, which is
 * undetermined until a block with a later timestamp exists. When the latest block is not past
 * votingStarts, wait for the next block(s) before sending the vote.
 *
 * @param proposalId The proposal being voted on.
 * @returns Blocks waited (0 when the checkpoint was already determined).
 * @throws RelayError 409 if no later block appears within 120 s.
 */
async function awaitVotingCheckpoint(proposalId: number): Promise<number> {
  const raw = (await client.readContract({ address: D.baal, abi: env.abi.baal, functionName: "proposals", args: [proposalId] })) as readonly unknown[];
  const votingStarts = BigInt(raw[2] as bigint);
  if (votingStarts === 0n) return 0;
  let block = await client.getBlock();
  if (block.timestamp > votingStarts) return 0;
  const first = block.number;
  const started = Date.now();
  while (block.timestamp <= votingStarts) {
    if (Date.now() - started > 120_000) fail(409, `vote too early: proposal ${proposalId} was sponsored at chain time ${votingStarts} and no later block exists yet; retry after the next block`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    block = await client.getBlock();
  }
  return Number(block.number - first);
}

/** Record a member transaction in the db. */
function record(member: Address, custodial: boolean, entry: { hash: Hex; op: number; verb: string; nonce: string; status: string }, passHash?: string): void {
  const key = member.toLowerCase();
  const local = db.accounts[key] ?? { custodial, transactions: [] };
  local.transactions.push({ ...entry, at: new Date().toISOString() });
  db.accounts[key] = local;
  if (passHash !== undefined) db.passes[passHash] = key;
  persist();
}

/**
 * Attach the adapter to `member` (EIP-7702). Mints nothing, changes no DAO state.
 *
 * @param member The address that signed the authorization.
 * @param authorization The validated authorization.
 * @returns The response body.
 */
async function join(member: Address, authorization: ReturnType<typeof normalizeAuthorization> | undefined, custodial: boolean, passHash?: string): Promise<Record<string, unknown>> {
  const id = await identity(env, member);
  if (id.delegated) {
    db.accounts[member.toLowerCase()] ??= { custodial, joinedAt: new Date().toISOString(), transactions: [] };
    if (passHash) db.passes[passHash] = member;
    persist();
    return { ok: true, verb: "join", address: member, delegated: true, alreadyJoined: true, nonce: id.nonce, note: "mints nothing; deposit at NAV or earn shares by verified work" };
  }
  if (authorization === undefined) fail(400, "authorization (signed EIP-7702 delegation to the adapter) is required to join");
  if (authorization.nonce !== id.authorizationNonce) fail(409, `authorization.nonce must be ${id.authorizationNonce} (read /me/${member}.json)`);
  const signer = await recovering("authorization", () => recoverAuthorizationAddress({ authorization: { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity } }));
  if (signer.toLowerCase() !== member.toLowerCase()) fail(401, "authorization signer mismatch");
  rate(`address:${member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  // The delegation rides on a no-op transaction to the sponsor itself (a call to the fresh account would revert: the adapter has no fallback).
  const receipt = await sponsored({ to: sponsor.address, data: "0x", gas: 100_000n, authorizationList: [authorization] });
  let code = await client.getCode({ address: member });
  for (let attempt = 0; attempt < 10 && (code ?? "0x").toLowerCase() !== delegationCode; attempt += 1) {
    await sleepMs(1_500);
    code = await client.getCode({ address: member });
  }
  if ((code ?? "0x").toLowerCase() !== delegationCode) fail(422, `delegation did not take effect (tx ${receipt.transactionHash})`, { hash: receipt.transactionHash });
  record(member, custodial, { hash: receipt.transactionHash, op: -1, verb: "join", nonce: "-", status: "success" }, passHash);
  db.accounts[member.toLowerCase()]!.joinedAt = new Date().toISOString();
  persist();
  return { ok: true, verb: "join", address: member, delegated: true, hash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), nonce: "0", shares: "0", note: "mints nothing; deposit at NAV or earn shares by verified work" };
}

/**
 * Verify and broadcast a signed intent envelope.
 *
 * @param envelope Parsed `{message, signature, authorization?}`.
 * @param custodial Whether the relay signed it (T0).
 * @param passHash T0 pass hash to bind to the account.
 * @returns The response body (hash + decoded result).
 */
async function submit(envelope: Envelope, custodial = false, passHash?: string): Promise<Record<string, unknown>> {
  const m: Intent = normalize(envelope.message);
  if (m.member.toLowerCase() === sponsor.address.toLowerCase()) fail(403, "reserved sponsor address");
  if (typeof envelope.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(envelope.signature)) fail(400, "signature must be a 65-byte hex string");
  const typed = { domain: intentDomain(adapter, D.chainId), types: INTENT_TYPES, primaryType: "Intent" as const, message: m };
  const recovered = await recovering("intent signature", () => recoverTypedDataAddress({ ...typed, signature: envelope.signature }));
  if (recovered.toLowerCase() !== m.member.toLowerCase()) fail(401, "signature mismatch: the intent was not signed by intent.member for this chain and adapter");
  const digest = hashTypedData(typed);
  const prior = db.requests[digest];
  if (prior !== undefined) {
    // Phase 5 ruling 7 (audit A5-10): never answer ok from the dedupe map alone. A recorded row proves
    // nothing unless the transaction it names is on chain, so the receipt is read before the answer; a
    // row without one (a crash, a reorg, or a seeded db.json) is dropped and the intent is broadcast now.
    const receipt = prior.hash === "0x" ? undefined : await client.getTransactionReceipt({ hash: prior.hash }).catch(() => undefined);
    if (receipt !== undefined) {
      return { ok: receipt.status === "success", replayed: true, hash: prior.hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(), verb: OP_NAMES[prior.op] };
    }
    delete db.requests[digest];
    persist();
  }
  rate(`address:${m.member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  const id = await settledIdentity(m.member);
  const now = BigInt(id.chainTime);
  if (m.deadline < now) fail(400, `intent expired: deadline ${m.deadline} is before chain time ${now}`);
  if (m.deadline > now + 3600n) fail(400, `intent deadline must be within one hour of chain time ${now}`);
  if (BigInt(id.nonce) !== m.nonce) fail(409, `nonce changed: expected ${id.nonce}; read /me and sign again`);
  let authorizationList: unknown[] | undefined;
  if (!id.delegated) {
    if (envelope.authorization === undefined) fail(400, `address ${m.member} is not delegated: join first (op=join) or attach an EIP-7702 authorization to this envelope`);
    const auth = normalizeAuthorization(envelope.authorization, D.chainId, adapter);
    if (auth.nonce !== id.authorizationNonce) fail(409, `authorization.nonce must be ${id.authorizationNonce}`);
    const signer = await recovering("authorization", () => recoverAuthorizationAddress({ authorization: auth }));
    if (signer.toLowerCase() !== m.member.toLowerCase()) fail(401, "authorization signer mismatch");
    authorizationList = [auth];
  }
  const verb = OP_NAMES[m.op];
  if (verb === undefined) fail(400, `unknown op ${m.op}`);
  let faucetNote: Record<string, unknown> = {};
  if (m.op === OPS.deposit) {
    const topped = await faucet(m.member, m.amount);
    if (topped.topped > 0n) faucetNote = { faucet: { toppedUpUsdc: fmtUsdc(topped.topped), hash: topped.hash } };
  }
  if (m.op === OPS.propose) {
    // Proposals through the relay are self-sponsored: the ninth verb (sponsor) does not exist (ruling 4).
    const { shares, threshold } = await sharesAndThreshold(m.member);
    if (shares < threshold) fail(409, `propose needs at least ${fmtShares(threshold)} shares so the proposal is self-sponsored (you hold ${fmtShares(shares)}); deposit first`);
    const ensured = await ensureInstance(m.member, m.data);
    faucetNote = { instance: ensured.instance, template: ensured.template, codeHash: ensured.codeHash, ...(ensured.deployHash ? { deployHash: ensured.deployHash, deployedBy: "relay sponsor" } : { deployedBy: "already on chain" }) };
  }
  let waitedBlocks = 0;
  if (m.op === OPS.vote) waitedBlocks = await awaitVotingCheckpoint(m.proposalId);
  const data = encodeFunctionData({ abi: env.abi.account, functionName: "executeIntent", args: [m, envelope.signature] });
  const estimate = await simulate(m.member, data, id.delegated);
  const gas = m.op === OPS.execute ? (estimate > PROCESS_GAS ? (estimate * 13n) / 10n : PROCESS_GAS + 600_000n) : (estimate * 13n) / 10n + 30_000n;
  if (gas > 8_000_000n) fail(400, `intent needs ${gas} gas, above the sponsored maximum of 8000000`);
  db.requests[digest] = { hash: "0x" as Hex, member: m.member, op: m.op, status: "pending" };
  let receipt: TransactionReceipt;
  try {
    currentDigest = digest;
    persist();
    receipt = await sponsored({ to: m.member, data, gas, authorizationList, intent: true });
  } catch (error) {
    const hash = error instanceof RelayError ? ((error.details as { hash?: Hex } | undefined)?.hash ?? ("0x" as Hex)) : ("0x" as Hex);
    if (hash !== "0x") {
      db.requests[digest] = { hash, member: m.member, op: m.op, status: "reverted" };
      record(m.member, custodial, { hash, op: m.op, verb, nonce: m.nonce.toString(), status: "reverted" }, passHash);
    } else if (!existsSync(pendingFile) || JSON.parse(readFileSync(pendingFile, "utf8")) === null) delete db.requests[digest];
    persist();
    throw error;
  }
  db.requests[digest] = { hash: receipt.transactionHash, member: m.member, op: m.op, status: "success" };
  record(m.member, custodial, { hash: receipt.transactionHash, op: m.op, verb, nonce: m.nonce.toString(), status: "success" }, passHash);
  const summary = summarizeReceipt(receipt, m.member);
  return { ok: true, verb, op: m.op, member: m.member, hash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), nonceUsed: m.nonce.toString(), nextNonce: (m.nonce + 1n).toString(), ...(m.op === OPS.vote ? { waitedBlocks } : {}), ...summary, ...faucetNote };
}

/**
 * Read-only quote for propose: the deterministic instance for (template, params, member, salt) and
 * the ONE op-0 intent to sign. Nothing is deployed and nothing is signed here; the sponsor deploys
 * the instance only when the signed intent arrives (ruling 3), and the account rebuilds the same
 * address and multicall from the signed data on-chain (ruling 2).
 *
 * @param q Query: member, template, params (JSON), summary, salt (default: the member's intent nonce).
 * @param memberOverride T0 account (the pass path).
 * @returns The quote and the intent message to sign.
 */
async function quote(q: URLSearchParams, memberOverride?: PrivateKeyAccount): Promise<Record<string, unknown>> {
  const member = memberOverride ? memberOverride.address : (q.get("member") as string | null);
  if (member === null || !isAddress(member)) fail(400, "member (address) is required");
  const template = q.get("template") ?? "";
  const params = q.get("params") ?? "";
  const summary = q.get("summary") ?? `${template} proposal by ${getAddress(member)}`;
  if (params === "") fail(400, "params (JSON) is required");
  let parsedParams: unknown;
  try {
    parsedParams = JSON.parse(params);
  } catch {
    fail(400, "params must be JSON");
  }
  const spec = parseSpec(template, parsedParams);
  const id = await settledIdentity(getAddress(member));
  const saltParam = q.get("salt");
  if (saltParam !== null && !/^0x[0-9a-fA-F]{64}$/u.test(saltParam)) fail(400, "salt must be bytes32 hex");
  const salt = (saltParam?.toLowerCase() as Hex | undefined) ?? numberToHex(BigInt(id.nonce), { size: 32 });
  const quoted = await quoteProposal(env, getAddress(member), spec, summary, salt);
  const intent = buildIntent("propose", new URLSearchParams({ data: quoted.intentData, details: quoted.details }), { member: getAddress(member), nonce: BigInt(id.nonce), chainTime: id.chainTime, settlement: D.settlement });
  const { shares, threshold } = await sharesAndThreshold(getAddress(member));
  return {
    ok: true,
    verb: "quote",
    instance: quoted.instance.address,
    exists: quoted.exists,
    template: quoted.instance.template,
    templateId: TEMPLATE_IDS[quoted.instance.template],
    contract: quoted.instance.contractName,
    codeHash: quoted.instance.codeHash,
    paramsHash: quoted.instance.paramsHash,
    paramsBytes: quoted.instance.paramsBytes,
    salt,
    operator: quoted.instance.description.operator,
    budget: quoted.instance.description.budget.toString(),
    budgetUsdc: fmtUsdc(quoted.instance.description.budget),
    deadline: quoted.instance.description.deadline.toString(),
    calls: quoted.calls,
    proposalData: quoted.proposalData,
    details: quoted.details,
    canPropose: shares >= threshold,
    shares: shares.toString(),
    sponsorThreshold: threshold.toString(),
    message: toWire(intent),
    domain: id.domain,
    next: "sign `message` (EIP-712 Intent, op 0: data = abi.encode(template, params, salt)) with your key and GET /relay?intent=<base64url {message, signature}>; the relay deploys the instance at `instance` if it is still empty, then your account submits the proposal that funds and starts exactly that address",
  };
}

/** T0 request: derive the key from the pass, build and sign the intent, submit. */
async function custodial(q: URLSearchParams): Promise<Record<string, unknown>> {
  const pass = q.get("pass");
  const key = passAccount(pass);
  const ph = hashPass(pass as string);
  const op = q.get("op") ?? "";
  const id = await settledIdentity(key.address);
  if (op === "identity") return { ok: true, ...id, custody: "custodial-lite", me: `/me/pass/${ph}.json` };
  const authorization = id.delegated ? undefined : await key.signAuthorization({ contractAddress: adapter, chainId: D.chainId, nonce: id.authorizationNonce });
  const auth = authorization ? { chainId: D.chainId, address: adapter, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity as 0 | 1 } : undefined;
  if (op === "join") return join(key.address, auth, true, ph);
  if (!(VERBS as string[]).includes(op)) fail(400, `unknown op ${op}; T0 verbs: join, deposit, task, deliver, propose, vote, execute, ragequit, work, confirm (sponsor no longer exists: work self-sponsors)`);
  const state = await readDaoState(env);
  let query = q;
  let extra: Record<string, unknown> = {};
  if (op === "propose") {
    if (!id.delegated) fail(409, "join first (op=join) so the proposal is submitted from your delegated account");
    const quoted = await quote(q, key);
    query = new URLSearchParams({ data: (quoted.message as { data: string }).data, details: quoted.details as string });
    extra = { instance: quoted.instance, codeHash: quoted.codeHash, paramsHash: quoted.paramsHash, operator: quoted.operator, budgetUsdc: quoted.budgetUsdc, salt: quoted.salt };
  }
  const shares = (await client.readContract({ address: D.shares, abi: env.abi.shares, functionName: "balanceOf", args: [key.address] })) as bigint;
  const intent = buildIntent(op as Verb, query, { member: key.address, nonce: BigInt(id.nonce), chainTime: id.chainTime, settlement: D.settlement, shares, proposalData: (pid) => state.proposals.find((p) => p.id === pid)?.proposalData });
  const signature = await key.signTypedData({ domain: intentDomain(adapter, D.chainId), types: INTENT_TYPES, primaryType: "Intent", message: intent });
  const result = await submit({ message: toWire(intent), signature, authorization: auth }, true, ph);
  return { ...result, ...extra, custody: "custodial-lite", me: `/me/pass/${ph}.json` };
}

/** Route one request. */
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const send = (code: number, body: string, type = "application/json; charset=utf-8"): void => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", ...(code === 429 ? { "Retry-After": "60" } : {}) });
    res.end(body);
  };
  try {
    if (req.method !== "GET") fail(405, "GET required");
    const rawUrl = req.url ?? "/";
    if (rawUrl.length > 32_000) fail(414, "URL too long");
    const u = new URL(rawUrl, "http://localhost");
    if (u.pathname === "/health.json") {
      const [balance, block] = await Promise.all([client.getBalance({ address: sponsor.address }), client.getBlockNumber()]);
      return send(200, json({ service: "zero-one-relay", dao: "Zero One", chainId: D.chainId, chain: policy.name, adapter, baal: D.baal, safe: D.safe, settlement: D.settlement, constitution: D.constitution, sponsor: sponsor.address, sponsorBalanceWei: balance.toString(), blockNumber: block.toString(), policy: { dailyWei: policy.dailyWei.toString(), faucet: policy.faucet, faucetDailyUnits: policy.faucetDailyUnits.toString(), maxFeePerGas: policy.maxFeePerGas.toString(), ratePerAddressPerMinute: RATE_ADDRESS, ratePerIpPerMinute: RATE_IP, queue: 8, passEntropyFloorBits: PASS_ENTROPY_FLOOR }, verbs: ["join", "deposit", "task", "deliver", "propose", "vote", "execute", "ragequit", "work", "confirm"], templateFactory: D.templateFactory, startedAt, queued, alive: true }));
    }
    if (u.pathname === "/pending.json") {
      // Phase 5 ruling 7 (A5-10): what this relay is holding right now. A member whose intent is not
      // here and has no hash was never broadcast: send it through another relay or straight to Baal.
      reload();
      const journal = existsSync(pendingFile) ? (JSON.parse(readFileSync(pendingFile, "utf8")) as Pending | null) : null;
      const inFlight = Object.entries(db.requests)
        .filter(([, row]) => row.status === "pending")
        .map(([digest, row]) => ({ digest, member: row.member, op: row.op, verb: OP_NAMES[row.op] ?? String(row.op), status: row.status, hash: row.hash }));
      return send(200, json({
        service: "zero-one-relay",
        chainId: D.chainId,
        sponsor: sponsor.address,
        queued,
        inFlight,
        journal: journal === null ? null : { hash: journal.hash, nonce: journal.nonce, digest: journal.digest ?? null, day: journal.day },
        note: "an intent is answered ok only after its transaction is on chain; anything listed here is unfinished, and anything listed nowhere was never broadcast. The relay operator can delay or drop your intents: verify the hash on chain, and send anything you cannot afford to lose from your own key (T1).",
        generatedAt: new Date().toISOString(),
      }));
    }
    if (u.pathname === "/proposals.json") {
      // Paging (docs/TESTNET_PLAN.md spam row): ?open=1 keeps only open proposals; ?before=<id>&limit=<n> pages
      // newest first (default: every proposal, newest last, as before).
      const state = await readDaoState(env);
      let proposals = state.proposals;
      if (u.searchParams.get("open") === "1") proposals = proposals.filter((proposal) => state.openProposals.includes(proposal.id));
      const before = u.searchParams.get("before");
      const limit = u.searchParams.get("limit");
      if (before !== null || limit !== null) {
        const max = before !== null ? Number(before) : Number.POSITIVE_INFINITY;
        const size = limit !== null ? Number(limit) : 50;
        if (!Number.isInteger(size) || size < 1 || size > 500) fail(400, "limit must be an integer from 1 to 500");
        if (before !== null && !Number.isInteger(max)) fail(400, "before must be a proposal id");
        proposals = proposals.filter((proposal) => proposal.id < max).sort((a, b) => b.id - a.id).slice(0, size);
      }
      return send(200, json({ chain: state.chain, governance: state.governance, openProposals: state.openProposals, total: state.proposals.length, proposals, nextBefore: proposals.length > 0 && (before !== null || limit !== null) ? Math.min(...proposals.map((proposal) => proposal.id)) : undefined, generatedAt: state.generatedAt }));
    }
    if (u.pathname === "/state.json") {
      if (stateFile !== undefined && existsSync(stateFile)) return send(200, readFileSync(stateFile, "utf8"));
      return send(200, json(await readDaoState(env)));
    }
    if (u.pathname.startsWith("/me/")) {
      let address = /^\/me\/(0x[0-9a-fA-F]{40})\.json$/u.exec(u.pathname)?.[1];
      let custody: Me["custody"] = "self-custody";
      const ph = /^\/me\/pass\/([0-9a-f]{64})\.json$/u.exec(u.pathname)?.[1];
      if (ph !== undefined) {
        address = db.passes[ph];
        custody = "custodial-lite";
      }
      if (address === undefined || !isAddress(address)) fail(404, "unknown address or pass hash");
      return send(200, json(await me(env, getAddress(address), custody, undefined, await settledIdentity(getAddress(address)))));
    }
    if (u.pathname !== "/relay") fail(404, "not found; see /health.json, /me/<address>.json, /proposals.json, /state.json, /pending.json, /relay");
    if (queued >= 8) fail(503, "relay queue full; retry in a few seconds");
    queued += 1;
    const task = queue.then(() => withStateLock(env.stateDir, "sponsor", async () => {
      reload();
      await recoverJournal();
      currentDigest = undefined;
      rate(`ip:${String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress)}`, RATE_IP);
      const q = u.searchParams;
      if (q.has("intent")) {
        const envelope = decodeParam(q.get("intent"), "intent") as Envelope;
        return submit(envelope);
      }
      if (q.has("pass")) return custodial(q);
      const op = q.get("op");
      if (op === "join") {
        const auth = decodeParam(q.get("authorization"), "authorization") as Record<string, unknown>;
        const normalized = normalizeAuthorization(auth, D.chainId, adapter);
        const signer = await recovering("authorization", () => recoverAuthorizationAddress({ authorization: normalized }));
        return join(getAddress(signer), normalized, false);
      }
      if (op === "quote") return quote(q);
      return fail(400, "expected intent=<base64url envelope>, op=join&authorization=<base64url>, op=quote&member=..&template=..&params=..[&summary=&salt=], or op=<verb>&pass=<secret>");
    }));
    queue = task.catch(() => undefined);
    let result: Record<string, unknown>;
    try {
      result = await task;
    } finally {
      queued -= 1;
    }
    return send(200, json(result));
  } catch (error) {
    const explained = explain(env, error);
    const body = json({ ok: false, status: explained.status, reason: explained.reason, ...(explained.error ? { error: explained.error } : {}), ...(explained.hash ? { hash: explained.hash } : {}) });
    if (explained.status >= 500 || process.env.RELAY_LOG === "1") console.error(`[relay] ${(req.url ?? "").replace(/pass=[^&]+/gu, "pass=<redacted>").slice(0, 200)} -> ${explained.status} ${explained.reason}`);
    return send(explained.status, body);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(json({ ok: false, status: 500, reason: error instanceof Error ? error.message : String(error) }));
  });
});
server.requestTimeout = 180_000;
server.headersTimeout = 10_000;
const port = Number(process.env.RELAY_PORT ?? 18_751);
const host = process.env.RELAY_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(json({ listening: `${host}:${port}`, startedAt, chainId: D.chainId, adapter, sponsor: sponsor.address, deployment: process.env.ZERO_ONE_DEPLOYMENT ?? "deployments/local.json", stateDir: env.stateDir }));
});
export { decodeRevert, ZERO_ADDRESS };
