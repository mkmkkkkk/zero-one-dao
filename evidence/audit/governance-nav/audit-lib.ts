/**
 * Shared helpers for the governance / NAV audit tests (components 1 and 2 of goals/security-audit.md).
 * Everything runs on the scenarios/lib.ts mirror (a fresh anvil per test, full Zero One deployment,
 * genesis 50 USDC, A/B/C 1000 USDC each). Adds: an AuditMulticall "contract member" that batches
 * several calls into one transaction (stand-in for a flash-loan or batching attacker), raw writes
 * with an explicit gas limit, anvil snapshot / revert, and a tiny log recorder.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";

import type { WriteContext } from "../../../src/baal.js";
import { encodeProposalData } from "../../../src/baal.js";
import { type ActorName, type Mirror, printReceipt, read, type Receipt } from "../../../scenarios/lib.js";
import { compileHelper } from "./compile-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One call for AuditMulticall.run. */
export interface Call {
  to: Address;
  data: Hex;
}

/** A deployed AuditMulticall instance. */
export interface Helper {
  address: Address;
  abi: Abi;
}

/**
 * Compile (if needed) and deploy the AuditMulticall helper from `actor`.
 *
 * Args:
 *   mirror: The booted mirror.
 *   actor: Deployer actor.
 *
 * Returns:
 *   The helper's address and ABI.
 */
export async function deployHelper(mirror: Mirror, actor: ActorName): Promise<Helper> {
  const file = compileHelper();
  const artifact = JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: Hex };
  const context = mirror.actors[actor];
  const hash = await context.walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, account: context.account, chain: context.chain } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress === undefined || receipt.contractAddress === null) throw new Error(`helper deployment failed: ${hash}`);
  console.log(`   AuditMulticall helper @ ${receipt.contractAddress} (tx ${hash}, block ${receipt.blockNumber})`);
  return { address: getAddress(receipt.contractAddress), abi: artifact.abi };
}

/**
 * Execute `calls` through the helper in ONE transaction (simulated first so a revert is decoded).
 *
 * Args:
 *   mirror: The mirror.
 *   actor: The EOA that sends the transaction (the helper is msg.sender of every inner call).
 *   helper: The helper.
 *   calls: Ordered inner calls.
 *   label: Receipt label.
 *   gas: Optional explicit gas limit.
 *
 * Returns:
 *   The receipt.
 */
export async function runCalls(mirror: Mirror, actor: ActorName, helper: Helper, calls: Call[], label: string, gas?: bigint): Promise<Receipt> {
  const context = mirror.actors[actor];
  const request = { address: helper.address, abi: helper.abi, functionName: "run", args: [calls.map((c) => c.to), calls.map((c) => c.data)], account: context.account } as const;
  const simulation = await context.publicClient.simulateContract(request as never);
  const hash = await context.walletClient.writeContract({ ...simulation.request, ...(gas === undefined ? {} : { gas }), account: context.account, chain: context.chain } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`helper transaction reverted: ${hash}`);
  const out = { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  printReceipt(`${label} [ONE tx, ${calls.length} inner calls]`, out);
  return out;
}

/**
 * Send a raw contract write from `actor` WITHOUT simulation and with an explicit gas limit; used
 * where the simulation itself is what we want to bypass (a low-gas processProposal).
 *
 * Returns:
 *   The receipt plus the status ("success" | "reverted").
 */
export async function writeWithGas(context: WriteContext, address: Address, abi: Abi, functionName: string, args: readonly unknown[], gas: bigint): Promise<Receipt & { status: string }> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const hash = await context.walletClient.sendTransaction({ account: context.account, chain: context.chain, to: address, data, gas } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status };
}

/** Encode an ERC-20 approve. */
export function approveCall(mirror: Mirror, spender: Address, amount: bigint): Call {
  return { to: mirror.dao.settlement, data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "approve", args: [spender, amount] }) };
}

/** Encode DepositShaman.deposit. */
export function depositCall(mirror: Mirror, amount: bigint): Call {
  return { to: mirror.dao.depositShaman, data: encodeFunctionData({ abi: mirror.abi.deposit, functionName: "deposit", args: [amount] }) };
}

/** Encode Baal.submitVote. */
export function voteCall(mirror: Mirror, id: number, approve: boolean): Call {
  return { to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "submitVote", args: [id, approve] }) };
}

/** Encode Baal.ragequit(to, shares, 0, [settlement]). */
export function ragequitCall(mirror: Mirror, to: Address, shares: bigint): Call {
  return { to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "ragequit", args: [to, shares, 0n, [mirror.dao.settlement]] }) };
}

/** Encode Baal.processProposal. */
export function processCall(mirror: Mirror, id: number, data: Hex): Call {
  return { to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "processProposal", args: [id, data] }) };
}

/** Encode Baal.submitProposal(multicall(calls), 0, baalGas, details). */
export function submitCall(mirror: Mirror, calls: readonly { to: Address; data: Hex }[], details: string, baalGas = 0n): Call & { proposalData: Hex } {
  const proposalData = encodeProposalData(calls);
  return { to: mirror.dao.baal, data: encodeFunctionData({ abi: mirror.abi.baal, functionName: "submitProposal", args: [proposalData, 0, baalGas, details] }), proposalData };
}

/** Encode settlement.transfer (from the Safe inside a proposal, or from the helper). */
export function transferUsdcCall(mirror: Mirror, to: Address, amount: bigint): Call {
  return { to: mirror.dao.settlement, data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "transfer", args: [to, amount] }) };
}

/** Take an anvil snapshot; returns its id. */
export async function snapshotChain(mirror: Mirror): Promise<string> {
  return (await mirror.chain.publicClient.request({ method: "evm_snapshot" as never, params: [] as never })) as string;
}

/** Revert anvil to a snapshot. */
export async function revertChain(mirror: Mirror, id: string): Promise<void> {
  const ok = (await mirror.chain.publicClient.request({ method: "evm_revert" as never, params: [id] as never })) as boolean;
  if (!ok) throw new Error(`evm_revert(${id}) failed`);
  console.log(`   chain reverted to snapshot ${id}`);
}

/** Shares balance of any address. */
export async function sharesOf(mirror: Mirror, address: Address): Promise<bigint> {
  return read<bigint>(mirror, "shares", "balanceOf", [address]);
}

/** Safe settlement balance. */
export async function safeUsdc(mirror: Mirror): Promise<bigint> {
  return read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe]);
}

/** Total shares. */
export async function totalShares(mirror: Mirror): Promise<bigint> {
  return read<bigint>(mirror, "shares", "totalSupply");
}

/** Append `line` to logs/<name>.log (mirrors console output the row's evidence quotes). */
export function logLine(name: string, line: string): void {
  const dir = path.join(HERE, "logs");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${name}.log`), `${line}\n`);
  console.log(line);
}

/** Percent with 2 decimals for logs. */
export function pct2(part: bigint, whole: bigint): string {
  return whole === 0n ? "n/a" : `${(Number((part * 10_000n) / whole) / 100).toFixed(2)}%`;
}
