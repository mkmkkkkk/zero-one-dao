/**
 * Shared mirror harness for DESIGN.md §11 scenarios: boots one anvil, deploys Zero One, seeds
 * members through the design's own paths (founder stream claim + deposits at NAV), and wraps every
 * Baal verb with receipt printing. One anvil at a time; shutdown() always kills it.
 */
import { fileURLToPath } from "node:url";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { encodeProposalData, loadBaalArtifact, loadLocalArtifact, type PackedCall, type WriteContext } from "../src/baal.js";
import { startDevnet, stopDevnet, type Devnet } from "../src/devnet.js";
import { connectDevnet, increaseTime, type LocalChain } from "../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, HOUR, UNIT, type ZeroOneDao } from "../src/zeroOne.js";

export { HOUR, UNIT };

export const PROPOSAL_STATES = ["Unborn", "Submitted", "Voting", "Cancelled", "Grace", "Ready", "Processed", "Defeated"] as const;
export type ProposalStateName = (typeof PROPOSAL_STATES)[number];

export type ActorName = "F" | "A" | "B" | "C" | "D" | "O" | "W";
export const ACTOR_ROLES: Record<ActorName, string> = {
  F: "founder (stream + genesis deposit)",
  A: "member agent A",
  B: "member agent B",
  C: "member agent C",
  D: "depositor D (joins later)",
  O: "operator O (mandate recipient)",
  W: "worker W (task deliverer)",
};

export interface Mirror {
  devnet: Devnet;
  chain: LocalChain;
  dao: ZeroOneDao;
  abi: Record<"baal" | "shares" | "settlement" | "founderStream" | "deposit" | "work" | "safe", Abi>;
  actors: Record<ActorName, WriteContext>;
}

export interface Receipt {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

let stepCounter = 0;

/** Print a numbered step header. */
export function step(title: string): void {
  stepCounter += 1;
  console.log(`\n== step ${stepCounter}: ${title}`);
}

/** Print one receipt line. */
export function printReceipt(label: string, receipt: Receipt): void {
  console.log(`   tx ${label}: ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
}

/** Format an 18-decimal amount for humans. */
export function fmt(value: bigint): string {
  return formatUnits(value, 18);
}

/** Hard assertion: prints the check and throws on failure. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.log(`   ASSERT FAILED: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`   ok: ${message}`);
}

/** Expect a rejected promise whose message mentions `needle`. */
export async function expectRevert(promise: Promise<unknown>, needle: string, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const text = error instanceof Error ? `${error.message}` : String(error);
    assert(text.includes(needle), `${message} (reverted with ${needle})`);
    return;
  }
  assert(false, `${message}: expected revert ${needle} but the call succeeded`);
}

function isMainModule(url: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(url) === process.argv[1];
}

/** Run `main` when the file is executed directly (not when imported by run-all). */
export function runIfMain(url: string, main: () => Promise<void>): void {
  if (isMainModule(url)) {
    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

/** Boot anvil, deploy Zero One, and seed the standard member set. */
export async function boot(name: string): Promise<Mirror> {
  stepCounter = 0;
  const devnet = await startDevnet(`${name}-${Date.now()}`, { hardfork: "prague" });
  const chain = connectDevnet(devnet);
  const deployer = chain.contexts[0]!;
  console.log(`anvil ${devnet.rpcUrl} chainId ${devnet.chainId}`);
  const dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address });
  const mirror: Mirror = {
    devnet,
    chain,
    dao,
    abi: {
      baal: loadBaalArtifact("Baal").abi,
      safe: loadBaalArtifact("GnosisSafe").abi,
      shares: loadLocalArtifact("NavShareToken").abi,
      settlement: loadLocalArtifact("TestToken").abi,
      founderStream: loadLocalArtifact("FounderStream").abi,
      deposit: loadLocalArtifact("DepositShaman").abi,
      work: loadLocalArtifact("WorkManager").abi,
    },
    actors: {
      F: chain.contexts[0]!,
      A: chain.contexts[1]!,
      B: chain.contexts[2]!,
      C: chain.contexts[3]!,
      D: chain.contexts[4]!,
      O: chain.contexts[5]!,
      W: chain.contexts[6]!,
    },
  };
  console.log(`deployed: safe ${dao.safe} baal ${dao.baal} shares ${dao.shares} settlement ${dao.settlement}`);
  console.log(`          founderStream ${dao.founderStream} depositShaman ${dao.depositShaman} workManager ${dao.workManager}`);
  for (const [actor, context] of Object.entries(mirror.actors) as [ActorName, WriteContext][]) {
    console.log(`   ${actor} = ${context.account.address}  ${ACTOR_ROLES[actor]}`);
  }
  return mirror;
}

