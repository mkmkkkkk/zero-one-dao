/**
 * Bridge free test ETH from Ethereum Sepolia (L1) to Base Sepolia (L2) through the Base Sepolia
 * OptimismPortal at 0x49f53e41452C74589E85cA1677426Ba426459e85.
 *
 * The portal's `receive()` forwards a plain ETH transfer to `depositTransaction(msg.sender, msg.value,
 * RECEIVE_DEFAULT_GAS_LIMIT, false, "")`, so the same amount is minted to the *same address* on Base
 * Sepolia a minute or two later. Nothing is deployed and no allowance is needed; this is the free
 * top-up path for the deployer when every Base Sepolia faucet is captcha- or account-gated.
 *
 * Test chains only: the script refuses any L1 chain id other than 11155111 (Ethereum Sepolia) and any
 * portal whose `l2Sender()` is not the unset sentinel, so it can never be pointed at a mainnet bridge.
 * Keys are read from a 0600 env file and never printed.
 *
 * Usage: tsx scripts/bridge-sepolia-to-base.ts [--key-file <env file>] [--key-var ANCHOR_PRIVATE_KEY]
 *                                              [--amount <decimal ETH> | --all true] [--l1-rpc <url>]
 *                                              [--l2-rpc <url>] [--portal <address>] [--wait-seconds 600]
 */
import path from "node:path";

import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { parseArgs } from "../beacon/scripts/build.js";
import { fmtEth, keyFromEnvFile, liveChain, liveContexts } from "../src/live.js";

/** Base Sepolia's OptimismPortal proxy on Ethereum Sepolia (docs.base.org contract addresses). */
const BASE_SEPOLIA_PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85";
/** `l2Sender()` while no deposit is being relayed; a live mainnet portal reads the same, a wrong address does not. */
const UNSET_L2_SENDER = "0x000000000000000000000000000000000000dEaD";
/** Portal ABI subset: the two views the safety check reads. */
const PORTAL_ABI = [
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "l2Sender", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Wei per gas as a decimal gwei string.
 *
 * A fee is quoted in gwei, so the receipt prints the cap in the unit an operator compares against the
 * live base fee. Local to this script because the mini's runtime checkout of src/live.ts predates the
 * shared fmtGwei helper.
 *
 * @param wei Wei per gas.
 * @returns The same quantity in gwei with trailing zeros trimmed.
 */
function gwei(wei: bigint): string {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Sleep.
 *
 * @param ms Milliseconds.
 * @returns A promise resolved after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send the deposit and wait for the minted balance on Base Sepolia.
 *
 * @returns Nothing; prints one JSON receipt object.
 * @throws Error if the chain, the portal, the amount or the L1 receipt is not what the script requires.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const portal = getAddress(args.portal ?? BASE_SEPOLIA_PORTAL);
  const keyFile = args["key-file"] ?? process.env.ZERO_ONE_DEPLOYER_KEY_FILE ?? path.join(process.env.HOME ?? "", "srv", "aow-exit", ".env.sepolia");
  const key = keyFromEnvFile(keyFile, args["key-var"] ?? "ANCHOR_PRIVATE_KEY");
  const account = privateKeyToAccount(key);

  const l1Rpc = args["l1-rpc"] ?? process.env.ZERO_ONE_L1_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const l1Chain = { ...sepolia, rpcUrls: { default: { http: [l1Rpc] } } };
  const l1 = createPublicClient({ chain: l1Chain, transport: http(l1Rpc, { retryCount: 4, retryDelay: 1_500, timeout: 60_000 }), cacheTime: 0 });
  const wallet = createWalletClient({ account, chain: l1Chain, transport: http(l1Rpc, { retryCount: 4, retryDelay: 1_500, timeout: 60_000 }) });
  if (await l1.getChainId() !== 11155111) throw new Error("L1 RPC is not Ethereum Sepolia (11155111); this script bridges test ETH only");

  const l2Chain = liveChain(84532, args["l2-rpc"]);
  const { publicClient: l2 } = liveContexts(l2Chain, []);
  if (await l2.getChainId() !== 84532) throw new Error("L2 RPC is not Base Sepolia (84532)");

  const version = await l1.readContract({ address: portal, abi: PORTAL_ABI, functionName: "version" });
  const l2Sender = await l1.readContract({ address: portal, abi: PORTAL_ABI, functionName: "l2Sender" });
  if (getAddress(l2Sender) !== getAddress(UNSET_L2_SENDER)) throw new Error(`${portal} does not read as an idle OptimismPortal (l2Sender ${l2Sender})`);

  const balanceBeforeL1 = await l1.getBalance({ address: account.address });
  const balanceBeforeL2 = await l2.getBalance({ address: account.address });

  const fees = await l1.estimateFeesPerGas();
  const maxFeePerGas = (fees.maxFeePerGas ?? 0n) * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  if (maxFeePerGas === 0n) throw new Error("L1 fee estimation returned zero");
  const gas = (await l1.estimateGas({ account, to: portal, value: 1n })) * 12n / 10n;
  const reserve = gas * maxFeePerGas;

  const value = args.all !== undefined || args.amount === undefined ? balanceBeforeL1 - reserve : parseEther(args.amount);
  if (value <= 0n) throw new Error(`nothing to bridge: L1 balance ${fmtEth(balanceBeforeL1)} ETH does not cover the ${fmtEth(reserve)} ETH gas reserve`);
  if (value + reserve > balanceBeforeL1) throw new Error(`L1 balance ${fmtEth(balanceBeforeL1)} ETH cannot cover ${fmtEth(value)} ETH plus a ${fmtEth(reserve)} ETH gas reserve`);

  const hash = await wallet.sendTransaction({ account, chain: l1Chain, to: portal, value, gas, maxFeePerGas, maxPriorityFeePerGas });
  const receipt = await l1.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`deposit reverted on L1: ${hash}`);

  const deadline = Date.now() + Number(args["wait-seconds"] ?? "600") * 1000;
  let balanceAfterL2 = balanceBeforeL2;
  while (balanceAfterL2 <= balanceBeforeL2 && Date.now() < deadline) {
    await sleep(10_000);
    balanceAfterL2 = await l2.getBalance({ address: account.address });
  }

  console.log(JSON.stringify({
    portal,
    portalVersion: version,
    address: account.address,
    l1: {
      chainId: 11155111,
      hash,
      blockNumber: String(receipt.blockNumber),
      gasUsed: String(receipt.gasUsed),
      maxFeePerGasGwei: gwei(maxFeePerGas),
      bridgedEth: fmtEth(value),
      balanceBeforeEth: fmtEth(balanceBeforeL1),
      balanceAfterEth: fmtEth(await l1.getBalance({ address: account.address })),
    },
    l2: {
      chainId: 84532,
      balanceBeforeEth: fmtEth(balanceBeforeL2),
      balanceAfterEth: fmtEth(balanceAfterL2),
      credited: balanceAfterL2 > balanceBeforeL2,
    },
  }, null, 2));
  if (balanceAfterL2 <= balanceBeforeL2) throw new Error("L1 deposit mined but Base Sepolia has not credited it yet; re-read the balance in a few minutes");
}

main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  console.error(error instanceof Error ? `${error.message}${cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : ""}` : error);
  process.exitCode = 1;
});
