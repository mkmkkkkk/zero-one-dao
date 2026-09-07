/**
 * Fund a testnet address from the deployer key: ETH (--eth <decimal>) and/or mock USDC minted by the
 * deployer (--usdc <whole units>). Prints the receipts, never a key.
 * Usage: tsx scripts/testnet-fund.ts --to <address> [--eth 0.01] [--usdc 1000000] [--key-file <env file>] [--deployment deployments/base-sepolia.json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, parseEther, type Hex } from "viem";

import { parseArgs } from "../beacon/scripts/build.js";
import { loadLocalArtifact } from "../src/baal.js";
import { fmtEth, keyFromEnvFile, liveChain, liveContexts } from "../src/live.js";
import { SETTLEMENT_UNIT } from "../src/zeroOne.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const to = getAddress(args.to ?? "");
  const deploymentFile = path.resolve(ROOT, args.deployment ?? "deployments/base-sepolia.json");
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as { chainId: number; settlement: `0x${string}` };
  const keyFile = args["key-file"] ?? process.env.ZERO_ONE_DEPLOYER_KEY_FILE ?? path.join(process.env.HOME ?? "", "srv", "aow-exit", ".env.sepolia");
  const chain = liveChain(deployment.chainId, args.rpc);
  const { publicClient, contexts } = liveContexts(chain, [keyFromEnvFile(keyFile, args["key-var"] ?? "ANCHOR_PRIVATE_KEY")]);
  const deployer = contexts[0]!;
  const out: Record<string, unknown> = { to, deployer: deployer.account.address };
  if (args.eth !== undefined) {
    const value = parseEther(args.eth);
    const hash: Hex = await deployer.walletClient.sendTransaction({ account: deployer.account, chain, to, value } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ETH transfer reverted: ${hash}`);
    out.eth = { sent: args.eth, hash, balanceAfter: fmtEth(await publicClient.getBalance({ address: to })) };
  }
  if (args.usdc !== undefined) {
    const abi = loadLocalArtifact("MockUSDC").abi;
    const units = BigInt(args.usdc) * SETTLEMENT_UNIT;
    const mint = await publicClient.simulateContract({ address: deployment.settlement, abi, functionName: "mint", args: [to, units], account: deployer.account } as never);
    const hash = await deployer.walletClient.writeContract({ ...mint.request, account: deployer.account, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`mint reverted: ${hash}`);
    out.usdc = { minted: args.usdc, hash, balanceAfter: ((await publicClient.readContract({ address: deployment.settlement, abi, functionName: "balanceOf", args: [to] })) as bigint).toString() };
  }
  out.deployerBalanceEth = fmtEth(await publicClient.getBalance({ address: deployer.account.address }));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  console.error(error instanceof Error ? `${error.message}${cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : ""}` : error);
  process.exitCode = 1;
});
