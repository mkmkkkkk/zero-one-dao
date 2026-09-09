/**
 * Scenario K (DESIGN.md §11, phase 4 "Hole 2", phase 5 rulings 4b and 5): the UniswapV3Venue against the
 * published Base Uniswap v3 contracts on an owned loopback Anvil fork of Base. Opt-in (FORK_RPC); every
 * broadcast goes to the validated fork, never to a public network.
 *
 * Proves: the constructor refuses a pool whose observation history cannot serve the 30-minute window; two
 * bounded DCA buys; voted stop() keeps WETH inside the open instance (deposits paused) and a voted unwind()
 * sells it through the real router; voted migration; take-profit and stop-loss sells; and three in-transaction
 * sandwiches (`contracts/test/TwapSandwichProbe.sol`): a same-block spot print of more than 20% leaves
 * `price()` and `value()` unchanged, a DCA run and a deadline unwind during the print revert on the TWAP
 * bound, a stop-loss is not fired by the print, and after the back-run restores the pool the same runs succeed.
 */
import { decodeErrorResult, decodeEventLog, encodeDeployData, encodeFunctionData, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { assertBaseFork, fundForkUsdc, startBaseFork } from "../src/baseFork.js";
import { loadBaalArtifact, loadLocalArtifact, type PackedCall } from "../src/baal.js";
import { stopDevnet, type Devnet } from "../src/devnet.js";
import { connectDevnet, deployLocal, increaseTime, writeAndWait, type WriteContext } from "../src/onchain.js";
import { deployTemplate, describe, migrateCalls, stopCalls, submitCalls, submitTemplateProposal, unwindCalls, type StrategyParams } from "../src/proposals.js";
import { BASE_USDC, DEFAULT_PARAMS, deployZeroOne, genesisDeposit, SETTLEMENT_UNIT, type ZeroOneDao } from "../src/zeroOne.js";
import { assert, expectRevert, runIfMain } from "./lib.js";

export const BASE_UNISWAP = {
  router: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
  quoter: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
};

/** Large Base USDC holders the fork impersonates for sandwich capital (fork only; first with enough balance wins). */
export const FORK_USDC_WHALES: Address[] = [
  getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"), // Morpho Blue
  getAddress("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"), // Aave v3 aBasUSDC
  getAddress("0xb125E6687d4313864e53df431d5425969c15Eb2F"), // Compound v3 cUSDCv3
];

/** Spot move the sandwiches must reach (basis points of the pre-manipulation price). */
export const SANDWICH_MOVE_BPS = 2_000n;
const SANDWICH_USDC = 60_000_000n * SETTLEMENT_UNIT;
const SANDWICH_ETH = 100_000n * 10n ** 18n;

const erc20 = parseAbi(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function allowance(address,address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
const poolAbi = parseAbi([
  "function observe(uint32[]) view returns(int56[],uint160[])",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function observations(uint256) view returns(uint32,int56,uint160,bool)",
  "function initialize(uint160)",
]);
const dependencyAbi = parseAbi(["function factory() view returns(address)", "function WETH9() view returns(address)", "function feeAmountTickSpacing(uint24) view returns(int24)", "function getPool(address,address,uint24) view returns(address)", "function createPool(address,address,uint24) returns(address)"]);

/** One venue swap decoded from a `Swapped` event. */
export interface VenueSwap { tokenIn: Address; amountIn: bigint; quoted: bigint; minimum: bigint; amountOut: bigint }

/** The numbers `TwapSandwichProbe.sandwich` reports for one sandwich. */
export interface SandwichReport {
  priceBefore: bigint; priceDuring: bigint; valueBefore: bigint; valueDuring: bigint;
  sqrtBefore: bigint; sqrtDuring: bigint; sqrtAfter: bigint; moved: bigint; received: bigint;
  refusedOutput: bigint; refusedMinimum: bigint;
}

/** One sandwich transaction: the probe's report, the venue swaps that filled inside it, and the victim afterwards. */
export interface SandwichProof {
  strategy: Address; hash: Hex; gas: bigint; report: SandwichReport; swaps: VenueSwap[];
  statusAfter: string; wethAfter: bigint; usdcAfter: bigint;
  /** Spot move of the print in basis points of the pre-manipulation price (signed). */
  spotMoveBps: bigint;
  /** Spot after the back-run in basis points of the pre-manipulation price (signed). */
  restoredMoveBps: bigint;
}

/** The three sandwiches scenario K and the T-4 / T-5 audit test share. */
export interface SandwichProofs {
  /** T-4: +20% print, DCA buy refused on the bound, fills after the back-run. */
  entry: SandwichProof;
  /** T-5: -20% print with a 25% stop-loss, value() unchanged, no unwind, the run buys instead. */
  print: SandwichProof;
  /** T-5 / T-12: -20% print at the deadline, the unwind sell refused on the bound, sells after the back-run. */
  exit: SandwichProof;
}

/** Everything the fork helpers need. */
export interface ForkDao { devnet: Devnet; dao: ZeroOneDao; founder: WriteContext; stranger: WriteContext }

/**
 * Start an owned Base fork, fund the founder with 50 real USDC and deploy + genesis a Zero One DAO on it.
 *
 * Args:
 *   runId: Filesystem-safe label for the fork's state directory.
 *
 * Returns:
 *   The fork, the DAO and the two contexts the scenario writes from.
 */
export async function bootForkDao(runId: string): Promise<ForkDao> {
  const devnet = await startBaseFork(runId);
  const chain = connectDevnet(devnet);
  const founder = chain.contexts[0]!;
  await fundForkUsdc(devnet, founder.account.address, 50n * SETTLEMENT_UNIT);
  const dao = await deployZeroOne(founder, { ...DEFAULT_PARAMS, founder: founder.account.address, settlement: BASE_USDC });
  for (const [name, hash] of Object.entries(dao.txHashes)) console.log(`tx deploy ${name} ${hash}`);
  const genesis = await genesisDeposit(founder, dao);
  console.log(`tx genesis ${genesis.depositHash} shares=${genesis.sharesMinted}`);
  return { devnet, dao, founder, stranger: chain.contexts[1]! };
}

/**
 * Decode the revert data viem attaches to a failed `eth_call`.
 *
 * Args:
 *   error: The thrown error.
 *
 * Returns:
 *   The raw revert data, or undefined when the error carries none.
 */
function revertData(error: unknown): Hex | undefined {
  const walk = (error as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk;
  const found = walk?.call(error, (e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | undefined;
  if (found?.data) return found.data;
  const match = /0x[0-9a-fA-F]{8,}/u.exec(error instanceof Error ? error.message : String(error));
  return match ? (match[0] as Hex) : undefined;
}

/**
 * Check the published Base Uniswap dependencies, prove the constructor refuses a pool whose observation
 * history cannot serve the window (a freshly created pool), warm the real pool's window on local time and
 * deploy the venue on the WETH/USDC 0.05% pool.
 *
 * Args:
 *   fork: The booted fork DAO.
 *
 * Returns:
 *   The venue address and its ABI.
 */
export async function deployTwapVenue(fork: ForkDao): Promise<{ address: Address; abi: Abi }> {
  const { dao, founder } = fork;
  const publicClient = founder.publicClient;
  const venueArtifact = loadLocalArtifact("UniswapV3Venue");
  const venueAbi = venueArtifact.abi;
  console.log("SOURCE https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments");
  for (const name of ["router", "quoter", "factory"] as const) {
    const address = BASE_UNISWAP[name];
    const code = await publicClient.getCode({ address });
    assert(code && code !== "0x", `published Base ${name} ${address} code bytes=${((code?.length ?? 2) - 2) / 2}`);
  }
  for (const name of ["router", "quoter"] as const) {
    assert(getAddress(await publicClient.readContract({ address: BASE_UNISWAP[name], abi: dependencyAbi, functionName: "factory" })) === BASE_UNISWAP.factory, `${name}.factory selector responds with published factory`);
    assert(getAddress(await publicClient.readContract({ address: BASE_UNISWAP[name], abi: dependencyAbi, functionName: "WETH9" })) === BASE_UNISWAP.weth, `${name}.WETH9 selector responds with Base WETH`);
  }
  assert(await publicClient.readContract({ address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "feeAmountTickSpacing", args: [500] }) === 10, "factory feeAmountTickSpacing(500)=10");
  assert(await publicClient.readContract({ address: BASE_USDC, abi: erc20, functionName: "decimals" }) === 6, "USDC decimals read through proxy = 6");

  // Refusal proof: a pool created in this block has cardinality 1 and one observation aged 0 seconds.
  const probeToken = await deployLocal(founder, "TestToken", ["Fork Probe Token", "FPT", 1_000_000n * SETTLEMENT_UNIT]);
  const created = await writeAndWait(founder, { address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "createPool", args: [BASE_USDC, probeToken.address, 500] });
  const freshPool = await publicClient.readContract({ address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "getPool", args: [BASE_USDC, probeToken.address, 500] });
  const initialized = await writeAndWait(founder, { address: freshPool, abi: poolAbi, functionName: "initialize", args: [1n << 96n] });
  console.log(`tx fresh pool create ${created.hash} initialize ${initialized.hash} pool=${freshPool}`);
  const freshSlot0 = await publicClient.readContract({ address: freshPool, abi: poolAbi, functionName: "slot0" });
  const freshObservation = await publicClient.readContract({ address: freshPool, abi: poolAbi, functionName: "observations", args: [0n] });
  const now = (await publicClient.getBlock()).timestamp;
  console.log(`ASSERT fresh pool cardinality=${freshSlot0[3]} oldest observation age=${now - BigInt(freshObservation[0])}s (< 1800)`);
  let refusal: { errorName: string; args?: readonly unknown[] } | undefined;
  try {
    await publicClient.call({ account: founder.account, data: encodeDeployData({ abi: venueAbi, bytecode: venueArtifact.bytecode, args: [dao.safe, BASE_USDC, probeToken.address, BASE_UNISWAP.router, BASE_UNISWAP.quoter, BASE_UNISWAP.factory, 500] }) });
  } catch (error) {
    const data = revertData(error);
    refusal = data ? decodeErrorResult({ abi: venueAbi, data }) : { errorName: `undecodable: ${error instanceof Error ? error.message : String(error)}` };
  }
  assert(refusal?.errorName === "WindowUnavailable" && refusal.args?.[0] === 1 && (refusal.args?.[1] as number) < 1800, `constructor refuses the fresh pool: WindowUnavailable(cardinality=${String(refusal?.args?.[0])}, oldestObservationAge=${String(refusal?.args?.[1])})`);

  // The real pool: show its stored history and warm the window on local time only, so the 30-minute TWAP is
  // deterministic (the fork's last 30 upstream minutes may sit further than slippageBps from spot).
  const pool = await publicClient.readContract({ address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "getPool", args: [BASE_USDC, BASE_UNISWAP.weth, 500] });
  const slot0 = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
  const oldestIndex = (BigInt(slot0[2]) + 1n) % BigInt(slot0[3]);
  let oldest = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observations", args: [oldestIndex] });
  if (!oldest[3]) oldest = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observations", args: [0n] });
  console.log(`ASSERT real fork pool=${pool} slot0=${JSON.stringify(slot0, (_, value) => typeof value === "bigint" ? value.toString() : value)} oldest observation age=${(await publicClient.getBlock()).timestamp - BigInt(oldest[0])}s cardinality=${slot0[3]}`);
  try {
    await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[1800, 0]] });
    console.log("ASSERT upstream pool already serves observe([1800,0])");
  } catch (error) {
    console.log(`OBSERVATION HISTORY REFUSAL: ${error instanceof Error ? error.message : String(error)}`);
  }
  await increaseTime(founder, 1801);
  const observations = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[1800, 0]] });
  console.log(`ASSERT real observe([1800,0]) after local 1801s warm-up=${observations[0].join(",")}`);
  const venue = await deployLocal(founder, "UniswapV3Venue", [dao.safe, BASE_USDC, BASE_UNISWAP.weth, BASE_UNISWAP.router, BASE_UNISWAP.quoter, BASE_UNISWAP.factory, 500]);
  console.log(`tx UniswapV3Venue deploy ${venue.hash} address=${venue.address}`);
  assert(!venueAbi.some((f) => f.type === "function" && ["owner", "transferOwnership", "setFee", "admin"].includes(f.name)), "venue ABI has no owner/admin or mutable fee setter");
  assert(await publicClient.readContract({ address: venue.address, abi: venueAbi, functionName: "assetUnit" }) === 10n ** 18n, "WETH accounting uses 18 decimals");
  assert(await publicClient.readContract({ address: venue.address, abi: venueAbi, functionName: "TWAP_WINDOW" }) === 1800, "TWAP_WINDOW = 1800 s");
  return { address: venue.address, abi: venueAbi };
}

