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
