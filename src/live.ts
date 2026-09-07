/**
 * Connect to a public chain (Base Sepolia / Base) with private keys read from 0600 files or env
 * lines; the same WriteContext shape the mirror uses, so deploy scripts and live scenarios share
 * every helper in src/. Keys are never printed.
 */
import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import type { WriteContext } from "./baal.js";

/** Public RPC per supported chain id (override with ZERO_ONE_RPC_URL). */
export const PUBLIC_RPC: Record<number, string> = { 84532: "https://sepolia.base.org", 8453: "https://mainnet.base.org" };

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
  const transport = http(url, { retryCount: 6, retryDelay: 1_500, timeout: 60_000 });
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0 });
  const contexts = keys.map((key) => {
    const account = privateKeyToAccount(key);
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
