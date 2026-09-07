/**
 * Zero One intents: the EIP-712 struct the ZeroOneIntentAccount verifies, the verb -> op mapping,
 * validation of untrusted envelopes, and the per-verb message builders shared by the T0 (passphrase)
 * path and the T1 helper snippets. Exact formats are documented in docs/RELAY.md and README.txt.
 */
import { encodeAbiParameters, getAddress, isAddress, isHex, keccak256, stringToHex, type Address, type Hex } from "viem";

import { ZERO_HASH } from "./common.js";
import { fail } from "./errors.js";

/** Contract ops of ZeroOneIntentAccount.executeIntent. */
export const OPS = { propose: 0, sponsor: 1, vote: 2, execute: 3, ragequit: 4, deposit: 5, work: 6, task: 7, deliver: 8, confirm: 9 } as const;
export type Verb = keyof typeof OPS;
export const VERBS = Object.keys(OPS) as Verb[];
export const OP_NAMES: Record<number, Verb> = Object.fromEntries(Object.entries(OPS).map(([verb, op]) => [op, verb])) as Record<number, Verb>;

/** EIP-712 types of the intent (must match ZeroOneIntentAccount.TYPEHASH). */
export const INTENT_TYPES = {
  Intent: [
    { name: "member", type: "address" },
    { name: "op", type: "uint8" },
    { name: "proposalId", type: "uint32" },
    { name: "amount", type: "uint256" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "details", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 domain: name ZeroOneIntent, version 1, chain-bound, verifyingContract = the adapter. */
export function intentDomain(adapter: Address, chainId: number) {
  return { name: "ZeroOneIntent", version: "1", chainId, verifyingContract: adapter } as const;
}

/** A normalized intent message (bigints for the uint256 fields). */
export interface Intent {
  member: Address;
  op: number;
  proposalId: number;
  amount: bigint;
  evidenceHash: Hex;
  data: Hex;
  details: string;
  nonce: bigint;
  deadline: bigint;
}

/** The wire form of an intent message (decimal strings for the uint256 fields). */
export interface WireIntent {
  member: string;
  op: number;
  proposalId: number;
  amount: string;
  evidenceHash: string;
  data: string;
  details: string;
  nonce: string;
  deadline: string;
}

/** A signed EIP-7702 authorization as the snippets produce it. */
export interface WireAuthorization {
  chainId: number;
  address: string;
  nonce: number;
  r: string;
  s: string;
  yParity: number;
}

/** The base64url envelope: `{message, signature, authorization?}`. */
export interface Envelope {
  message: WireIntent;
  signature: Hex;
  authorization?: WireAuthorization;
}

const UINT256 = /^(0|[1-9][0-9]{0,77})$/u;

/**
 * Validate an untrusted wire intent and convert it to bigints.
 *
 * @param raw The parsed JSON message.
 * @returns The normalized intent.
 * @throws RelayError 400 on any malformed field.
 */
export function normalize(raw: unknown): Intent {
  const m = raw as Partial<WireIntent> | null;
  if (m === null || typeof m !== "object") fail(400, "intent message missing");
  if (typeof m.member !== "string" || !isAddress(m.member)) fail(400, "intent.member is not an address");
  if (!Number.isInteger(m.op) || (m.op as number) < 0 || (m.op as number) > 9) fail(400, "intent.op must be an integer 0..9");
  if (!Number.isInteger(m.proposalId) || (m.proposalId as number) < 0 || (m.proposalId as number) > 4294967295) fail(400, "intent.proposalId must be a uint32");
  for (const key of ["amount", "nonce", "deadline"] as const) {
    if (typeof m[key] !== "string" || !UINT256.test(m[key] as string) || BigInt(m[key] as string) >= 2n ** 256n) fail(400, `intent.${key} must be a decimal uint256 string`);
  }
  if (typeof m.evidenceHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(m.evidenceHash)) fail(400, "intent.evidenceHash must be bytes32 hex");
  if (typeof m.data !== "string" || !isHex(m.data) || m.data.length % 2 !== 0) fail(400, "intent.data must be 0x-prefixed hex");
  if (typeof m.details !== "string" || m.details.length > 8192) fail(400, "intent.details must be a string (max 8192 chars)");
  return {
    member: getAddress(m.member),
    op: m.op as number,
    proposalId: m.proposalId as number,
    amount: BigInt(m.amount as string),
    evidenceHash: m.evidenceHash.toLowerCase() as Hex,
    data: m.data.toLowerCase() as Hex,
    details: m.details,
    nonce: BigInt(m.nonce as string),
    deadline: BigInt(m.deadline as string),
  };
}

/** Wire form of a normalized intent (what the T0 path signs and what /prepare returns). */
export function toWire(intent: Intent): WireIntent {
  return { ...intent, amount: intent.amount.toString(), nonce: intent.nonce.toString(), deadline: intent.deadline.toString() };
}

/**
 * Validate an untrusted authorization object.
 *
 * @param raw Parsed JSON.
 * @param chainId Expected chain id.
 * @param adapter Expected delegate.
 * @returns The authorization in viem's shape.
 * @throws RelayError 400 if malformed or for another chain / adapter.
 */
export function normalizeAuthorization(raw: unknown, chainId: number, adapter: Address): { chainId: number; address: Address; nonce: number; r: Hex; s: Hex; yParity: 0 | 1 } {
  const a = raw as Partial<WireAuthorization> | null;
  if (a === null || typeof a !== "object") fail(400, "authorization missing");
  if (Number(a.chainId) !== chainId) fail(400, `authorization.chainId must be ${chainId}`);
  if (typeof a.address !== "string" || !isAddress(a.address) || getAddress(a.address) !== adapter) fail(400, `authorization.address must be the adapter ${adapter}`);
  if (!Number.isInteger(a.nonce) || (a.nonce as number) < 0) fail(400, "authorization.nonce must be a non-negative integer");
  if (typeof a.r !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(a.r) || typeof a.s !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(a.s)) fail(400, "authorization.r/s must be bytes32 hex");
  if (a.yParity !== 0 && a.yParity !== 1) fail(400, "authorization.yParity must be 0 or 1");
  return { chainId, address: adapter, nonce: a.nonce as number, r: a.r as Hex, s: a.s as Hex, yParity: a.yParity };
}

/** Deadline for a relay-built intent: chain time + 15 minutes (chain time, never the wall clock). */
export function defaultDeadline(chainTime: number): bigint {
  return BigInt(chainTime + 900);
}

/** abi.encode(address[]) of the tokens ragequit pays out (ascending, as Baal requires). */
export function ragequitData(tokens: Address[]): Hex {
  const sorted = [...tokens].map((token) => getAddress(token)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return encodeAbiParameters([{ type: "address[]" }], [sorted]);
}

/** abi.encode(address[] verifiers, uint16 threshold, uint256 rewardShares, uint32 expiration) for op 6 (submitTask). */
export function workData(verifiers: Address[], threshold: number, rewardShares: bigint, expiration: number): Hex {
  return encodeAbiParameters([{ type: "address[]" }, { type: "uint16" }, { type: "uint256" }, { type: "uint32" }], [verifiers.map((v) => getAddress(v)), threshold, rewardShares, expiration]);
}

/** keccak256 of UTF-8 evidence text (what `deliver` commits and `confirm` reveals). */
export function evidenceHashOf(text: string): Hex {
  return keccak256(stringToHex(text));
}

/** Query parameters a verb accepts (T0 path and the prepare helper). */
export interface VerbQuery {
  get(name: string): string | null;
}

/** Parse a decimal integer query parameter. */
function integerParam(q: VerbQuery, name: string, fallback?: string): bigint {
  const value = q.get(name) ?? fallback;
  if (value === undefined || value === null) fail(400, `${name} is required`);
  if (!UINT256.test(value)) fail(400, `${name} must be a decimal integer`);
  return BigInt(value);
}

/** Parse a uint32 query parameter. */
function uint32Param(q: VerbQuery, name: string): number {
  const value = integerParam(q, name);
  if (value > 4294967295n) fail(400, `${name} must fit uint32`);
  return Number(value);
}

/** Parse a comma-separated address list. */
function addressList(q: VerbQuery, name: string): Address[] {
  const raw = q.get(name);
  if (raw === null || raw === "") fail(400, `${name} is required (comma-separated addresses)`);
  return raw.split(",").map((item) => {
    if (!isAddress(item.trim())) fail(400, `${name}: ${item} is not an address`);
    return getAddress(item.trim());
  });
}

/** Context a builder needs beyond the query. */
export interface BuildContext {
  member: Address;
  nonce: bigint;
  /** Latest block timestamp (deadline base). */
  chainTime: number;
  settlement: Address;
  /** proposalData for an execute intent (from the relay's index) when the query does not carry it. */
  proposalData?: (id: number) => Hex | undefined;
  /** Shares held (for `amount=all` ragequits). */
  shares?: bigint;
}

/**
 * Build the intent message for a verb from query parameters (used by the T0 path and by the
 * `prepare` helper that hands T1 agents the exact message to sign).
 *
 * @param verb The verb.
 * @param q Query parameters.
 * @param ctx Member, nonce and chain facts.
 * @returns The normalized intent (deadline 15 min unless `deadline` given).
 * @throws RelayError 400 for a missing or malformed parameter.
 */
export function buildIntent(verb: Verb, q: VerbQuery, ctx: BuildContext): Intent {
  const base: Intent = { member: ctx.member, op: OPS[verb], proposalId: 0, amount: 0n, evidenceHash: ZERO_HASH, data: "0x", details: "", nonce: ctx.nonce, deadline: q.get("deadline") ? integerParam(q, "deadline") : defaultDeadline(ctx.chainTime) };
  switch (verb) {
    case "deposit":
      return { ...base, amount: integerParam(q, "amount") };
    case "vote": {
      const approve = (q.get("approve") ?? q.get("vote") ?? "").toLowerCase();
      if (!["yes", "no", "true", "false", "1", "0"].includes(approve)) fail(400, "approve must be yes or no");
      return { ...base, proposalId: uint32Param(q, "proposalId"), amount: ["yes", "true", "1"].includes(approve) ? 1n : 0n };
    }
    case "sponsor":
      return { ...base, proposalId: uint32Param(q, "proposalId") };
    case "execute": {
      const id = uint32Param(q, "proposalId");
      const data = (q.get("data") as Hex | null) ?? ctx.proposalData?.(id);
      if (data === undefined || data === null || !isHex(data)) fail(404, `proposalData for proposal ${id} is unknown; pass data=<proposalData> from /proposals.json`);
      return { ...base, proposalId: id, data: data.toLowerCase() as Hex };
    }
    case "ragequit": {
      const raw = q.get("amount") ?? "all";
      const amount = raw === "all" ? ctx.shares : integerParam(q, "amount");
      if (amount === undefined) fail(400, "amount (shares, raw 18-dec) is required");
      const tokens = q.get("tokens") ? addressList(q, "tokens") : [ctx.settlement];
      return { ...base, amount, data: ragequitData(tokens) };
    }
    case "task":
      return { ...base, amount: integerParam(q, "taskId") };
    case "deliver": {
      const hash = q.get("evidenceHash") ?? (q.get("evidence") !== null ? evidenceHashOf(q.get("evidence") as string) : null);
      if (hash === null || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) fail(400, "evidenceHash (bytes32) or evidence (text) is required");
      return { ...base, amount: integerParam(q, "taskId"), evidenceHash: hash.toLowerCase() as Hex };
    }
    case "confirm": {
      const evidence = q.get("evidence");
      if (evidence === null) fail(400, "evidence (the delivered text) is required");
      return { ...base, amount: integerParam(q, "taskId"), data: stringToHex(evidence) };
    }
    case "work": {
      const verifiers = addressList(q, "verifiers");
      const threshold = Number(integerParam(q, "threshold", String(verifiers.length)));
      const reward = integerParam(q, "rewardShares");
      const expiration = q.get("expiration") ? uint32Param(q, "expiration") : 0;
      const details = q.get("details") ?? "";
      return { ...base, data: workData(verifiers, threshold, reward, expiration), details };
    }
    case "propose": {
      const data = q.get("data");
      if (data === null || !isHex(data)) fail(400, "propose needs data=<proposalData> and details from /relay?op=prepare");
      return { ...base, data: data.toLowerCase() as Hex, details: q.get("details") ?? "", amount: q.get("expiration") ? integerParam(q, "expiration") : 0n };
    }
  }
}
