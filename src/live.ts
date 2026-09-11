/**
 * Connect to a public chain (Base Sepolia / Base) with private keys read from 0600 files or env
 * lines; the same WriteContext shape the mirror uses, so deploy scripts and live scenarios share
 * every helper in src/. Keys are never printed.
 */
import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, fallback, http, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nonceManager } from "viem/nonce";
import { base, baseSepolia } from "viem/chains";

import type { WriteContext } from "./baal.js";

/** Public RPC per supported chain id (override with ZERO_ONE_RPC_URL). */
export const PUBLIC_RPC: Record<number, string> = { 84532: "https://sepolia.base.org", 8453: "https://mainnet.base.org" };
/** Alternates the transport falls back to when the primary rate-limits ("over rate limit") or fails. */
export const RPC_ALTERNATES: Record<number, string[]> = {
  84532: ["https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org", "https://base-sepolia.gateway.tenderly.co"],
  8453: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
};

/**
 * viem chain for a chain id with the RPC bound.
 *
 * @param chainId 84532 (Base Sepolia) or 8453 (Base).
 * @param rpcUrl RPC URL (default env ZERO_ONE_RPC_URL, else the public RPC).
 * @returns The chain definition with `rpcUrls.default` set to `rpcUrl`.
 * @throws Error if the chain id is not supported.
 */
export function liveChain(chainId: number, rpcUrl: string = process.env.ZERO_ONE_RPC_URL ?? PUBLIC_RPC[chainId] ?? ""): Chain {
  const known = chainId === 84532 ? baseSepolia : chainId === 8453 ? base : undefined;
  if (known === undefined) throw new Error(`unsupported live chain id ${chainId}`);
  if (rpcUrl === "") throw new Error(`no RPC for chain ${chainId}`);
  return { ...known, rpcUrls: { default: { http: [rpcUrl] } } };
}

/**
 * Read one `NAME=0x...` line from an env-style file (mode 0600 expected) and return the key.
 *
 * @param file Path of the env file.
 * @param name Variable name (default ANCHOR_PRIVATE_KEY).
 * @returns The 32-byte hex key.
 * @throws Error if the line is missing or malformed.
 */
export function keyFromEnvFile(file: string, name = "ANCHOR_PRIVATE_KEY"): Hex {
  const line = readFileSync(file, "utf8").split(/\r?\n/u).find((candidate) => new RegExp(`^${name}\\s*=`, "u").test(candidate));
  if (line === undefined) throw new Error(`${name} not found in ${file}`);
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/gu, "");
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error(`${name} in ${file} is not a 32-byte hex key`);
  return key as Hex;
}

/**
 * Build write contexts for `keys` on `chain`.
 *
 * @param chain A chain from liveChain().
 * @param keys Private keys.
 * @returns One WriteContext per key (shared public client, retrying transport).
 */
export function liveContexts(chain: Chain, keys: readonly Hex[]): { publicClient: PublicClient; contexts: WriteContext[] } {
  const url = chain.rpcUrls.default.http[0]!;
  const options = { retryCount: 4, retryDelay: 1_500, timeout: 60_000 };
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  const alternates = (loopback ? [] : RPC_ALTERNATES[chain.id] ?? []).filter((candidate) => candidate !== url);
  const transport = alternates.length === 0 ? http(url, options) : fallback([http(url, options), ...alternates.map((candidate) => http(candidate, options))], { rank: false, retryCount: 1 });
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0 });
  const contexts = keys.map((key) => {
    // Local nonce tracking: a load-balanced public RPC can report a stale pending count between two writes.
    const account = privateKeyToAccount(key, { nonceManager });
    return { chain, publicClient, account, walletClient: createWalletClient({ account, chain, transport }) } as WriteContext;
  });
  return { publicClient, contexts };
}

/** Wei as a decimal ETH string (18 decimals, trailing zeros trimmed). */
export function fmtEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/u, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Wei as a decimal gwei string (9 decimals, trailing zeros trimmed).
 *
 * Used for the live base fee the deployer funding gate names in its refusal: gwei is the unit a fee
 * is quoted in, and printing it as ETH would hide the number an operator has to compare.
 *
 * @param wei Wei per gas.
 * @returns The same quantity in gwei, e.g. `500000000n` -> `"0.5"`.
 */
export function fmtGwei(wei: bigint): string {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}