/** Kill the anvil child owned by this mirror. */
export async function shutdown(mirror: Mirror): Promise<void> {
  await stopDevnet(mirror.devnet);
  console.log(`anvil stopped (${mirror.devnet.rpcUrl})`);
}

async function write(context: WriteContext, request: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }): Promise<Receipt> {
  const simulation = await context.publicClient.simulateContract({ ...request, account: context.account } as never);
  const hash = await context.walletClient.writeContract({ ...simulation.request, account: context.account, chain: context.chain } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

/** Read helper bound to the mirror. */
export async function read<T>(mirror: Mirror, target: keyof Mirror["abi"], functionName: string, args: readonly unknown[] = []): Promise<T> {
  const address = {
    baal: mirror.dao.baal,
    safe: mirror.dao.safe,
    shares: mirror.dao.shares,
    settlement: mirror.dao.settlement,
    founderStream: mirror.dao.founderStream,
    deposit: mirror.dao.depositShaman,
    work: mirror.dao.workManager,
  }[target];
  return (await mirror.chain.publicClient.readContract({ address, abi: mirror.abi[target], functionName, args } as never)) as T;
}

/** Advance chain time and mine one block. */
export async function warp(mirror: Mirror, seconds: number, label?: string): Promise<void> {
  await increaseTime(mirror.actors.F, seconds);
  const block = await mirror.chain.publicClient.getBlock();
  console.log(`   warp +${seconds}s${label ? ` (${label})` : ""} -> block ${block.number} timestamp ${block.timestamp}`);
}

/** Current block timestamp. */
export async function now(mirror: Mirror): Promise<bigint> {
  return (await mirror.chain.publicClient.getBlock()).timestamp;
}

export interface Snapshot {
  safeSettlement: bigint;
  totalShares: bigint;
  settlement: Record<string, bigint>;
  shares: Record<string, bigint>;
}

/** Print and return settlement balances and share balances for the given actors plus the Safe. */
export async function snapshot(mirror: Mirror, label: string, actors: ActorName[]): Promise<Snapshot> {
  const result: Snapshot = {
    safeSettlement: await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe]),
    totalShares: await read<bigint>(mirror, "shares", "totalSupply"),
    settlement: {},
    shares: {},
  };
  console.log(`   [${label}] treasury(Safe) settlement = ${fmt(result.safeSettlement)}  totalShares = ${fmt(result.totalShares)}`);
  for (const actor of actors) {
    const address = mirror.actors[actor].account.address;
    result.settlement[actor] = await read<bigint>(mirror, "settlement", "balanceOf", [address]);
    result.shares[actor] = await read<bigint>(mirror, "shares", "balanceOf", [address]);
    console.log(`   [${label}] ${actor}: settlement = ${fmt(result.settlement[actor])}  shares = ${fmt(result.shares[actor])}`);
  }
  return result;
}

/** Transfer test settlement from the deployer (holds the fixed supply) to an actor. */
export async function fund(mirror: Mirror, actor: ActorName, amount: bigint): Promise<Receipt> {
  const receipt = await write(mirror.actors.F, {
    address: mirror.dao.settlement,
    abi: mirror.abi.settlement,
    functionName: "transfer",
    args: [mirror.actors[actor].account.address, amount],
  });
  printReceipt(`fund ${actor} with ${fmt(amount)} settlement`, receipt);
  return receipt;
}

/** Approve and deposit settlement at NAV through the DepositShaman; returns shares minted. */
export async function deposit(mirror: Mirror, actor: ActorName, amount: bigint): Promise<{ receipt: Receipt; sharesMinted: bigint; quoted: bigint }> {
  const context = mirror.actors[actor];
  const approve = await write(context, { address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "approve", args: [mirror.dao.depositShaman, amount] });
  printReceipt(`${actor} approve deposit shaman`, approve);
  const quoted = await read<bigint>(mirror, "deposit", "quote", [amount]);
  const before = await read<bigint>(mirror, "shares", "balanceOf", [context.account.address]);
  const receipt = await write(context, { address: mirror.dao.depositShaman, abi: mirror.abi.deposit, functionName: "deposit", args: [amount] });
  const after = await read<bigint>(mirror, "shares", "balanceOf", [context.account.address]);
  const sharesMinted = after - before;
  printReceipt(`${actor} deposit ${fmt(amount)} -> ${fmt(sharesMinted)} shares (quoted ${fmt(quoted)})`, receipt);
  return { receipt, sharesMinted, quoted };
}