/** Write / vote / decode helpers bound to one fork DAO and one venue. */
function harness(fork: ForkDao, venueAddress: Address, venueAbi: Abi) {
  const { dao, founder, stranger } = fork;
  const publicClient = founder.publicClient;
  const strategyAbi = loadLocalArtifact("StrategyProposal").abi;
  const baalAbi = loadBaalArtifact("Baal").abi;
  const ledgerAbi = loadLocalArtifact("TreasuryLedger").abi;
  const shamanAbi = loadLocalArtifact("DepositShaman").abi;
  const balance = (token: Address, account: Address) => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account] });
  const ledgerRead = <T>(functionName: string, args: readonly unknown[] = []) => publicClient.readContract({ address: dao.treasuryLedger, abi: ledgerAbi, functionName, args }) as Promise<T>;
  /** Venue `Swapped` events inside one receipt, each asserted to have filled within its minimum. */
  function swapsIn(receipt: { logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }): VenueSwap[] {
    const swaps: VenueSwap[] = [];
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(venueAddress)) continue;
      const decoded = decodeEventLog({ abi: venueAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName !== "Swapped") continue;
      const event = decoded.args as unknown as VenueSwap;
      assert(event.amountOut >= event.minimum && event.amountOut > 0n, `swap bounded amountIn=${event.amountIn} quoted=${event.quoted} minimum=${event.minimum} actual=${event.amountOut}`);
      swaps.push(event);
    }
    return swaps;
  }
  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], label: string, other = false, value?: bigint) {
    const context = other ? stranger : founder;
    const simulation = await publicClient.simulateContract({ account: context.account, address, abi, functionName, args, ...(value === undefined ? {} : { value }) });
    const result = await writeAndWait(context, { ...simulation.request, ...(functionName === "run" ? { gas: 2_000_000n } : {}) } as unknown as Record<string, unknown>);
    console.log(`tx ${label} ${result.hash} block=${result.receipt.blockNumber} gas=${result.receipt.gasUsed}`);
    swapsIn(result.receipt);
    return result;
  }
  async function pass(proposal: { id: number; data: `0x${string}`; submitHash: `0x${string}` }) {
    console.log(`tx proposal #${proposal.id} submit ${proposal.submitHash}`);
    await increaseTime(founder, 2);
    await send(dao.baal, baalAbi, "submitVote", [proposal.id, true], `vote #${proposal.id}`);
    const raw = await publicClient.readContract({ address: dao.baal, abi: baalAbi, functionName: "proposals", args: [proposal.id] }) as readonly unknown[];
    const now = (await publicClient.getBlock()).timestamp;
    await increaseTime(founder, Number(BigInt(raw[4] as number) - now + 1n));
    const result = await writeAndWait(founder, { address: dao.baal, abi: baalAbi, functionName: "processProposal", args: [proposal.id, proposal.data], gas: 5_000_000n });
    console.log(`tx execute #${proposal.id} ${result.hash} block=${result.receipt.blockNumber}`);
    const status = await publicClient.readContract({ address: dao.baal, abi: baalAbi, functionName: "getProposalStatus", args: [proposal.id] }) as readonly boolean[];
    assert(status[1] && status[2] && !status[3], `proposal #${proposal.id} processed passed=true actionFailed=false`);
    return result;
  }
  async function manage(calls: PackedCall[], label: string) {
    const result = await pass(await submitCalls(founder, dao, calls, `K: ${label}`));
    return swapsIn(result.receipt);
  }
  async function start(params: StrategyParams, label: string) {
    const proposal = await submitTemplateProposal(founder, dao, { template: "Strategy", params }, `K: ${label}`);
    if (proposal.instance.deployHash) console.log(`tx Strategy deploy ${proposal.instance.deployHash} address=${proposal.instance.address}`);
    await pass(proposal);
    return proposal.instance.address;
  }
  async function emptyVenue() {
    assert(await balance(BASE_USDC, venueAddress) === 0n && await balance(BASE_UNISWAP.weth, venueAddress) === 0n, "adapter holds zero USDC and zero WETH between runs");
    for (const token of [BASE_USDC, BASE_UNISWAP.weth]) assert(await publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [venueAddress, BASE_UNISWAP.router] }) === 0n, `router allowance ${token}=0`);
  }
  async function depositsRefused(label: string) {
    await expectRevert(publicClient.simulateContract({ address: dao.depositShaman, abi: shamanAbi, functionName: "quote", args: [SETTLEMENT_UNIT], account: stranger.account } as never), "TreasuryNotSettled", label);
  }
  return { publicClient, strategyAbi, baalAbi, balance, ledgerRead, swapsIn, send, pass, manage, start, emptyVenue, depositsRefused };
}

