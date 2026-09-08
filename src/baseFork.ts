/** Owned Base read-only upstream forks. All mutations are constrained to loopback Anvil. */
import { createWalletClient, getAddress, http, parseAbi, type Address } from "viem";
import { startDevnet, stopDevnet, type Devnet } from "./devnet.js";
import { connectDevnet } from "./onchain.js";
import { BASE_USDC } from "./zeroOne.js";

export const BASE_FORK_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];
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
      devnet = await startDevnet(`${runId}-${i}`, { chainId: 8453, hardfork: "prague", forkUrl: url });
      await assertBaseFork(devnet.rpcUrl);
      console.log(`ASSERT fork upstream=${url} chainId=8453 loopback=${devnet.rpcUrl}`);
      return devnet;
    } catch (error) {
      if (devnet) await stopDevnet(devnet);
      console.error(`FORK ERROR ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("BLOCKED: every Base fork RPC failed; see the exact Anvil errors above");
}
/** Impersonate a live USDC-rich address only inside the verified fork; never mint or set USDC storage. */
export async function fundForkUsdc(devnet: Devnet, to: Address, amount: bigint): Promise<void> {
  await assertBaseFork(devnet.rpcUrl);
  const local = connectDevnet(devnet);
  const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
  if (await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "decimals" }) !== 6) throw new Error("USDC proxy decimals != 6");
  const holder = process.env.FORK_USDC_HOLDER ? getAddress(process.env.FORK_USDC_HOLDER) : await local.publicClient.readContract({ address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]), functionName: "getPool", args: [BASE_USDC, "0x4200000000000000000000000000000000000006", 500] });
  const balance = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [holder] });
  if (balance < amount) throw new Error(`USDC holder ${holder} has ${balance}, needs ${amount}`);
  const before = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [to] });
  const rpc = local.publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  await rpc({ method: "anvil_impersonateAccount", params: [holder] });
  try {
    await rpc({ method: "anvil_setBalance", params: [holder, "0xde0b6b3a7640000"] });
    const wallet = createWalletClient({ chain: local.chain, transport: http(devnet.rpcUrl), account: holder });
    const hash = await wallet.writeContract({ chain: local.chain, address: BASE_USDC, abi: tokenAbi, functionName: "transfer", args: [to, amount] });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    const after = await local.publicClient.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "balanceOf", args: [to] });
    if (receipt.status !== "success" || after - before !== amount) throw new Error("fork USDC funding exact transfer failed");
    console.log(`ASSERT USDC proxy decimals=6 impersonated=${holder} funded=${amount} recipient=${to} tx=${hash}`);
  } finally { await rpc({ method: "anvil_stopImpersonatingAccount", params: [holder] }); }
}