/** Claim the founder stream (anyone may call; mints to the founder). */
export async function claimFounderStream(mirror: Mirror): Promise<{ receipt: Receipt; minted: bigint }> {
  const claimable = await read<bigint>(mirror, "founderStream", "claimable");
  const receipt = await write(mirror.actors.F, { address: mirror.dao.founderStream, abi: mirror.abi.founderStream, functionName: "claim" });
  printReceipt(`founder stream claim ${fmt(claimable)} shares`, receipt);
  return { receipt, minted: claimable };
}

/**
 * Standard seed used by every scenario: 1 h after genesis the founder claims the stream and makes
 * the genesis deposit; A, B, C each deposit 1000 at NAV. Result: F, A, B, C hold ~equal shares.
 */
export async function seedMembers(mirror: Mirror): Promise<Snapshot> {
  step("seed: fund actors with test settlement");
  for (const actor of ["A", "B", "C", "D", "O", "W"] as ActorName[]) await fund(mirror, actor, 10_000n * UNIT);
  step("seed: founder stream claim after 1 h, then genesis deposit by the founder");
  await warp(mirror, HOUR, "1 h after genesis");
  await claimFounderStream(mirror);
  await deposit(mirror, "F", 1_000n * UNIT);
  step("seed: A, B, C deposit 1000 each at NAV");
  for (const actor of ["A", "B", "C"] as ActorName[]) await deposit(mirror, actor, 1_000n * UNIT);
  return snapshot(mirror, "seeded", ["F", "A", "B", "C"]);
}

export interface Proposal {
  id: number;
  data: Hex;
  submit: Receipt;
}

/** Submit a Baal proposal (self-sponsored when the submitter holds >= sponsorThreshold). */
export async function propose(mirror: Mirror, actor: ActorName, calls: readonly PackedCall[], details: string): Promise<Proposal> {
  const data = encodeProposalData(calls);
  const before = await read<number>(mirror, "baal", "proposalCount");
  const receipt = await write(mirror.actors[actor], { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data, 0, 0n, details] });
  const id = Number(before) + 1;
  printReceipt(`${actor} submitProposal #${id} "${details}"`, receipt);
  await warp(mirror, 1, "let votingStarts become past");
  console.log(`   proposal #${id} state = ${await stateOf(mirror, id)}`);
  return { id, data, submit: receipt };
}

/** Sponsor a submitted proposal. */
export async function sponsor(mirror: Mirror, actor: ActorName, id: number): Promise<Receipt> {
  const receipt = await write(mirror.actors[actor], { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "sponsorProposal", args: [id] });
  printReceipt(`${actor} sponsorProposal #${id}`, receipt);
  await warp(mirror, 1, "let votingStarts become past");
  console.log(`   proposal #${id} state = ${await stateOf(mirror, id)}`);
  return receipt;
}