/**
 * Run the three sandwiches against fresh Strategy instances on the venue and return their reports.
 *
 * Args:
 *   fork: The booted fork DAO.
 *   venue: The deployed UniswapV3Venue (address + ABI).
 *
 * Returns:
 *   The entry (T-4), print (T-5) and exit (T-5 deadline) proofs.
 */
export async function proveSandwiches(fork: ForkDao, venue: { address: Address; abi: Abi }): Promise<SandwichProofs> {
  const { dao, founder } = fork;
  const h = harness(fork, venue.address, venue.abi);
  const publicClient = h.publicClient;
  const rpc = publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  const probe = await deployLocal(founder, "TwapSandwichProbe", [venue.address]);
  console.log(`tx TwapSandwichProbe deploy ${probe.hash} address=${probe.address}`);
  await rpc({ method: "anvil_setBalance", params: [founder.account.address, `0x${(SANDWICH_ETH * 2n).toString(16)}`] });
  await h.send(probe.address, probe.artifact.abi, "wrap", [], `probe wraps ${SANDWICH_ETH / 10n ** 18n} ETH into WETH (fork ether)`, false, SANDWICH_ETH);
  let whale: Address | undefined;
  for (const candidate of FORK_USDC_WHALES) {
    const held = await h.balance(BASE_USDC, candidate);
    console.log(`   USDC holder candidate ${candidate} balance=${held}`);
    if (held >= SANDWICH_USDC) { whale = candidate; break; }
  }
  assert(whale !== undefined, `a Base USDC holder with >= ${SANDWICH_USDC} base units exists on the fork`);
  await fundForkUsdc(fork.devnet, probe.address, SANDWICH_USDC, whale);
  const pool = await publicClient.readContract({ address: venue.address, abi: venue.abi, functionName: "pool" }) as Address;
  const sqrtNow = async () => (await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }))[0];
  const bps = (sqrt: bigint, base: bigint) => (sqrt * sqrt * 10_000n) / (base * base) - 10_000n;

  async function sandwich(strategy: Address, zeroForOne: boolean, expectRefusal: boolean, label: string): Promise<SandwichProof> {
    const sqrt0 = await sqrtNow();
    // Price limits for a 25% move: sqrt(1.25) = 1.118034, sqrt(0.75) = 0.866025 (the pool stops at the limit).
    const limit = zeroForOne ? (sqrt0 * 866_025n) / 1_000_000n : (sqrt0 * 1_118_034n) / 1_000_000n;
    const result = await h.send(probe.address, probe.artifact.abi, "sandwich", [strategy, zeroForOne, limit, expectRefusal], label);
    let report: SandwichReport | undefined;
    for (const log of result.receipt.logs) {
      if (getAddress(log.address) !== getAddress(probe.address)) continue;
      const decoded = decodeEventLog({ abi: probe.artifact.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "Sandwiched") report = (decoded.args as unknown as { report: SandwichReport }).report;
    }
    assert(report !== undefined, "probe emitted Sandwiched");
    const proof: SandwichProof = {
      strategy, hash: result.hash, gas: result.receipt.gasUsed, report, swaps: h.swapsIn(result.receipt),
      statusAfter: (await describe(founder, strategy)).status,
      wethAfter: await h.balance(BASE_UNISWAP.weth, strategy), usdcAfter: await h.balance(BASE_USDC, strategy),
      spotMoveBps: bps(report.sqrtDuring, report.sqrtBefore), restoredMoveBps: bps(report.sqrtAfter, report.sqrtBefore),
    };
    console.log(`   sandwich ${label}: spot ${proof.spotMoveBps} bps during the print, ${proof.restoredMoveBps} bps after the back-run; price() ${report.priceBefore} -> ${report.priceDuring}; value() ${report.valueBefore} -> ${report.valueDuring}; moved=${report.moved} received=${report.received}` +
      (expectRefusal ? `; refused output=${report.refusedOutput} < minimum=${report.refusedMinimum}` : "") + `; strategy ${proof.statusAfter} weth=${proof.wethAfter} usdc=${proof.usdcAfter}`);
    assert(zeroForOne ? proof.spotMoveBps <= -SANDWICH_MOVE_BPS : proof.spotMoveBps >= SANDWICH_MOVE_BPS, `same-block spot print moved the pool by more than 20% (${proof.spotMoveBps} bps)`);
    assert(report.priceDuring === report.priceBefore && report.valueDuring === report.valueBefore, "price() (30-min TWAP) and value() are unchanged by the print (checked inside the transaction)");
    assert(proof.restoredMoveBps > -50n && proof.restoredMoveBps < 50n, `back-run restored the spot to within 50 bps (${proof.restoredMoveBps} bps)`);
    await h.emptyVenue();
    return proof;
  }

  const deadline = (await publicClient.getBlock()).timestamp + 30n * 86400n;
  const rule = { maxPerRun: 2n * SETTLEMENT_UNIT, minInterval: 0n, deadline, takeProfitBps: 0n, stopLossBps: 0n, slippageBps: 50n };

  // T-4: DCA buy during a +25% print is refused; after the back-run the same run fills within the bound.
  const entryStrategy = await h.start({ venue: venue.address, asset: BASE_UNISWAP.weth, budget: 20n * SETTLEMENT_UNIT, rule }, "T-4 victim: DCA 2 USDC per run, slippage 50 bps");
  const entry = await sandwich(entryStrategy, false, true, "T-4 entry sandwich (+25% WETH print, victim DCA buy)");
  assert(entry.report.refusedOutput < entry.report.refusedMinimum && entry.swaps.length === 1 && entry.statusAfter === "Running" && entry.wethAfter === entry.swaps[0]!.amountOut && entry.usdcAfter === 18n * SETTLEMENT_UNIT, `T-4: the run during the print was refused (would have received ${entry.report.refusedOutput} wei WETH, bound ${entry.report.refusedMinimum}); after restoration the run filled ${entry.swaps[0]?.amountOut} wei WETH for 2 USDC`);

  // T-5: a -25% print with a 25% stop-loss does not fire the unwind: value() is the TWAP value; the run buys instead.
  const printStrategy = await h.start({ venue: venue.address, asset: BASE_UNISWAP.weth, budget: 10n * SETTLEMENT_UNIT, rule: { ...rule, maxPerRun: 5n * SETTLEMENT_UNIT, stopLossBps: 2_500n } }, "T-5 victim: 10 USDC, stop-loss 25%");
  await h.send(printStrategy, h.strategyAbi, "run", [], "T-5 victim buys its first 5 USDC of WETH at the fair price", true);
  const wethBeforePrint = await h.balance(BASE_UNISWAP.weth, printStrategy);
  const print = await sandwich(printStrategy, true, false, "T-5 print sandwich (-25% WETH print, attacker calls run())");
  assert(print.statusAfter === "Running" && print.swaps.length === 1 && print.wethAfter > wethBeforePrint && print.usdcAfter === 0n, `T-5: the stop-loss did not fire on the print (value ${print.report.valueBefore} unchanged); the run bought ${print.swaps[0]?.amountOut} wei WETH at the attacker's cheap spot and the strategy stays Running`);

  // T-5 / T-12: the deadline unwind (a sell) during a -25% print is refused on the bound; after the back-run it sells.
  const exitDeadline = (await publicClient.getBlock()).timestamp + 2n * 86400n;
  const exitStrategy = await h.start({ venue: venue.address, asset: BASE_UNISWAP.weth, budget: 5n * SETTLEMENT_UNIT, rule: { ...rule, maxPerRun: 5n * SETTLEMENT_UNIT, deadline: exitDeadline } }, "T-5 exit victim: 5 USDC, deadline in 2 days");
  await h.send(exitStrategy, h.strategyAbi, "run", [], "T-5 exit victim buys 5 USDC of WETH", true);
  await increaseTime(founder, 2 * 86400 + 1);
  const safeBefore = await h.balance(BASE_USDC, dao.safe);
  const exit = await sandwich(exitStrategy, true, true, "T-5 exit sandwich (-25% WETH print, victim deadline unwind)");
  const safeAfter = await h.balance(BASE_USDC, dao.safe);
  assert(exit.report.refusedOutput < exit.report.refusedMinimum && exit.swaps.length === 1 && exit.statusAfter === "Complete" && exit.wethAfter === 0n && exit.usdcAfter === 0n && safeAfter - safeBefore === exit.swaps[0]!.amountOut, `T-5: the deadline sell during the print was refused (would have received ${exit.report.refusedOutput} USDC units, bound ${exit.report.refusedMinimum}); after restoration it sold for ${exit.swaps[0]?.amountOut} USDC units to the Safe`);
  return { entry, print, exit };
}

