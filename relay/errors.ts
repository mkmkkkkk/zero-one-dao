/**
 * Turn any failure (viem revert, custom error, string revert, RPC error, relay policy) into one
 * JSON-able reason. The relay never answers with a bare revert: every custom error of every Zero One
 * contract (and Baal's string reverts) is decoded by selector into `Name(arg=value, ...)`.
 */
import { BaseError, decodeErrorResult, type Abi, type Hex } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;

import type { Env } from "./common.js";

/** A relay failure with an HTTP status. */
export class RelayError extends Error {
  status: number;
  reason: string;
  details?: unknown;

  /**
   * @param status HTTP status (400 malformed, 401 signature, 404 unknown, 409 stale state, 422 reverted, 429 rate, 503 capacity).
   * @param reason Human-readable reason string.
   * @param details Optional structured detail (decoded error, tx hash).
   */
  constructor(status: number, reason: string, details?: unknown) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

/** Throw a RelayError. */
export function fail(status: number, reason: string, details?: unknown): never {
  throw new RelayError(status, reason, details);
}

/** Baal's string reverts, translated to sentences agents can act on. */
const BAAL_REASONS: Record<string, string> = {
  "!voting": "the proposal is not in its voting period",
  "!member": "no shares at the proposal's voting start: deposit or earn shares before the proposal is submitted",
  voted: "this address already voted on the proposal",
  "!ready": "the proposal is not ready to execute: wait for grace to end, or it was defeated / cancelled / already processed",
  "!sponsor": "sponsoring needs at least sponsorThreshold shares",
  "!exist": "no proposal with that id",
  "prev!processed": "an earlier sponsored proposal must be processed first",
  "!baal & !manager": "only Baal or a manager shaman may mint",
  "!order": "ragequit token list must be ascending",
  "!balance": "not enough shares (or loot) to ragequit that amount",
  "Baal requires an offering": "proposalOffering must be paid",
  "!votingEnded": "voting has not ended",
  "!grace": "grace has not ended",
};

/** Combined error ABI of every Zero One contract plus Baal and the Safe, keyed by nothing (viem matches by selector). */
export function errorAbi(env: Env): Abi {
  const items: AbiError[] = [];
  for (const abi of Object.values(env.abi)) for (const item of abi) if (item.type === "error") items.push(item);
  return items;
}

/** Render a decoded error argument. */
function renderArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(renderArg).join(",")}]`;
  return String(value);
}

/**
 * Decode raw revert data with the combined error ABI.
 *
 * @param env The connected environment (for ABIs).
 * @param data Revert data (`0x` for none).
 * @returns `{name, args, text}` or undefined if the selector is unknown.
 */
export function decodeRevert(env: Env, data: Hex): { name: string; args: Record<string, string>; text: string } | undefined {
  if (data === "0x" || data.length < 10) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: errorAbi(env), data });
    const inputs = (decoded.abiItem as AbiError).inputs ?? [];
    const args: Record<string, string> = {};
    (decoded.args ?? []).forEach((value, index) => {
      args[inputs[index]?.name || `arg${index}`] = renderArg(value);
    });
    if (decoded.errorName === "Error" && typeof decoded.args?.[0] === "string") {
      const message = decoded.args[0];
      return { name: "Error", args: { message }, text: BAAL_REASONS[message] ?? message };
    }
    return { name: decoded.errorName, args, text: `${decoded.errorName}(${Object.entries(args).map(([key, value]) => `${key}=${value}`).join(", ")})` };
  } catch {
    return { name: "unknown", args: { selector: data.slice(0, 10) }, text: `revert ${data.slice(0, 10)} (unknown selector)` };
  }
}

/**
 * Explain any thrown value as `{status, reason, error?}`.
 *
 * @param env The connected environment.
 * @param error The thrown value.
 * @returns HTTP status, reason text and, for reverts, the decoded error.
 */
export function explain(env: Env, error: unknown): { status: number; reason: string; error?: { name: string; args: Record<string, string> }; hash?: Hex } {
  if (error instanceof RelayError) {
    const details = (error.details ?? {}) as { error?: { name: string; args: Record<string, string> }; hash?: Hex };
    return { status: error.status, reason: error.reason, ...(details.error ? { error: details.error } : {}), ...(details.hash ? { hash: details.hash } : {}) };
  }
  if (error instanceof BaseError) {
    const withData = error.walk((candidate) => typeof (candidate as { data?: unknown }).data === "string") as { data?: Hex } | null;
    const decoded = withData?.data !== undefined ? decodeRevert(env, withData.data) : undefined;
    if (decoded !== undefined) return { status: 422, reason: `reverted: ${decoded.text}`, error: { name: decoded.name, args: decoded.args } };
    const reasonMatch = /reason:\s*(.+?)(?:\n|$)/u.exec(error.message);
    if (reasonMatch?.[1] !== undefined) {
      const text = reasonMatch[1].trim();
      return { status: 422, reason: `reverted: ${BAAL_REASONS[text] ?? text}`, error: { name: "Error", args: { message: text } } };
    }
    if (/execution reverted/iu.test(error.shortMessage)) return { status: 422, reason: `reverted without data (${error.shortMessage})` };
    if (/fetch|ECONNREFUSED|timeout|HTTP request failed/iu.test(error.shortMessage)) return { status: 503, reason: `upstream rpc unreachable: ${error.shortMessage}` };
    return { status: 400, reason: error.shortMessage };
  }
  if (error instanceof Error) return { status: 400, reason: error.message };
  return { status: 400, reason: String(error) };
}