/** Cast a share-weighted vote. */
export async function vote(mirror: Mirror, actor: ActorName, id: number, approve: boolean): Promise<Receipt> {
  const receipt = await write(mirror.actors[actor], { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitVote", args: [id, approve] });
  const info = await proposalInfo(mirror, id);
  printReceipt(`${actor} votes ${approve ? "YES" : "NO"} on #${id} -> yes ${fmt(info.yesVotes)} / no ${fmt(info.noVotes)}`, receipt);
  return receipt;
}

export interface ProposalInfo {
  votingStarts: number;
  votingEnds: number;
  graceEnds: number;
  yesVotes: bigint;
  noVotes: bigint;
  sponsor: Address;
  status: { cancelled: boolean; processed: boolean; passed: boolean; actionFailed: boolean };
}

/** Read the proposal struct. */
export async function proposalInfo(mirror: Mirror, id: number): Promise<ProposalInfo> {
  const raw = await read<readonly unknown[]>(mirror, "baal", "proposals", [id]);
  const status = await read<readonly boolean[]>(mirror, "baal", "getProposalStatus", [id]);
  return {
    votingStarts: Number(raw[2]),
    votingEnds: Number(raw[3]),
    graceEnds: Number(raw[4]),
    yesVotes: raw[7] as bigint,
    noVotes: raw[8] as bigint,
    sponsor: getAddress(raw[11] as Address), // bool[4] status is omitted by the public getter
    status: { cancelled: status[0]!, processed: status[1]!, passed: status[2]!, actionFailed: status[3]! },
  };
}

/** Human-readable Baal proposal state. */
export async function stateOf(mirror: Mirror, id: number): Promise<ProposalStateName> {
  const index = await read<number>(mirror, "baal", "state", [id]);
  return PROPOSAL_STATES[Number(index)]!;
}

/** Warp to just past voting end (Grace) or just past grace end (Ready/Defeated). */
export async function warpPastVoting(mirror: Mirror, id: number): Promise<void> {
  const info = await proposalInfo(mirror, id);
  const current = await now(mirror);
  await warp(mirror, Number(BigInt(info.votingEnds) + 1n - current), `to grace of #${id}`);
  console.log(`   proposal #${id} state = ${await stateOf(mirror, id)}`);
}

export async function warpPastGrace(mirror: Mirror, id: number): Promise<void> {
  const info = await proposalInfo(mirror, id);
  const current = await now(mirror);
  await warp(mirror, Number(BigInt(info.graceEnds) + 1n - current), `past grace of #${id}`);
  console.log(`   proposal #${id} state = ${await stateOf(mirror, id)}`);
}

/** Process (execute) a Ready proposal; returns the resulting flags. */
export async function processProposal(mirror: Mirror, actor: ActorName, proposal: Proposal): Promise<{ receipt: Receipt; info: ProposalInfo }> {
  const receipt = await write(mirror.actors[actor], { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "processProposal", args: [proposal.id, proposal.data] });
  const info = await proposalInfo(mirror, proposal.id);
  printReceipt(`${actor} processProposal #${proposal.id} -> passed=${info.status.passed} actionFailed=${info.status.actionFailed} state=${await stateOf(mirror, proposal.id)}`, receipt);
  return { receipt, info };
}

/** Ragequit all (or `sharesToBurn`) of an actor's shares for the settlement asset; returns payout. */
export async function ragequit(mirror: Mirror, actor: ActorName, sharesToBurn?: bigint): Promise<{ receipt: Receipt; burned: bigint; paid: bigint; expected: bigint }> {
  const context = mirror.actors[actor];
  const burned = sharesToBurn ?? (await read<bigint>(mirror, "shares", "balanceOf", [context.account.address]));
  const supply = await read<bigint>(mirror, "shares", "totalSupply");
  const treasury = await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe]);
  const expected = (burned * treasury) / supply;
  const before = await read<bigint>(mirror, "settlement", "balanceOf", [context.account.address]);
  const receipt = await write(context, { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "ragequit", args: [context.account.address, burned, 0n, [mirror.dao.settlement]] });
  const after = await read<bigint>(mirror, "settlement", "balanceOf", [context.account.address]);
  const paid = after - before;
  printReceipt(`${actor} ragequit ${fmt(burned)} shares -> paid ${fmt(paid)} settlement (pro-rata of ${fmt(treasury)} at supply ${fmt(supply)})`, receipt);
  return { receipt, burned, paid, expected };
}

/** Build a Safe->settlement.transfer call for a proposal multicall. */
export function transferCall(mirror: Mirror, to: Address, amount: bigint): PackedCall {
  return {
    to: mirror.dao.settlement,
    data: encodeFunctionData({ abi: mirror.abi.settlement, functionName: "transfer", args: [to, amount] }),
  };
}

/** Generic write for scenario-specific calls. */
export async function send(mirror: Mirror, actor: ActorName, target: keyof Mirror["abi"], functionName: string, args: readonly unknown[], label: string): Promise<Receipt> {
  const address = {
    baal: mirror.dao.baal,
    safe: mirror.dao.safe,
    shares: mirror.dao.shares,
    settlement: mirror.dao.settlement,
    founderStream: mirror.dao.founderStream,
    deposit: mirror.dao.depositShaman,
    work: mirror.dao.workManager,
  }[target];
  const receipt = await write(mirror.actors[actor], { address, abi: mirror.abi[target], functionName, args });
  printReceipt(label, receipt);
  return receipt;
}

/** Simulate a write expecting it to revert (for negative cases). */
export async function simulate(mirror: Mirror, actor: ActorName, target: keyof Mirror["abi"], functionName: string, args: readonly unknown[]): Promise<unknown> {
  const address = {
    baal: mirror.dao.baal,
    safe: mirror.dao.safe,
    shares: mirror.dao.shares,
    settlement: mirror.dao.settlement,
    founderStream: mirror.dao.founderStream,
    deposit: mirror.dao.depositShaman,
    work: mirror.dao.workManager,
  }[target];
  const context = mirror.actors[actor];
  return mirror.chain.publicClient.simulateContract({ address, abi: mirror.abi[target], functionName, args, account: context.account } as never);
}

/** Print the scenario verdict block. */
export function verdict(scenario: string, passed: boolean): void {
  console.log(`\n=== SCENARIO ${scenario}: ${passed ? "PASS" : "FAIL"} ===\n`);
}
