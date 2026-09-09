/** K is opt-in: all broadcasts are to a validated loopback Base Anvil fork. */
import { decodeEventLog, encodeDeployData, encodeFunctionData, getAddress, parseAbi, type Abi, type Address } from "viem";
import { assertBaseFork, fundForkUsdc, startBaseFork } from "../src/baseFork.js";
import { loadBaalArtifact, loadLocalArtifact, type PackedCall } from "../src/baal.js";
import { stopDevnet, type Devnet } from "../src/devnet.js";
import { connectDevnet, deployLocal, increaseTime, writeAndWait } from "../src/onchain.js";
import { deployTemplate, describe, migrateCalls, stopCalls, submitCalls, submitTemplateProposal, type StrategyParams } from "../src/proposals.js";
import { BASE_USDC, DEFAULT_PARAMS, deployZeroOne, genesisDeposit, SETTLEMENT_UNIT, type ZeroOneDao } from "../src/zeroOne.js";
import { assert, runIfMain } from "./lib.js";

export const BASE_UNISWAP = {
  router: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
  quoter: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
};

/** Can follow deploy + genesis + Payment on the very same owned fork. */
export async function runUniswapFork(devnet: Devnet, dao: ZeroOneDao): Promise<void> {
  await assertBaseFork(devnet.rpcUrl);
  assert(getAddress(dao.settlement) === getAddress(BASE_USDC), "K settlement is real Base USDC proxy");
  const chain = connectDevnet(devnet);
  const founder = chain.contexts[0]!;
  const stranger = chain.contexts[1]!;
  const publicClient = chain.publicClient;
  const erc20 = parseAbi(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function allowance(address,address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
  const strategyAbi = loadLocalArtifact("StrategyProposal").abi;
  const baalAbi = loadBaalArtifact("Baal").abi;
  const venueAbi = loadLocalArtifact("UniswapV3Venue").abi;
  const balance = (token: Address, account: Address) => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account] });
  let venueAddress: Address = "0x0000000000000000000000000000000000000000";
  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], label: string, other = false) {
    const context = other ? stranger : founder;
    const simulation = await publicClient.simulateContract({ account: context.account, address, abi, functionName, args });
    const result = await writeAndWait(context, { ...simulation.request, ...(functionName === "run" ? { gas: 2_000_000n } : {}) } as unknown as Record<string, unknown>);
    console.log(`tx ${label} ${result.hash} block=${result.receipt.blockNumber} gas=${result.receipt.gasUsed}`);
    for (const log of result.receipt.logs) {
      if (getAddress(log.address) !== getAddress(venueAddress)) continue;
      const decoded = decodeEventLog({ abi: venueAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Swapped") {
        const event = decoded.args as unknown as { amountIn: bigint; quoted: bigint; minimum: bigint; amountOut: bigint };
        assert(event.amountOut >= event.minimum && event.amountOut > 0n, `swap bounded amountIn=${event.amountIn} quoted=${event.quoted} minimum=${event.minimum} actual=${event.amountOut}`);
      }
    }
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
  }
  async function manage(calls: PackedCall[], label: string) { await pass(await submitCalls(founder, dao, calls, `K: ${label}`)); }

  console.log("SOURCE https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments");
  for (const name of ["router", "quoter", "factory"] as const) {
    const address = BASE_UNISWAP[name];
    const code = await publicClient.getCode({ address });
    assert(code && code !== "0x", `published Base ${name} ${address} code bytes=${((code?.length ?? 2) - 2) / 2}`);
  }
  const dependencyAbi = parseAbi(["function factory() view returns(address)", "function WETH9() view returns(address)", "function feeAmountTickSpacing(uint24) view returns(int24)", "function getPool(address,address,uint24) view returns(address)"]);
  for (const name of ["router", "quoter"] as const) {
    assert(getAddress(await publicClient.readContract({ address: BASE_UNISWAP[name], abi: dependencyAbi, functionName: "factory" })) === BASE_UNISWAP.factory, `${name}.factory selector responds with published factory`);
    assert(getAddress(await publicClient.readContract({ address: BASE_UNISWAP[name], abi: dependencyAbi, functionName: "WETH9" })) === BASE_UNISWAP.weth, `${name}.WETH9 selector responds with Base WETH`);
  }
  assert(await publicClient.readContract({ address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "feeAmountTickSpacing", args: [500] }) === 10, "factory feeAmountTickSpacing(500)=10");
  assert(await publicClient.readContract({ address: BASE_USDC, abi: erc20, functionName: "decimals" }) === 6, "USDC decimals read through proxy = 6");
  const pool = await publicClient.readContract({ address: BASE_UNISWAP.factory, abi: dependencyAbi, functionName: "getPool", args: [BASE_USDC, BASE_UNISWAP.weth, 500] });
  const poolAbi = parseAbi(["function observe(uint32[]) view returns(int56[],uint160[])", "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"]);
  const venueArgs = [dao.safe, BASE_USDC, BASE_UNISWAP.weth, BASE_UNISWAP.router, BASE_UNISWAP.quoter, BASE_UNISWAP.factory, 500] as const;
  console.log(`ASSERT real fork pool=${pool} slot0=${JSON.stringify(await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }), (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  try {
    await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[1800, 0]] });
    console.log("ASSERT upstream pool already serves observe([1800,0])");
  } catch (error) {
    console.log(`OBSERVATION HISTORY REFUSAL: ${error instanceof Error ? error.message : String(error)}`);
    const artifact = loadLocalArtifact("UniswapV3Venue");
    let refused = false;
    try { await publicClient.call({ account: founder.account, data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: venueArgs }) }); }
    catch (failure) { refused = true; console.log(`ASSERT constructor refuses unavailable window: ${failure instanceof Error ? failure.message : String(failure)}`); }
    assert(refused, "constructor refuses the real pool with insufficient observation history");
  }
  // Advance only local fork time: the actual V3 oracle accumulates its unchanged tick for a full window.
  await increaseTime(founder, 1801);
  const observations = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[1800, 0]] });
  console.log(`ASSERT real observe([1800,0]) after local 1801s warm-up=${observations[0].join(",")}`);
  const venue = await deployLocal(founder, "UniswapV3Venue", [dao.safe, BASE_USDC, BASE_UNISWAP.weth, BASE_UNISWAP.router, BASE_UNISWAP.quoter, BASE_UNISWAP.factory, 500]);
  venueAddress = venue.address;
  console.log(`tx UniswapV3Venue deploy ${venue.hash} address=${venue.address}`);
  assert(!venueAbi.some((f) => f.type === "function" && ["owner", "transferOwnership", "setFee", "admin"].includes(f.name)), "venue ABI has no owner/admin or mutable fee setter");
  assert(await publicClient.readContract({ address: venue.address, abi: venueAbi, functionName: "assetUnit" }) === 10n ** 18n, "WETH accounting uses 18 decimals");
  async function emptyVenue() {
    assert(await balance(BASE_USDC, venue.address) === 0n && await balance(BASE_UNISWAP.weth, venue.address) === 0n, "adapter holds zero USDC and zero WETH between runs");
    for (const token of [BASE_USDC, BASE_UNISWAP.weth]) assert(await publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [venue.address, BASE_UNISWAP.router] }) === 0n, `router allowance ${token}=0`);
  }
  const deadline = (await publicClient.getBlock()).timestamp + 30n * 86400n;
  const params: StrategyParams = { venue: venue.address, asset: BASE_UNISWAP.weth, budget: 20n * SETTLEMENT_UNIT,
    rule: { maxPerRun: 2n * SETTLEMENT_UNIT, minInterval: 0n, deadline, takeProfitBps: 2500n, stopLossBps: 5000n, slippageBps: 50n } };
  async function start(next = params) {
    const proposal = await submitTemplateProposal(founder, dao, { template: "Strategy", params: next }, "K: USDC -> WETH with voted slippage, take-profit, stop-loss");
    if (proposal.instance.deployHash) console.log(`tx Strategy deploy ${proposal.instance.deployHash} address=${proposal.instance.address}`);
    await pass(proposal);
    return proposal.instance.address;
  }
  const first = await start();
  await send(first, strategyAbi, "run", [], "stranger run #1", true); await emptyVenue();
  const weth1 = await balance(BASE_UNISWAP.weth, first);
  await send(first, strategyAbi, "run", [], "stranger run #2", true); await emptyVenue();
  const weth2 = await balance(BASE_UNISWAP.weth, first);
  assert(weth1 > 0n && weth2 > weth1 && await balance(BASE_USDC, first) === 16n * SETTLEMENT_UNIT, "two exact 2 USDC swaps acquired WETH; raw holdings remain in Strategy");
  const safeUsdc = await balance(BASE_USDC, dao.safe), safeWeth = await balance(BASE_UNISWAP.weth, dao.safe);
  await manage(stopCalls(first), "stop returns raw holdings");
  assert(await balance(BASE_USDC, first) === 0n && await balance(BASE_UNISWAP.weth, first) === 0n, "stopped instance empty");
  assert(await balance(BASE_USDC, dao.safe) === safeUsdc + 16n * SETTLEMENT_UNIT && await balance(BASE_UNISWAP.weth, dao.safe) === safeWeth + weth2, "stop returned exact raw USDC + WETH to Safe");
  const old = await start();
  await send(old, strategyAbi, "run", [], "old Strategy run before migration", true);
  const migrationUsdc = await balance(BASE_USDC, old), migrationWeth = await balance(BASE_UNISWAP.weth, old);
  const next = await deployTemplate(founder, dao, { template: "Strategy", params });
  console.log(`tx successor deploy ${next.deployHash} address=${next.address}`);
  await manage(migrateCalls(old, next.address), "migrate raw holdings then start successor");
  assert((await describe(founder, old)).status === "Migrated" && (await describe(founder, next.address)).status === "Running", "old Migrated; successor Running");
  assert(await balance(BASE_USDC, old) === 0n && await balance(BASE_UNISWAP.weth, old) === 0n, "migrated instance empty");
  assert(await balance(BASE_USDC, next.address) === migrationUsdc && await balance(BASE_UNISWAP.weth, next.address) === migrationWeth, "migration preserved both raw token quantities");
  await send(next.address, strategyAbi, "run", [], "successor runs on migrated holdings", true); await emptyVenue();
  // Voted proceeds fixture makes the take-profit predicate true without changing pool state.
  await manage([{ to: BASE_USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [next.address, 6n * SETTLEMENT_UNIT] }) }], "send strategy proceeds fixture");
  await send(next.address, strategyAbi, "run", [], "take-profit unwinds WETH through real router", true); await emptyVenue();
  assert((await describe(founder, next.address)).status === "Complete" && await balance(BASE_USDC, next.address) === 0n && await balance(BASE_UNISWAP.weth, next.address) === 0n, "take-profit sold WETH and returned all proceeds to Safe");
  // Pool fee is 5 bps: full-budget entry loses >1 bp at spot, exercising the stop-loss sell.
  const loss = await start({ ...params, budget: 5n * SETTLEMENT_UNIT, rule: { ...params.rule, maxPerRun: 5n * SETTLEMENT_UNIT, stopLossBps: 1n } });
  await send(loss, strategyAbi, "run", [], "stop-loss fixture entry", true);
  await send(loss, strategyAbi, "run", [], "stop-loss unwinds through real router", true); await emptyVenue();
  assert((await describe(founder, loss)).status === "Complete" && await balance(BASE_USDC, loss) === 0n && await balance(BASE_UNISWAP.weth, loss) === 0n, "1 bp stop-loss fired after 5 bp pool-fee entry; instance empty");
  const beforeDust = await balance(BASE_USDC, dao.safe);
  await manage([{ to: BASE_USDC, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [venue.address, 1n] }) }], "unsolicited adapter dust fixture");
  await send(venue.address, venueAbi, "sweep", [], "stranger sweeps dust only to immutable Safe", true);
  assert(await balance(BASE_USDC, dao.safe) === beforeDust, "permissionless sweep returns exact dust to Safe"); await emptyVenue();
  console.log("=== SCENARIO K: PASS ===");
}

export async function main(): Promise<void> {
  if (!process.env.FORK_RPC) { console.log("SCENARIO K: SKIP (FORK_RPC unset)"); return; }
  const devnet = await startBaseFork(`phase3-uniswap-${Date.now()}`);
  try {
    const founder = connectDevnet(devnet).contexts[0]!;
    await fundForkUsdc(devnet, founder.account.address, 50n * SETTLEMENT_UNIT);
    const dao = await deployZeroOne(founder, { ...DEFAULT_PARAMS, founder: founder.account.address, settlement: BASE_USDC });
    for (const [name, hash] of Object.entries(dao.txHashes)) console.log(`tx deploy ${name} ${hash}`);
    const genesis = await genesisDeposit(founder, dao);
    console.log(`tx genesis ${genesis.depositHash} shares=${genesis.sharesMinted}`);
    await runUniswapFork(devnet, dao);
  } finally { await stopDevnet(devnet); }
}
runIfMain(import.meta.url, main);
