/**
 * Shared mirror harness for DESIGN.md §11 scenarios: boots one anvil, deploys Zero One, asserts
 * that DepositShaman and WorkManager are the only mint paths, seeds members through the design's
 * own path (deposits at NAV; the founder's genesis deposit first), and wraps every Baal verb with
 * receipt printing. One anvil at a time; shutdown() always kills it.
 */
import { fileURLToPath } from "node:url";
import {
  BaseError,
  decodeErrorResult,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { encodeProposalData, loadBaalArtifact, loadLocalAbi, loadLocalArtifact, type PackedCall, type WriteContext } from "../src/baal.js";
import { startDevnet, stopDevnet, type Devnet } from "../src/devnet.js";
import { connectDevnet, deployLocal, increaseTime, type LocalChain } from "../src/onchain.js";
import { describe, factoryAbi, submitTemplateProposal, TEMPLATE_NAMES, type Description, type SubmittedProposal, type TemplateSpec } from "../src/proposals.js";
import { constitutionHash, DEFAULT_PARAMS, deployZeroOne, enumerateShamans, GENESIS_DEPOSIT, HOUR, SETTLEMENT_UNIT, UNIT, type ZeroOneDao } from "../src/zeroOne.js";

export { GENESIS_DEPOSIT, HOUR, SETTLEMENT_UNIT, UNIT };
export const DAY = 24 * HOUR;

export const PROPOSAL_STATES = ["Unborn", "Submitted", "Voting", "Cancelled", "Grace", "Ready", "Processed", "Defeated"] as const;
export type ProposalStateName = (typeof PROPOSAL_STATES)[number];

export type ActorName = "F" | "A" | "B" | "C" | "D" | "O" | "W";
export const ACTOR_ROLES: Record<ActorName, string> = {
  F: "founder (deployer; ordinary member via the 50 USDC genesis deposit)",
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
  abi: Record<"baal" | "shares" | "settlement" | "deposit" | "work" | "safe" | "constitution" | "factory" | "proposal" | "payment" | "strategy" | "project" | "config" | "dex", Abi>;
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

/** Format an 18-decimal share amount for humans. */
export function fmt(value: bigint): string {
  return formatUnits(value, 18);
}

/** Format a 6-decimal settlement (USDC) amount for humans. */
export function fmtS(value: bigint): string {
  return formatUnits(value, 6);
}

/** Percentage of `part` in `whole`, 4 decimals, for logs. */
export function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return "n/a";
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(4)}%`;
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

/**
 * Expect a contract deployment to revert in its constructor with the custom error `needle`.
 * Simulates the creation with eth_call (no transaction is sent) and decodes the revert data.
 */
export async function expectDeployRevert(mirror: Mirror, actor: ActorName, contractName: string, args: readonly unknown[], needle: string, message: string): Promise<void> {
  const artifact = loadLocalArtifact(contractName);
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args } as never);
  try {
    await mirror.chain.publicClient.call({ data, account: mirror.actors[actor].account });
  } catch (error) {
    let decoded = "";
    if (error instanceof BaseError) {
      const withData = error.walk((candidate) => typeof (candidate as { data?: unknown }).data === "string") as { data?: Hex } | null;
      if (withData?.data !== undefined && withData.data !== "0x") {
        try {
          decoded = decodeErrorResult({ abi: artifact.abi, data: withData.data }).errorName;
        } catch {
          decoded = withData.data;
        }
      }
    }
    const text = `${decoded} ${error instanceof Error ? error.message : String(error)}`;
    assert(text.includes(needle), `${message} (constructor reverted with ${needle})`);
    return;
  }
  assert(false, `${message}: expected constructor revert ${needle} but the deployment succeeded`);
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
  let dao: ZeroOneDao;
  try {
    dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address });
  } catch (error) {
    await stopDevnet(devnet);
    throw error;
  }
  const mirror: Mirror = {
    devnet,
    chain,
    dao,
    abi: {
      baal: loadBaalArtifact("Baal").abi,
      safe: loadBaalArtifact("GnosisSafe").abi,
      shares: loadLocalArtifact("NavShareToken").abi,
      settlement: loadLocalArtifact("TestToken").abi,
      deposit: loadLocalArtifact("DepositShaman").abi,
      work: loadLocalArtifact("WorkManager").abi,
      constitution: loadLocalArtifact("Constitution").abi,
      factory: factoryAbi(),
      // Common surface plus the base contract's custom errors, so negative cases decode OnlySafe / WrongStatus.
      proposal: [...loadLocalAbi("IProposalContract"), ...loadLocalAbi("ProposalBase").filter((item) => item.type === "error" || item.type === "event")],
      payment: loadLocalArtifact("PaymentProposal").abi,
      strategy: loadLocalArtifact("StrategyProposal").abi,
      project: loadLocalArtifact("ProjectProposal").abi,
      config: loadLocalArtifact("ConfigProposal").abi,
      dex: loadLocalArtifact("MockDex").abi,
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
  console.log(`          depositShaman ${dao.depositShaman} workManager ${dao.workManager} constitution ${dao.constitution}`);
  console.log(`          templateFactory ${dao.templateFactory} deployers ${dao.templateDeployers.join(" ")} intentAccount ${dao.intentAccount}`);
  for (const [actor, context] of Object.entries(mirror.actors) as [ActorName, WriteContext][]) {
    console.log(`   ${actor} = ${context.account.address}  ${ACTOR_ROLES[actor]}`);
  }
  try {
    await assertOnlyMintPaths(mirror);
    await assertConstitution(mirror);
    await assertFactory(mirror);
  } catch (error) {
    await stopDevnet(devnet);
    throw error;
  }
  return mirror;
}

/** Assert the deployed Constitution carries exactly keccak256(docs/CONSTITUTION.md) and no setter. */
export async function assertConstitution(mirror: Mirror): Promise<void> {
  const onChain = await read<Hex>(mirror, "constitution", "textHash");
  const local = constitutionHash();
  console.log(`   constitution textHash ${onChain} url ${await read<string>(mirror, "constitution", "textUrl")}`);
  assert(onChain === local, "Constitution.textHash == keccak256(docs/CONSTITUTION.md exact bytes)");
  const setters = mirror.abi.constitution.filter((item) => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure");
  assert(setters.length === 0, "Constitution has no state-changing function (immutable, no amendment path)");
}

/**
 * Assert the CREATE2 TemplateFactory is bound to this DAO (Safe, settlement, Baal), dispatches ids
 * 0..3 to deployers named Payment / Strategy / Project / Config, each bound to the same Safe and
 * settlement, and that the intent account points at this factory (decision.md phase 2b ruling 2).
 */
export async function assertFactory(mirror: Mirror): Promise<void> {
  const factory = mirror.dao.templateFactory;
  const readFactory = <T,>(functionName: string, args: readonly unknown[] = []) => readAt<T>(mirror, factory, "factory", functionName, args);
  assert(getAddress(await readFactory<Address>("safe")) === getAddress(mirror.dao.safe) && getAddress(await readFactory<Address>("settlement")) === getAddress(mirror.dao.settlement) && getAddress(await readFactory<Address>("baal")) === getAddress(mirror.dao.baal), "TemplateFactory is bound to this Safe, settlement and Baal");
  const deployerAbi = loadLocalArtifact("PaymentDeployer").abi;
  for (const [index, name] of TEMPLATE_NAMES.entries()) {
    const deployer = getAddress(await readFactory<Address>("deployer", [index]));
    assert(deployer === getAddress(mirror.dao.templateDeployers[index]!) && (await readFactory<string>("templateName", [index])) === name, `factory template ${index} -> ${name} deployer ${deployer}`);
    const [safe, settlement] = await Promise.all([
      mirror.chain.publicClient.readContract({ address: deployer, abi: deployerAbi, functionName: "safe" }) as Promise<Address>,
      mirror.chain.publicClient.readContract({ address: deployer, abi: deployerAbi, functionName: "settlement" }) as Promise<Address>,
    ]);
    assert(getAddress(safe) === getAddress(mirror.dao.safe) && getAddress(settlement) === getAddress(mirror.dao.settlement), `${name} deployer is bound to the same Safe and settlement`);
  }
  const accountFactory = (await mirror.chain.publicClient.readContract({ address: mirror.dao.intentAccount, abi: loadLocalArtifact("ZeroOneIntentAccount").abi, functionName: "factory" })) as Address;
  assert(getAddress(accountFactory) === getAddress(factory), "ZeroOneIntentAccount.factory is this TemplateFactory (op 0 deploys and submits through it)");
}

/**
 * Assert that the only addresses able to mint shares are the two design shamans plus the Safe
 * (Baal.mintShares is baalOrManagerOnly: avatar == Safe, i.e. a passed proposal, or a manager).
 * Enumerates every ShamanSet event since block 0 and reads each address's live permission.
 */
export async function assertOnlyMintPaths(mirror: Mirror): Promise<void> {
  const shamans = await enumerateShamans(mirror.actors.F, mirror.dao.baal);
  for (const { shaman, permission } of shamans) {
    const label = shaman === getAddress(mirror.dao.depositShaman) ? "DepositShaman" : shaman === getAddress(mirror.dao.workManager) ? "WorkManager" : "UNKNOWN";
    console.log(`   shaman ${shaman} permission ${permission} (${label})`);
  }
  const managers = shamans.filter(({ permission }) => [2n, 3n, 6n, 7n].includes(permission)).map(({ shaman }) => shaman);
  const expected = [getAddress(mirror.dao.depositShaman), getAddress(mirror.dao.workManager)];
  assert(shamans.every(({ permission }) => permission === 0n || permission === 2n), "every shaman ever set is either revoked (0) or a plain manager (2): no admin, no governor");
  assert(managers.length === 2 && expected.every((address) => managers.includes(address)), "the only manager (mint) shamans are DepositShaman and WorkManager");
  const avatar = getAddress(await read<Address>(mirror, "baal", "avatar"));
  assert(avatar === getAddress(mirror.dao.safe), "Baal.avatar is the Safe: the only non-shaman minter is a passed proposal executed by the Safe");
  assert((await read<boolean>(mirror, "baal", "isManager", [mirror.actors.F.account.address])) === false, "the founder holds no shaman permission");
  assert((await read<boolean>(mirror, "baal", "adminLock")) === true, "adminLock is on");
  await expectRevert(simulate(mirror, "F", "baal", "mintShares", [[mirror.actors.F.account.address], [UNIT]]), "!baal & !manager", "the founder cannot call Baal.mintShares directly");
}

/** Kill the anvil child owned by this mirror. */
export async function shutdown(mirror: Mirror): Promise<void> {
  await stopDevnet(mirror.devnet);
  console.log(`anvil stopped (${mirror.devnet.rpcUrl})`);
}

/**
 * Simulate, send and wait. `gas` overrides the estimate: Baal.processProposal swallows an action
 * failure (actionFailed = true, no revert), so eth_estimateGas can return a limit at which the outer
 * call succeeds while the voted multicall runs out of gas inside; execution must send an explicit
 * limit (the relay must do the same).
 */
async function write(context: WriteContext, request: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint }): Promise<Receipt> {
  const { gas, ...call } = request;
  const simulation = await context.publicClient.simulateContract({ ...call, account: context.account } as never);
  const hash = await context.walletClient.writeContract({ ...simulation.request, ...(gas === undefined ? {} : { gas }), account: context.account, chain: context.chain } as never);
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

/** Address of a fixed mirror target (template instances use readAt / sendAt with an explicit address). */
function addressOf(mirror: Mirror, target: keyof Mirror["abi"]): Address {
  const fixed: Partial<Record<keyof Mirror["abi"], Address>> = {
    baal: mirror.dao.baal,
    safe: mirror.dao.safe,
    shares: mirror.dao.shares,
    settlement: mirror.dao.settlement,
    deposit: mirror.dao.depositShaman,
    work: mirror.dao.workManager,
    constitution: mirror.dao.constitution,
  };
  const address = fixed[target];
  if (address === undefined) throw new Error(`target ${target} has no fixed address; use readAt/sendAt`);
  return address;
}

/** Read helper bound to the mirror. */
export async function read<T>(mirror: Mirror, target: keyof Mirror["abi"], functionName: string, args: readonly unknown[] = []): Promise<T> {
  return readAt<T>(mirror, addressOf(mirror, target), target, functionName, args);
}

/** Read any contract by address with one of the mirror's ABIs. */
export async function readAt<T>(mirror: Mirror, address: Address, abi: keyof Mirror["abi"], functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await mirror.chain.publicClient.readContract({ address, abi: mirror.abi[abi], functionName, args } as never)) as T;
}

/** Write to any contract by address with one of the mirror's ABIs. */
export async function sendAt(mirror: Mirror, actor: ActorName, address: Address, abi: keyof Mirror["abi"], functionName: string, args: readonly unknown[], label: string): Promise<Receipt> {
  const receipt = await write(mirror.actors[actor], { address, abi: mirror.abi[abi], functionName, args });
  printReceipt(label, receipt);
  return receipt;
}

/** Simulate a write to any contract by address, expecting it to revert (for negative cases). */
export async function simulateAt(mirror: Mirror, actor: ActorName, address: Address, abi: keyof Mirror["abi"], functionName: string, args: readonly unknown[]): Promise<unknown> {
  const context = mirror.actors[actor];
  return mirror.chain.publicClient.simulateContract({ address, abi: mirror.abi[abi], functionName, args, account: context.account } as never);
}

/** Settlement balance of any address. */
export async function usdcOf(mirror: Mirror, address: Address): Promise<bigint> {
  return read<bigint>(mirror, "settlement", "balanceOf", [address]);
}

/** describe() of a proposal contract, printed. */
export async function describeAt(mirror: Mirror, address: Address, label: string): Promise<Description> {
  const d = await describe(mirror.actors.F, address);
  console.log(`   [${label}] ${d.template} @ ${address}: status ${d.status} budget ${fmtS(d.budget)} deadline ${d.deadline} operator ${d.operator} params ${d.paramsHash} held ${fmtS(await usdcOf(mirror, address))} USDC`);
  return d;
}

/** Deploy a template instance through the CREATE2 factory and submit the Baal proposal that funds and starts it (src/proposals.ts). */
export async function proposeTemplate(mirror: Mirror, actor: ActorName, spec: TemplateSpec, summary: string): Promise<SubmittedProposal & Proposal> {
  const submitted = await submitTemplateProposal(mirror.actors[actor], mirror.dao, spec, summary);
  console.log(`   ${actor} deployed ${submitted.instance.contractName} @ ${submitted.instance.address} via TemplateFactory (tx ${submitted.instance.deployHash ?? "already deployed"}, salt ${submitted.instance.salt}) paramsHash ${submitted.instance.paramsHash} codeHash ${submitted.instance.codeHash}`);
  console.log(`   factory.proposalData == builder multicall (asserted byte-identical in submitTemplateProposal)`);
  const receipt = await mirror.chain.publicClient.getTransactionReceipt({ hash: submitted.submitHash });
  const submit: Receipt = { hash: submitted.submitHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  printReceipt(`${actor} submitProposal #${submitted.id} "${submitted.details.slice(0, 80)}..."`, submit);
  console.log(`   details: ${submitted.details}`);
  await warp(mirror, 1, "let votingStarts become past");
  console.log(`   proposal #${submitted.id} state = ${await stateOf(mirror, submitted.id)}`);
  return { ...submitted, submit };
}

