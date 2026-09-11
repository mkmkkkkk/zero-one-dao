/**
 * Sweep Base Sepolia test ETH out of finished scenario actors, founders and disposable relay sponsors
 * into one address (normally the deployer), so a redeploy can clear the funding gate without waiting
 * on a faucet. Every source has to be a key this repo already owns; the live relay sponsor is never a
 * source unless it is named explicitly, because draining it stops the sponsored relay.
 *
 * Base Sepolia only: the script refuses any chain id other than 84532, so it can never move real ETH.
 * Each account keeps a reserve of three times the estimated total fee (L2 execution + the OP-stack L1
 * data fee) and sends the rest. Keys are read from 0600 files and never printed.
 *
 * Usage: tsx scripts/sweep-testnet-eth.ts --to <address> --sources <path[,path...]>
 *                                         [--min 0.00002] [--rpc <url>] [--dry-run true]
 *   A source path is either a JSON object of role -> private key (state/.../actors.json) or an
 *   env-style file whose lines are NAME=0x<64 hex> (state/.../founder.env).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicActionsL2 } from "viem/op-stack";

import { parseArgs } from "../beacon/scripts/build.js";
import { fmtEth, liveChain } from "../src/live.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = /^0x[0-9a-fA-F]{64}$/u;

/**
 * Read every private key out of one source file.
 *
 * @param file Absolute path of a role -> key JSON object or an env-style file.
 * @returns The keys found, in file order; an empty array is a caller error, not a silent skip.
 * @throws Error if the file holds no key at all (a typo in --sources must not pass as "nothing to do").
 */
function keysFrom(file: string): Hex[] {
  const text = readFileSync(file, "utf8");
  const found: Hex[] = [];
  if (text.trimStart().startsWith("{")) {
    for (const value of Object.values(JSON.parse(text) as Record<string, unknown>)) {
      if (typeof value === "string" && KEY.test(value.trim())) found.push(value.trim() as Hex);
    }
  } else {
    for (const line of text.split(/\r?\n/u)) {
      const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/gu, "");
      const key = value.startsWith("0x") ? value : `0x${value}`;
      if (line.includes("=") && KEY.test(key)) found.push(key as Hex);
    }
  }
  if (found.length === 0) throw new Error(`${file} holds no private key`);
  return found;
}

/**
 * Move every sweepable balance to the destination and print one JSON report.
 *
 * @returns Nothing; prints the destination's before/after balance and one row per source account.
 * @throws Error if the RPC is not Base Sepolia or a transfer reverts.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const to = getAddress(args.to ?? "");
  const sources = (args.sources ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (sources.length === 0) throw new Error("--sources <path[,path...]> is required");
  const min = parseEther(args.min ?? "0.00002");
  const dryRun = args["dry-run"] !== undefined;

  const chain = liveChain(84532, args.rpc);
  const transport = http(chain.rpcUrls.default.http[0]!, { retryCount: 4, retryDelay: 1_500, timeout: 60_000 });
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0 }).extend(publicActionsL2());
  if (await publicClient.getChainId() !== 84532) throw new Error("sweep RPC is not Base Sepolia (84532)");

  const accounts = new Map<string, { key: Hex; source: string }>();
  for (const source of sources) {
    const file = path.isAbsolute(source) ? source : path.resolve(ROOT, source);
    for (const key of keysFrom(file)) {
      const address = privateKeyToAccount(key).address;
      if (address === to) continue;
      if (!accounts.has(address)) accounts.set(address, { key, source });
    }
  }

  const before = await publicClient.getBalance({ address: to });
  const rows: Record<string, unknown>[] = [];
  let swept = 0n;
  for (const [address, { key, source }] of accounts) {
    const balance = await publicClient.getBalance({ address: address as `0x${string}` });
    if (balance === 0n) continue;
    const account = privateKeyToAccount(key);
    const fee = await publicClient.estimateTotalFee({ account, to, value: 1n });
    const value = balance - fee * 3n;
    if (value < min) {
      rows.push({ address, source, balanceEth: fmtEth(balance), skipped: `below --min ${formatEther(min)} after a ${fmtEth(fee * 3n)} ETH fee reserve` });
      continue;
    }
    if (dryRun) {
      rows.push({ address, source, balanceEth: fmtEth(balance), wouldSendEth: fmtEth(value) });
      swept += value;
      continue;
    }
    const wallet = createWalletClient({ account, chain, transport });
    const hash = await wallet.sendTransaction({ account, chain, to, value });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`sweep from ${address} reverted: ${hash}`);
    swept += value;
    rows.push({ address, source, balanceEth: fmtEth(balance), sentEth: fmtEth(value), hash, blockNumber: String(receipt.blockNumber) });
  }

  console.log(JSON.stringify({
    chainId: 84532,
    to,
    dryRun,
    accounts: accounts.size,
    sweptEth: fmtEth(swept),
    destinationBeforeEth: fmtEth(before),
    destinationAfterEth: fmtEth(dryRun ? before + swept : await publicClient.getBalance({ address: to })),
    rows,
  }, null, 2));
}

main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  console.error(error instanceof Error ? `${error.message}${cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : ""}` : error);
  process.exitCode = 1;
});
