/**
 * Zero One relay: sponsored GET intents for the eight verbs (join, deposit, task, deliver, propose,
 * vote, execute, ragequit) plus work (submitTask) and confirm, over the EIP-7702 adapter
 * (ZeroOneIntentAccount). Pattern: agent-only-wallet/relay/server.mjs. T1 agents sign with their own
 * key; T0 agents use a passphrase whose key the relay derives (custodial-lite). Every response is JSON;
 * every failure carries a decoded reason (docs/RELAY.md).
 *
 * Endpoints: /health.json, /me/<address>.json, /me/pass/<sha256(pass)>.json, /proposals.json,
 * /state.json, /relay?intent=<base64url envelope>, /relay?op=<verb>&pass=<secret>&..., /relay?op=join,
 * /relay?op=prepare (T1 propose step 1). Usage: tsx relay/server.ts (env: ZERO_ONE_DEPLOYMENT,
 * RELAY_SPONSOR_KEY, RELAY_PORT, RELAY_STATE_DIR, ZERO_ONE_STATE_FILE, ZERO_ONE_RPC_URL).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { decodeEventLog, encodeFunctionData, getAddress, hashTypedData, isAddress, recoverTypedDataAddress, verifyMessage, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import { invalidateState, readDaoState } from "./chain.js";
import { atomic, connect, fmtShares, fmtUsdc, json, PROCESS_GAS, sponsorAccount, sponsorContext, ZERO_ADDRESS, type Env } from "./common.js";
import { decodeRevert, explain, fail, RelayError } from "./errors.js";
import { buildIntent, INTENT_TYPES, intentDomain, normalize, normalizeAuthorization, OP_NAMES, OPS, toWire, VERBS, type Envelope, type Intent, type Verb } from "./intents.js";
import { identity, me, type Me } from "./me.js";
import { parseSpec, prepareMessage, prepareProposal } from "./templates.js";

const env: Env = connect();
const sponsor: PrivateKeyAccount = sponsorAccount();
const sponsorCtx = sponsorContext(env, sponsor);
const { deployment: D, policy, publicClient: client } = env;
const adapter = D.intentAccount;
const delegationCode = `0xef0100${adapter.slice(2)}`.toLowerCase() as Hex;
const stateFile = process.env.ZERO_ONE_STATE_FILE;

/** Persistent relay database (accounts, T0 pass hashes, request dedupe, budgets, rate windows). */
interface Db {
  accounts: Record<string, { custodial: boolean; joinedAt?: string; transactions: Array<{ hash: Hex; op: number; verb: string; nonce: string; at: string; status?: string }> }>;
  passes: Record<string, string>;
  requests: Record<string, { hash: Hex; member: Address; op: number; status: string }>;
  budgets: Record<string, { wei: string; usdc: string }>;
  rates: Record<string, { at: number; n: number }>;
}
const dbFile = path.join(env.stateDir, "db.json");
const db: Db = existsSync(dbFile) ? (JSON.parse(readFileSync(dbFile, "utf8")) as Db) : { accounts: {}, passes: {}, requests: {}, budgets: {}, rates: {} };
const persist = (): void => atomic(dbFile, db);
const secretFile = path.join(env.stateDir, "secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const secret = Buffer.from(readFileSync(secretFile, "utf8").trim(), "hex");
const startedAt = new Date().toISOString();
/** Rate limits per minute (env overrides for mirrors that compress hours into seconds). */
const RATE_ADDRESS = Number(process.env.RELAY_RATE_ADDRESS ?? 6);
const RATE_IP = Number(process.env.RELAY_RATE_IP ?? 30);
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;

/** sha256 hex of a T0 pass (the public handle of a custodial-lite account). */
const hashPass = (pass: string): string => createHash("sha256").update(pass).digest("hex");

/** Derive the custodial-lite key from the service secret and the pass (HMAC-SHA256). */
function passAccount(pass: unknown): PrivateKeyAccount {
  if (typeof pass !== "string" || pass.length < 32 || pass.length > 256) fail(400, "pass must contain 32..256 characters");
  return privateKeyToAccount(`0x${createHmac("sha256", secret).update(`zero-one-t0-v1:${pass}`).digest("hex")}`);
}

/** Fixed-window rate limit; throws 429 when exceeded. */
function rate(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  const entry = db.rates[key] ?? { at: now, n: 0 };
  if (now - entry.at >= windowMs) {
    entry.at = now;
    entry.n = 0;
  }
  if (entry.n >= limit) fail(429, "rate limit; retry after 60 seconds");
  entry.n += 1;
  db.rates[key] = entry;
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

/** Simulate a sponsored call (with the delegation injected when the account is not yet delegated) and estimate gas. */
async function simulate(member: Address, data: Hex, delegated: boolean): Promise<bigint> {
  const stateOverride = delegated ? undefined : [{ address: member, code: delegationCode }];
  await client.call({ account: sponsor.address, to: member, data, stateOverride } as never);
  const estimate = (await client.estimateGas({ account: sponsor.address, to: member, data, stateOverride } as never)) as bigint;
  return estimate;
}

/** Sponsor a transaction under the daily budget and floor; returns the receipt. */
async function sponsored(tx: { to: Address; data: Hex; gas: bigint; authorizationList?: unknown[] }): Promise<TransactionReceipt> {
  const { budget } = budgetRow();
  const reserve = tx.gas * policy.maxFeePerGas;
  if (BigInt(budget.wei) + reserve > policy.dailyWei) fail(503, "daily gas sponsorship budget reached; retry tomorrow or send the transaction yourself");
  const balance = await client.getBalance({ address: sponsor.address });
  if (balance < reserve + policy.floorWei) fail(503, "sponsor balance below reserve; send the transaction yourself");
  budget.wei = (BigInt(budget.wei) + reserve).toString();
  persist();
  const hash = await sponsorCtx.walletClient.sendTransaction({ account: sponsor, chain: env.chain, to: tx.to, data: tx.data, gas: tx.gas, maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas, ...(tx.authorizationList ? { authorizationList: tx.authorizationList } : {}) } as never);
  invalidateState();
  try {
    return await confirmReceipt(hash, { to: tx.to, data: tx.data, account: sponsor.address });
  } finally {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    const spent = receipt ? receipt.gasUsed * receipt.effectiveGasPrice : reserve;
    budget.wei = (BigInt(budget.wei) - reserve + spent).toString();
    persist();
  }
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
  const hash = await sponsorCtx.walletClient.writeContract({ account: sponsor, chain: env.chain, address: D.settlement, abi: env.abi.settlement, functionName: "transfer", args: [member, needed], maxFeePerGas: policy.maxFeePerGas, maxPriorityFeePerGas: policy.maxPriorityFeePerGas } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(503, `faucet transfer reverted (tx ${hash})`);
  return { topped: needed, hash };
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
  if (id.delegated) return { ok: true, verb: "join", address: member, delegated: true, alreadyJoined: true, nonce: id.nonce, note: "mints nothing; deposit at NAV or earn shares by verified work" };
  if (authorization === undefined) fail(400, "authorization (signed EIP-7702 delegation to the adapter) is required to join");
  if (authorization.nonce !== id.authorizationNonce) fail(409, `authorization.nonce must be ${id.authorizationNonce} (read /me/${member}.json)`);
  const signer = await recovering("authorization", () => recoverAuthorizationAddress({ authorization: { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity } }));
  if (signer.toLowerCase() !== member.toLowerCase()) fail(401, "authorization signer mismatch");
  rate(`address:${member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  // The delegation rides on a no-op transaction to the sponsor itself (a call to the fresh account would revert: the adapter has no fallback).
  const receipt = await sponsored({ to: sponsor.address, data: "0x", gas: 100_000n, authorizationList: [authorization] });
  const code = await client.getCode({ address: member });
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
  if (prior) return { ok: prior.status === "success", replayed: true, hash: prior.hash, status: prior.status, verb: OP_NAMES[prior.op] };
  rate(`address:${m.member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  const id = await identity(env, m.member);
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
  const data = encodeFunctionData({ abi: env.abi.account, functionName: "executeIntent", args: [m, envelope.signature] });
  const estimate = await simulate(m.member, data, id.delegated);
  const gas = m.op === OPS.execute ? (estimate > PROCESS_GAS ? (estimate * 13n) / 10n : PROCESS_GAS + 600_000n) : (estimate * 13n) / 10n + 30_000n;
  if (gas > 8_000_000n) fail(400, `intent needs ${gas} gas, above the sponsored maximum of 8000000`);
  db.requests[digest] = { hash: "0x" as Hex, member: m.member, op: m.op, status: "pending" };
  let receipt: TransactionReceipt;
  try {
    receipt = await sponsored({ to: m.member, data, gas, authorizationList });
  } catch (error) {
    const hash = error instanceof RelayError ? ((error.details as { hash?: Hex } | undefined)?.hash ?? ("0x" as Hex)) : ("0x" as Hex);
    if (hash !== "0x") {
      db.requests[digest] = { hash, member: m.member, op: m.op, status: "reverted" };
      record(m.member, custodial, { hash, op: m.op, verb, nonce: m.nonce.toString(), status: "reverted" }, passHash);
    } else delete db.requests[digest];
    persist();
    throw error;
  }
  db.requests[digest] = { hash: receipt.transactionHash, member: m.member, op: m.op, status: "success" };
  record(m.member, custodial, { hash: receipt.transactionHash, op: m.op, verb, nonce: m.nonce.toString(), status: "success" }, passHash);
  const summary = summarizeReceipt(receipt, m.member);
  return { ok: true, verb, op: m.op, member: m.member, hash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), nonceUsed: m.nonce.toString(), nextNonce: (m.nonce + 1n).toString(), ...summary, ...faucetNote };
}

/** T1 propose step 1: deploy the template instance for a member and return the message to sign. */
async function prepare(q: URLSearchParams, memberOverride?: PrivateKeyAccount): Promise<Record<string, unknown>> {
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
  const id = await identity(env, getAddress(member));
  if (memberOverride === undefined) {
    const sig = q.get("sig");
    if (sig === null || !/^0x[0-9a-fA-F]{130}$/u.test(sig)) fail(400, "sig (EIP-191 signature of the prepare message) is required");
    const message = prepareMessage(getAddress(member), template, params, id.nonce);
    const valid = await recovering("prepare signature", () => verifyMessage({ address: getAddress(member), message, signature: sig as Hex }));
    if (!valid) fail(401, `prepare signature mismatch; sign exactly: ${JSON.stringify(message)}`);
  }
  const shares = (await client.readContract({ address: D.shares, abi: env.abi.shares, functionName: "balanceOf", args: [getAddress(member)] })) as bigint;
  const threshold = (await client.readContract({ address: D.baal, abi: env.abi.baal, functionName: "sponsorThreshold" })) as bigint;
  if (shares < threshold) fail(409, `sponsored deployments need at least ${fmtShares(threshold)} shares (you hold ${fmtShares(shares)}); deposit first`);
  rate(`address:${member.toLowerCase()}`, RATE_ADDRESS);
  persist();
  const { budget } = budgetRow();
  const reserve = 3_000_000n * policy.maxFeePerGas;
  if (BigInt(budget.wei) + reserve > policy.dailyWei) fail(503, "daily gas sponsorship budget reached");
  budget.wei = (BigInt(budget.wei) + reserve).toString();
  persist();
  let prepared: Awaited<ReturnType<typeof prepareProposal>> | undefined;
  try {
    prepared = await prepareProposal(env, sponsorCtx, getAddress(member), spec, summary);
  } finally {
    const spent = prepared ? (await client.getTransactionReceipt({ hash: prepared.instance.deployHash })).gasUsed * policy.maxFeePerGas : 0n;
    budget.wei = (BigInt(budget.wei) - reserve + spent).toString();
    persist();
  }
  invalidateState();
  if (prepared === undefined) fail(503, "template deployment failed");
  const intent = buildIntent("propose", new URLSearchParams({ data: prepared.proposalData, details: prepared.details }), { member: getAddress(member), nonce: BigInt(id.nonce), chainTime: id.chainTime, settlement: D.settlement });
  return {
    ok: true,
    verb: "prepare",
    instance: prepared.instance.address,
    template: prepared.instance.template,
    contract: prepared.instance.contractName,
    codeHash: prepared.instance.codeHash,
    paramsHash: prepared.instance.paramsHash,
    operator: prepared.instance.description.operator,
    budget: prepared.instance.description.budget.toString(),
    budgetUsdc: fmtUsdc(prepared.instance.description.budget),
    deployHash: prepared.instance.deployHash,
    calls: prepared.calls,
    proposalData: prepared.proposalData,
    details: prepared.details,
    message: toWire(intent),
    domain: id.domain,
    next: "sign `message` (EIP-712 Intent, op 0) with your key and GET /relay?intent=<base64url {message, signature}>",
  };
}

/** T0 request: derive the key from the pass, build and sign the intent, submit. */
async function custodial(q: URLSearchParams): Promise<Record<string, unknown>> {
  const pass = q.get("pass");
  const key = passAccount(pass);
  const ph = hashPass(pass as string);
  const op = q.get("op") ?? "";
  const id = await identity(env, key.address);
  if (op === "identity") return { ok: true, ...id, custody: "custodial-lite", me: `/me/pass/${ph}.json` };
  const authorization = id.delegated ? undefined : await key.signAuthorization({ contractAddress: adapter, chainId: D.chainId, nonce: id.authorizationNonce });
  const auth = authorization ? { chainId: D.chainId, address: adapter, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity as 0 | 1 } : undefined;
  if (op === "join") return join(key.address, auth, true, ph);
  if (!(VERBS as string[]).includes(op)) fail(400, `unknown op ${op}; T0 verbs: join, deposit, task, deliver, propose, vote, execute, ragequit, work, confirm, sponsor`);
  const state = await readDaoState(env);
  let query = q;
  let extra: Record<string, unknown> = {};
  if (op === "propose") {
    if (!id.delegated) fail(409, "join first (op=join) so the proposal is submitted from your delegated account");
    const prepared = await prepare(q, key);
    query = new URLSearchParams({ data: prepared.proposalData as string, details: prepared.details as string });
    extra = { instance: prepared.instance, codeHash: prepared.codeHash, paramsHash: prepared.paramsHash, operator: prepared.operator, budgetUsdc: prepared.budgetUsdc, deployHash: prepared.deployHash };
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
      return send(200, json({ service: "zero-one-relay", dao: "Zero One", chainId: D.chainId, chain: policy.name, adapter, baal: D.baal, safe: D.safe, settlement: D.settlement, constitution: D.constitution, sponsor: sponsor.address, sponsorBalanceWei: balance.toString(), blockNumber: block.toString(), policy: { dailyWei: policy.dailyWei.toString(), faucet: policy.faucet, faucetDailyUnits: policy.faucetDailyUnits.toString(), maxFeePerGas: policy.maxFeePerGas.toString(), ratePerAddressPerMinute: RATE_ADDRESS, ratePerIpPerMinute: RATE_IP, queue: 8 }, verbs: ["join", "deposit", "task", "deliver", "propose", "vote", "execute", "ragequit", "work", "confirm", "sponsor"], startedAt, queued, alive: true }));
    }
    if (u.pathname === "/proposals.json") {
      const state = await readDaoState(env);
      return send(200, json({ chain: state.chain, governance: state.governance, openProposals: state.openProposals, proposals: state.proposals, generatedAt: state.generatedAt }));
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
      return send(200, json(await me(env, getAddress(address), custody)));
    }
    if (u.pathname !== "/relay") fail(404, "not found; see /health.json, /me/<address>.json, /proposals.json, /state.json, /relay");
    rate(`ip:${String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress)}`, RATE_IP);
    if (queued >= 8) fail(503, "relay queue full; retry in a few seconds");
    queued += 1;
    const task = queue.then(async () => {
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
      if (op === "prepare") return prepare(q);
      return fail(400, "expected intent=<base64url envelope>, op=join&authorization=<base64url>, op=prepare&member=..&template=..&params=..&sig=.., or op=<verb>&pass=<secret>");
    });
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
