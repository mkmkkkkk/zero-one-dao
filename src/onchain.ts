import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Devnet } from "./devnet.js";
import {
  deployArtifact,
  loadLocalArtifact,
  type ContractArtifact,
  type WriteContext,
} from "./baal.js";

export interface LocalChain {
  chain: ReturnType<typeof defineChain>;
  publicClient: ReturnType<typeof createPublicClient>;
  contexts: WriteContext[];
  accounts: ReturnType<typeof privateKeyToAccount>[];
}

export function connectDevnet(devnet: Devnet): LocalChain {
  const chain = defineChain({
    id: devnet.chainId,
    name: "Zero One local mirror",
    nativeCurrency: { name: "Zero-value test ETH", symbol: "TETH", decimals: 18 },
    rpcUrls: { default: { http: [devnet.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(devnet.rpcUrl), cacheTime: 0 });
  const accounts = devnet.privateKeys.map((key, index) => {
    const account = privateKeyToAccount(key);
    if (getAddress(account.address) !== getAddress(devnet.addresses[index]!)) {
      throw new Error(`Anvil account/address mismatch at public index ${index}`);
    }
    return account;
  });
  const contexts = accounts.map((account) => ({
    chain,
    publicClient,
    account,
    walletClient: createWalletClient({ account, chain, transport: http(devnet.rpcUrl) }),
  })) as WriteContext[];
  return { chain, publicClient, contexts, accounts };
}

export async function deployLocal(
  context: WriteContext,
  contractName: string,
  args: readonly unknown[] = [],
): Promise<{ address: Address; hash: Hex; artifact: ContractArtifact }> {
  const artifact = loadLocalArtifact(contractName);
  const deployment = await deployArtifact(context, artifact, args);
  return { ...deployment, artifact };
}

export async function writeAndWait(
  context: WriteContext,
  request: Record<string, unknown>,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const hash = await context.walletClient.writeContract({
    ...request,
    account: context.account,
    chain: context.chain,
  } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return { hash, receipt };
}

/**
 * simulateContract that tolerates a load-balanced public RPC whose `latest` lags the receipt just
 * awaited: on failure it retries every 1.5 s for up to `attempts` tries, then throws the last error.
 * Never used for negative cases (a revert that is expected must surface at once).
 *
 * @param context Signer context.
 * @param request The simulateContract request (address, abi, functionName, args, ...).
 * @param attempts Maximum tries (default 8, about 12 s).
 * @returns The simulation result.
 * @throws The last simulation error after `attempts` failures.
 */
export async function simulateSettled<T = unknown>(context: WriteContext, request: Record<string, unknown>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return (await context.publicClient.simulateContract({ ...request, account: context.account } as never)) as T;
    } catch (error) {
      last = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw last;
}

/**
 * Poll a read until `predicate` accepts its value (public RPC lag after a receipt), then return it.
 *
 * @param read Function performing the read.
 * @param predicate Accept condition.
 * @param attempts Maximum tries 1.5 s apart (default 10).
 * @returns The last value read (accepted, or the final one after `attempts`).
 */
export async function awaitRead<T>(read: () => Promise<T>, predicate: (value: T) => boolean, attempts = 10): Promise<T> {
  let value: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      if (attempt + 1 === attempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return value as T;
}

export async function increaseTime(context: WriteContext, seconds: number | bigint): Promise<void> {
  const amount = typeof seconds === "bigint" ? seconds : BigInt(seconds);
  if (amount < 0n) throw new RangeError("Cannot move devnet time backwards");
  await context.publicClient.request({ method: "evm_increaseTime" as never, params: [Number(amount)] as never });
  await context.publicClient.request({ method: "evm_mine" as never, params: [] as never });
}

export async function mine(context: WriteContext): Promise<void> {
  await context.publicClient.request({ method: "evm_mine" as never, params: [] as never });
}

export function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function raw(value: bigint | number | boolean | string | Address | Hex): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}