export interface MockMarket {
  asset: Address;
  dex: Address;
  price: bigint;
}

/**
 * Deploy the mirror venue: a 6-dec "Mock Asset" (MOCK) TestToken held by the founder and a MockDex
 * at `price` (settlement units per whole MOCK), seeded with `liquidity` of each side by the founder.
 */
export async function deployMockMarket(mirror: Mirror, price: bigint, liquidity: bigint): Promise<MockMarket> {
  const F = mirror.actors.F;
  const asset = await deployLocal(F, "TestToken", ["Mock Asset", "MOCK", 1_000_000_000n * SETTLEMENT_UNIT]);
  const dex = await deployLocal(F, "MockDex", [mirror.dao.settlement, asset.address, price]);
  console.log(`   MOCK ${asset.address} (tx ${asset.hash}); MockDex ${dex.address} (tx ${dex.hash}) price ${fmtS(price)} USDC per MOCK`);
  const seedUsdc = await write(F, { address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [dex.address, liquidity] });
  printReceipt(`F seeds MockDex with ${fmtS(liquidity)} USDC`, seedUsdc);
  const seedAsset = await write(F, { address: asset.address, abi: mirror.abi.settlement, functionName: "transfer", args: [dex.address, liquidity] });
  printReceipt(`F seeds MockDex with ${fmtS(liquidity)} MOCK`, seedAsset);
  return { asset: asset.address, dex: dex.address, price };
}