/**
 * The full scenario on an already booted fork DAO: venue deployment, bounded buys, voted stop + unwind, voted
 * migration, take-profit, stop-loss, sweep, then the three sandwiches.
 *
 * Args:
 *   fork: The booted fork DAO (deploy + genesis may already have been proven on the same fork).
 */
export async function runUniswapFork(fork: ForkDao): Promise<void> {
  const { dao, founder } = fork;
  await assertBaseFork(fork.devnet.rpcUrl);
  assert(getAddress(dao.settlement) === getAddress(BASE_USDC), "K settlement is real Base USDC proxy");
  const venue = await deployTwapVenue(fork);
  const h = harness(fork, venue.address, venue.abi);
  const { balance, ledgerRead, send, manage, start, emptyVenue, depositsRefused, strategyAbi, publicClient } = h;
  const deadline = (await publicClient.getBlock()).timestamp + 30n * 86400n;
  const params: StrategyParams = { venue: venue.address, asset: BASE_UNISWAP.weth, budget: 20n * SETTLEMENT_UNIT,
    rule: { maxPerRun: 2n * SETTLEMENT_UNIT, minInterval: 0n, deadline, takeProfitBps: 2500n, stopLossBps: 5000n, slippageBps: 50n } };

  const first = await start(params, "USDC -> WETH with voted slippage, take-profit, stop-loss");
  assert(await ledgerRead<boolean>("isOpen", [first]) && await ledgerRead<boolean>("settled"), "started Strategy is open in the ledger; USDC-only holdings keep the treasury settled");
  await send(first, strategyAbi, "run", [], "stranger run #1", true); await emptyVenue();
  const weth1 = await balance(BASE_UNISWAP.weth, first);
  await send(first, strategyAbi, "run", [], "stranger run #2", true); await emptyVenue();
  const weth2 = await balance(BASE_UNISWAP.weth, first);
  assert(weth1 > 0n && weth2 > weth1 && await balance(BASE_USDC, first) === 16n * SETTLEMENT_UNIT, "two exact 2 USDC swaps acquired WETH; raw holdings remain in Strategy");
  assert(!await ledgerRead<boolean>("settled"), "the open instance's WETH keeps the treasury unsettled");
  await depositsRefused("deposits are refused while the running Strategy holds WETH");
  const safeUsdc = await balance(BASE_USDC, dao.safe), safeWeth = await balance(BASE_UNISWAP.weth, dao.safe);
  await manage(stopCalls(first), "stop returns raw USDC, keeps WETH inside");
  assert(await balance(BASE_USDC, first) === 0n && await balance(BASE_UNISWAP.weth, first) === weth2, "stopped instance holds no USDC and all of its WETH");
  assert(await balance(BASE_USDC, dao.safe) === safeUsdc + 16n * SETTLEMENT_UNIT && await balance(BASE_UNISWAP.weth, dao.safe) === safeWeth, "stop returned exact raw USDC to the Safe and no WETH (phase 5 ruling 4b)");
  assert((await describe(founder, first)).status === "Stopped" && await ledgerRead<boolean>("isOpen", [first]) && !await ledgerRead<boolean>("settled"), "stopped instance stays open in the ledger; treasury unsettled");
  await depositsRefused("deposits stay refused while the stopped Strategy holds WETH");
  const unwindSwaps = await manage(unwindCalls(first), "unwind sells the stopped instance's WETH through the real router");
  assert(unwindSwaps.length === 1 && unwindSwaps[0]!.amountIn === weth2 && await balance(BASE_USDC, dao.safe) === safeUsdc + 16n * SETTLEMENT_UNIT + unwindSwaps[0]!.amountOut, `voted unwind sold ${weth2} wei WETH for ${unwindSwaps[0]?.amountOut} USDC units, proceeds in the Safe`);
  assert(await balance(BASE_USDC, first) === 0n && await balance(BASE_UNISWAP.weth, first) === 0n && !await ledgerRead<boolean>("isOpen", [first]) && await ledgerRead<boolean>("settled"), "unwound instance is empty and closed; treasury settled; deposits reopen");
  await emptyVenue();

  const old = await start(params, "old Strategy for migration");
  await send(old, strategyAbi, "run", [], "old Strategy run before migration", true);
  const migrationUsdc = await balance(BASE_USDC, old), migrationWeth = await balance(BASE_UNISWAP.weth, old);
  const next = await deployTemplate(founder, dao, { template: "Strategy", params });
  console.log(`tx successor deploy ${next.deployHash} address=${next.address}`);
  await manage(migrateCalls(old, next.address), "migrate raw holdings then start successor");
  assert((await describe(founder, old)).status === "Migrated" && (await describe(founder, next.address)).status === "Running", "old Migrated; successor Running");
  assert(await balance(BASE_USDC, old) === 0n && await balance(BASE_UNISWAP.weth, old) === 0n, "migrated instance empty");
  assert(await balance(BASE_USDC, next.address) === migrationUsdc && await balance(BASE_UNISWAP.weth, next.address) === migrationWeth, "migration preserved both raw token quantities");
  assert(!await ledgerRead<boolean>("isOpen", [old]) && await ledgerRead<boolean>("isOpen", [next.address]), "ledger: old closed by migrate, successor opened by start");
  await send(next.address, strategyAbi, "run", [], "successor runs on migrated holdings", true); await emptyVenue();
  // Voted proceeds fixture makes the take-profit predicate true without changing pool state.
  await manage([{ to: BASE_USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [next.address, 6n * SETTLEMENT_UNIT] }) }], "send strategy proceeds fixture");
  await send(next.address, strategyAbi, "run", [], "take-profit unwinds WETH through real router", true); await emptyVenue();
  assert((await describe(founder, next.address)).status === "Complete" && await balance(BASE_USDC, next.address) === 0n && await balance(BASE_UNISWAP.weth, next.address) === 0n, "take-profit sold WETH and returned all proceeds to Safe");
  // Pool fee is 5 bps: full-budget entry loses >1 bp at spot, exercising the stop-loss sell.
  const loss = await start({ ...params, budget: 5n * SETTLEMENT_UNIT, rule: { ...params.rule, maxPerRun: 5n * SETTLEMENT_UNIT, stopLossBps: 1n } }, "stop-loss fixture");
  await send(loss, strategyAbi, "run", [], "stop-loss fixture entry", true);
  await send(loss, strategyAbi, "run", [], "stop-loss unwinds through real router", true); await emptyVenue();
  assert((await describe(founder, loss)).status === "Complete" && await balance(BASE_USDC, loss) === 0n && await balance(BASE_UNISWAP.weth, loss) === 0n, "1 bp stop-loss fired after 5 bp pool-fee entry; instance empty");
  assert(await ledgerRead<boolean>("settled"), "every instance closed: treasury settled");
  const beforeDust = await balance(BASE_USDC, dao.safe);
  await manage([{ to: BASE_USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [venue.address, 1n] }) }], "unsolicited adapter dust fixture");
  await send(venue.address, venue.abi, "sweep", [], "stranger sweeps dust only to immutable Safe", true);
  assert(await balance(BASE_USDC, dao.safe) === beforeDust, "permissionless sweep returns exact dust to Safe"); await emptyVenue();

  await proveSandwiches(fork, venue);
  console.log("=== SCENARIO K: PASS ===");
}

export async function main(): Promise<void> {
  if (!process.env.FORK_RPC) { console.log("SCENARIO K: SKIP (FORK_RPC unset)"); return; }
  const fork = await bootForkDao(`phase5-uniswap-${Date.now()}`);
  try {
    await runUniswapFork(fork);
  } finally { await stopDevnet(fork.devnet); }
}
runIfMain(import.meta.url, main);
