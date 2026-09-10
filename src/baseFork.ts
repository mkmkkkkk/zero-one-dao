/** Owned Base read-only upstream forks. All mutations are constrained to loopback Anvil. */
import { createWalletClient, getAddress, http, parseAbi, type Address } from "viem";
import { startDevnet, stopDevnet, type Devnet } from "./devnet.js";
import { connectDevnet } from "./onchain.js";
import { BASE_USDC } from "./zeroOne.js";

export const BASE_FORK_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];

/**
 * Base block the forks pin by default (docs/PARAMETERS.md "Phase 4 venue pricing").
 *
 * Pinning matters twice: the fork replays the same pool state on every run, and anvil only writes its
 * on-disk RPC cache (`~/.foundry/cache/rpc/8453/<block>`) for a pinned block, so the second run of a
 * tick-crossing scenario reads from disk instead of from the upstream RPC. Override with `FORK_BLOCK`
 * (a decimal block number, or `latest` to fork the chain tip and give up both properties).
 */
export const BASE_FORK_BLOCK = 51_000_000n;

/**
 * Resolve the fork block from the environment.
 *
 * Returns:
 *   The block to pin, or undefined when `FORK_BLOCK=latest` asks for the chain tip.
 */
export function forkBlockNumber(): bigint | undefined {
  const raw = process.env.FORK_BLOCK?.trim();
  if (raw === undefined || raw === "") return BASE_FORK_BLOCK;
  if (raw.toLowerCase() === "latest") return undefined;
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`FORK_BLOCK must be a decimal block number or "latest", got ${raw}`);
  return BigInt(raw);
}
export async function assertBaseFork(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("fork writes require loopback HTTP Anvil");
  const request = async (method: string) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: AbortSignal.timeout(5000) });
    const json = await response.json() as { result?: any; error?: unknown };
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };
  if (await request("eth_chainId") !== "0x2105") throw new Error("fork chain id must be 8453");
  const metadata = await request("anvil_metadata");
  if (!metadata?.forkedNetwork || Number(metadata.forkedNetwork.chainId) !== 8453) throw new Error("Anvil must report a forked Base network");
}
export async function startBaseFork(runId: string): Promise<Devnet> {
  const urls = [...new Set([process.env.FORK_RPC, ...BASE_FORK_RPCS].filter((x): x is string => Boolean(x)))];
  for (const [i, url] of urls.entries()) {
    let devnet: Devnet | undefined;
    try {
      console.log(`FORK attempt ${url}`);
      const forkBlock = forkBlockNumber();
      devnet = await startDevnet(`${runId}-${i}`, { chainId: 8453, hardfork: "prague", forkUrl: url, forkBlockNumber: forkBlock });
      await assertBaseFork(devnet.rpcUrl);
      console.log(`ASSERT fork upstream=${url} chainId=8453 block=${forkBlock ?? "latest"} loopback=${devnet.rpcUrl}`);
      return devnet;
    } catch (error) {
      if (devnet) await stopDevnet(devnet);
      console.error(`FORK ERROR ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("BLOCKED: every Base fork RPC failed; see the exact Anvil errors above");
}
/**
 * Impersonate a live USDC-rich address only inside the verified fork; never mint or set USDC storage.
 *
 * Args:
 *   devnet: The owned loopback fork.
 *   to: Recipient of the USDC.
 *   amount: USDC base units to move.
 *   holder: Optional address to impersonate; default `FORK_USDC_HOLDER` or the Base WETH/USDC 0.05% pool.
 */
export async function fundForkUsdc(devnet: Devnet, to: Address, amount: bigint, holder?: Address): Promise<void> {
  await assertBaseFork(devnet.rpcUrl);
  const local = connectDevnet(devnet);
  const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
  if (await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "decimals" }) !== 6) throw new Error("USDC proxy decimals != 6");
  holder ??= process.env.FORK_USDC_HOLDER ? getAddress(process.env.FORK_USDC_HOLDER) : await local.publicClient.readContract({ address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]), functionName: "getPool", args: [BASE_USDC, "0x4200000000000000000000000000000000000006", 500] });
  const balance = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [holder] });
  if (balance < amount) throw new Error(`USDC holder ${holder} has ${balance}, needs ${amount}`);
  const before = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [to] });
  const rpc = local.publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  await rpc({ method: "anvil_impersonateAccount", params: [holder] });
  try {
    await rpc({ method: "anvil_setBalance", params: [holder, "0xde0b6b3a7640000"] });
    const wallet = createWalletClient({ chain: local.chain, transport: http(devnet.rpcUrl), account: holder });
    const hash = await wallet.writeContract({ chain: local.chain, address: BASE_USDC, abi: tokenAbi, functionName: "transfer", args: [to, amount] });
    // This owned impersonation sends one transaction and never replaces it. Avoid the
    // replacement-lookup race when a cold upstream read delays the single automined block.
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash, checkReplacement: false });
    const after = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [to] });
    if (receipt.status !== "success" || after - before !== amount) throw new Error("fork USDC funding exact transfer failed");
    console.log(`ASSERT USDC proxy decimals=6 impersonated=${holder} funded=${amount} recipient=${to} tx=${hash}`);
  } finally { await rpc({ method: "anvil_stopImpersonatingAccount", params: [holder] }); }
}

/** Uniswap v3 pool views the tick warmer reads (`ticks` and `tickBitmap` are the slots a swap crosses). */
const poolWarmAbi = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
  "function tickBitmap(int16) view returns (uint256)",
  "function observations(uint256) view returns (uint32,int56,uint160,bool)",
]);

/**
 * Pull every pool storage slot a large swap will touch into the fork's cache, concurrently.
 *
 * A fork serves cold storage from the upstream RPC one slot at a time (~0.5 s per round trip here), and a
 * swap that walks a 25% price range crosses hundreds of initialized ticks, so the in-transaction fetches
 * alone take longer than any RPC timeout. Reading the same slots first through independent `eth_call`s lets
 * anvil fetch them in parallel; afterwards the swap runs from memory (and, on a pinned fork block, from
 * anvil's on-disk cache on the next run). Read-only: it changes no state and asserts nothing.
 *
 * Args:
 *   devnet: The owned loopback fork.
 *   pool: The Uniswap v3 pool.
 *   tickRange: Half-width in raw ticks; +25% is about 2232 ticks, -25% about 2877.
 *   concurrency: Simultaneous in-flight `eth_call`s.
 *
 * Returns:
 *   The number of slots warmed (tick entries plus bitmap words plus oracle observations).
 */
export async function warmUniswapPool(devnet: Devnet, pool: Address, tickRange = 3_000, concurrency = 24): Promise<number> {
  await assertBaseFork(devnet.rpcUrl);
  const { publicClient } = connectDevnet(devnet);
  const read = (functionName: string, args: readonly unknown[] = []): Promise<unknown> =>
    publicClient.readContract({ address: pool, abi: poolWarmAbi, functionName, args } as never);
  const [, tick, observationIndex, cardinality] = await read("slot0") as [bigint, number, number, number, number, number, boolean];
  const spacing = Number(await read("tickSpacing"));
  await read("liquidity");
  const reads: (() => Promise<unknown>)[] = [];
  const lowest = Math.ceil((tick - tickRange) / spacing) * spacing;
  for (let t = lowest; t <= tick + tickRange; t += spacing) reads.push(() => read("ticks", [t]));
  const word = (t: number) => Math.floor(Math.floor(t / spacing) / 256);
  for (let w = word(tick - tickRange); w <= word(tick + tickRange); w += 1) reads.push(() => read("tickBitmap", [w]));
  // `observe` binary-searches the ring; warm the whole live window around the current index.
  for (let i = 0; i < Math.min(cardinality, 1_024); i += 1) reads.push(() => read("observations", [BigInt((observationIndex - i + cardinality) % cardinality)]));
  const started = Date.now();
  console.log(`FORK warm start pool=${pool} tick=${tick} spacing=${spacing} reads=${reads.length}`);
  for (let i = 0; i < reads.length; i += concurrency) {
    await Promise.all(reads.slice(i, i + concurrency).map((fn) => fn()));
    if (i === 0 || (i + concurrency) % 240 === 0) console.log(`FORK warm progress=${Math.min(i + concurrency, reads.length)}/${reads.length}`);
  }
  console.log(`ASSERT warmed pool=${pool} tick=${tick} spacing=${spacing} slots=${reads.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return reads.length;
}