/** Move the MockDex price (mirror control). */
export async function setPrice(mirror: Mirror, market: MockMarket, price: bigint): Promise<Receipt> {
  return sendAt(mirror, "F", market.dex, "dex", "setPrice", [price], `MockDex price -> ${fmtS(price)} USDC per MOCK`);
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
  console.log(`   [${label}] treasury(Safe) USDC = ${fmtS(result.safeSettlement)}  totalShares = ${fmt(result.totalShares)}`);
  for (const actor of actors) {
    const address = mirror.actors[actor].account.address;
    result.settlement[actor] = await read<bigint>(mirror, "settlement", "balanceOf", [address]);
    result.shares[actor] = await read<bigint>(mirror, "shares", "balanceOf", [address]);
    console.log(`   [${label}] ${actor}: USDC = ${fmtS(result.settlement[actor])}  shares = ${fmt(result.shares[actor])}`);
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
  printReceipt(`fund ${actor} with ${fmtS(amount)} USDC`, receipt);
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
  printReceipt(`${actor} deposit ${fmtS(amount)} USDC -> ${fmt(sharesMinted)} shares (quoted ${fmt(quoted)})`, receipt);
  return { receipt, sharesMinted, quoted };
}

/**
 * Standard seed used by scenarios A-E: the founder makes the genesis deposit (50 USDC -> 50e18
 * shares, 100% of supply); A, B, C each deposit 1000 USDC at NAV. Result: A, B, C hold exactly
 * 1000 shares each, F exactly 50; nothing is minted by any other path.
 */
export async function seedMembers(mirror: Mirror): Promise<Snapshot> {
  step("seed: fund actors with USDC-mock");
  for (const actor of ["A", "B", "C", "D", "O", "W"] as ActorName[]) await fund(mirror, actor, 10_000n * SETTLEMENT_UNIT);
  step("seed: genesis deposit 50 USDC by the founder -> 50e18 shares = 100% of supply");
  const genesis = await deposit(mirror, "F", GENESIS_DEPOSIT);
  assert(genesis.sharesMinted === 50n * UNIT, "genesis: 50 USDC (50e6) -> exactly 50e18 shares (1 USDC -> 1e18 shares while the treasury is empty)");
  assert((await read<bigint>(mirror, "shares", "totalSupply")) === 50n * UNIT, "the founder holds 100% of supply after genesis; nothing else was minted");
  step("seed: A, B, C deposit 1000 USDC each at NAV (1 USDC per share)");
  for (const actor of ["A", "B", "C"] as ActorName[]) await deposit(mirror, actor, 1_000n * SETTLEMENT_UNIT);
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

/** Gas limit for processProposal: explicit, never the estimate (see write()). */
export const PROCESS_GAS = 5_000_000n;

/** Process (execute) a Ready proposal with an explicit gas limit; returns the resulting flags. */
export async function processProposal(mirror: Mirror, actor: ActorName, proposal: Proposal): Promise<{ receipt: Receipt; info: ProposalInfo }> {
  const receipt = await write(mirror.actors[actor], { address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "processProposal", args: [proposal.id, proposal.data], gas: PROCESS_GAS });
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
  printReceipt(`${actor} ragequit ${fmt(burned)} shares -> paid ${fmtS(paid)} USDC (pro-rata of ${fmtS(treasury)} at supply ${fmt(supply)})`, receipt);
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
  return sendAt(mirror, actor, addressOf(mirror, target), target, functionName, args, label);
}

/** Simulate a write expecting it to revert (for negative cases). */
export async function simulate(mirror: Mirror, actor: ActorName, target: keyof Mirror["abi"], functionName: string, args: readonly unknown[]): Promise<unknown> {
  return simulateAt(mirror, actor, addressOf(mirror, target), target, functionName, args);
}

/** Print the scenario verdict block. */
export function verdict(scenario: string, passed: boolean): void {
  console.log(`\n=== SCENARIO ${scenario}: ${passed ? "PASS" : "FAIL"} ===\n`);
}
