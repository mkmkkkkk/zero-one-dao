/**
 * DESIGN.md §11 G: a Strategy proposal contract (mock DEX on the mirror) is voted in, funded by the
 * Safe in the voted multicall, trades by its coded rule when anyone calls run(), takes profit,
 * returns every proceed to the Safe and ends; a second Strategy voted down leaves the treasury
 * untouched and its contract holding nothing. The proposer cannot stop or top up its own contract.
 */
import { getAddress } from "viem";

import { encodeParams, predictInstance, TEMPLATE_IDS, type StrategyParams } from "../src/proposals.js";
import { assert, boot, DAY, deployMockMarket, describeAt, expectRevert, fmtS, now, processProposal, proposeTemplate, readAt, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, setPrice, shutdown, simulateAt, snapshot, stateOf, step, T, usdcOf, verdict, vote, warp, warpPastGrace } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-G");
  let passed = false;
  try {
    const seeded = await seedMembers(mirror);
    const A = mirror.actors.A.account.address;

    step("mirror venue: MOCK asset + MockDex at 2 USDC per MOCK, 100k liquidity each side");
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 100_000n * SETTLEMENT_UNIT);
    const mockOf = (address: `0x${string}`) => readAt<bigint>(mirror, market.asset, "settlement", "balanceOf", [address]);

    step("A deploys a Strategy instance (budget 500 USDC, 200 per run, 1 h interval, 7 d deadline, take-profit +20%, stop-loss -30%) and submits the fund+start proposal");
    const start = await now(mirror);
    const params: StrategyParams = {
      venue: market.dex,
      asset: market.asset,
      budget: 500n * SETTLEMENT_UNIT,
      rule: { maxPerRun: 200n * SETTLEMENT_UNIT, minInterval: BigInt(T.hour), deadline: start + BigInt(7 * DAY), takeProfitBps: 2000n, stopLossBps: 3000n },
    };
    const proposal = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "A: DCA 500 USDC into MOCK, take profit +20%");
    const s1 = proposal.instance.address;
    assert((await stateOf(mirror, proposal.id)) === "Voting", "the strategy proposal entered voting (A self-sponsored)");
    const predicted = await predictInstance(mirror.actors.A, mirror.dao, { template: "Strategy", params }, A, proposal.instance.salt);
    assert(predicted === s1, `CREATE2: factory.predict(template, params, A, salt) == the deployed instance ${s1}`);
    const again = await mirror.chain.publicClient.simulateContract({ address: mirror.dao.templateFactory, abi: mirror.abi.factory, functionName: "deploy", args: [TEMPLATE_IDS.Strategy, encodeParams({ template: "Strategy", params }), A, proposal.instance.salt], account: mirror.actors.W.account } as never);
    const [sameInstance, sameCodeHash] = again.result as unknown as [`0x${string}`, `0x${string}`];
    assert(getAddress(sameInstance) === s1 && sameCodeHash === proposal.instance.codeHash, "factory.deploy with the same (template, params, member, salt) is idempotent: same address, same code hash, no redeploy");
    const otherMember = await predictInstance(mirror.actors.A, mirror.dao, { template: "Strategy", params }, mirror.actors.B.account.address, proposal.instance.salt);
    assert(otherMember !== s1, "a different member (operator) yields a different instance address for the same params and salt");
    assert(proposal.details.includes(`"template":"Strategy"`) && proposal.details.includes(proposal.instance.codeHash) && proposal.details.includes(proposal.instance.paramsHash), "details carry template name, params hash and code hash");
    assert(proposal.calls.length === 2, "the voted multicall is exactly [Safe: USDC.transfer(instance, budget), instance.start()]");
    const pending = await describeAt(mirror, s1, "before vote");
    assert(pending.status === "Pending" && (await usdcOf(mirror, s1)) === 0n, "instance is Pending and holds nothing before the vote");
    assert(pending.operator === A && pending.budget === params.budget && pending.deadline === params.rule.deadline, "describe() reports operator A, budget 500, the deadline");

    step("A YES, B YES, C NO; grace passes; W (non-member) executes: the Safe funds the instance and starts it");
    await vote(mirror, "A", proposal.id, true);
    await vote(mirror, "B", proposal.id, true);
    await vote(mirror, "C", proposal.id, false);
    await warpPastGrace(mirror, proposal.id);
    const processed = await processProposal(mirror, "W", proposal);
    assert(processed.info.status.passed && !processed.info.status.actionFailed, "fund + start executed by the Safe");
    const funded = await snapshot(mirror, "after fund+start", ["A"]);
    assert(funded.safeSettlement === seeded.safeSettlement - params.budget, "treasury decreased by exactly the budget");
    const running = await describeAt(mirror, s1, "after start");
    assert(running.status === "Running" && (await usdcOf(mirror, s1)) === params.budget, "instance is Running and holds exactly the budget");

    step("negative: the proposer (and anyone else) cannot stop / topUp / amend / migrate; only the Safe can");
    await expectRevert(simulateAt(mirror, "A", s1, "proposal", "stop", []), "OnlySafe", "A (proposer) cannot stop()");
    await expectRevert(simulateAt(mirror, "A", s1, "proposal", "topUp", [1n]), "OnlySafe", "A (proposer) cannot topUp()");
    await expectRevert(simulateAt(mirror, "B", s1, "proposal", "migrate", [s1]), "OnlySafe", "B cannot migrate()");
    await expectRevert(simulateAt(mirror, "A", s1, "proposal", "start", []), "OnlySafe", "A cannot start() again");

    step("run #1 by W (anyone): buys 200 USDC of MOCK at 2 -> 100 MOCK; a second run in the same hour is refused");
    await sendAt(mirror, "W", s1, "strategy", "run", [], "W run() #1");
    assert((await usdcOf(mirror, s1)) === 300n * SETTLEMENT_UNIT && (await mockOf(s1)) === 100n * SETTLEMENT_UNIT, "instance holds 300 USDC + 100 MOCK");
    await expectRevert(simulateAt(mirror, "W", s1, "strategy", "run", []), "TooSoon", "run() again within minInterval is refused");

    step("+1 h: run #2 buys another 200 USDC -> 200 MOCK total; value unchanged at 500");
    await warp(mirror, T.hour, "minInterval");
    await sendAt(mirror, "O", s1, "strategy", "run", [], "O run() #2");
    assert((await usdcOf(mirror, s1)) === 100n * SETTLEMENT_UNIT && (await mockOf(s1)) === 200n * SETTLEMENT_UNIT, "instance holds 100 USDC + 200 MOCK");
    assert((await readAt<bigint>(mirror, s1, "strategy", "value")) === 500n * SETTLEMENT_UNIT, "value = 100 + 200 x 2 = 500 USDC");

    step("price moves to 3: value 700 >= 600 (take-profit); run #3 unwinds and returns 700 USDC to the Safe; Complete");
    await setPrice(mirror, market, 3n * SETTLEMENT_UNIT);
    assert((await readAt<bigint>(mirror, s1, "strategy", "value")) === 700n * SETTLEMENT_UNIT, "value = 100 + 200 x 3 = 700 USDC");
    await warp(mirror, T.hour, "minInterval");
    const safeBefore = await usdcOf(mirror, mirror.dao.safe);
    await sendAt(mirror, "C", s1, "strategy", "run", [], "C run() #3 -> take-profit");
    const done = await describeAt(mirror, s1, "after take-profit");
    assert(done.status === "Complete", "instance is Complete");
    assert((await usdcOf(mirror, s1)) === 0n && (await mockOf(s1)) === 0n, "instance holds nothing");
    const safeAfter = await usdcOf(mirror, mirror.dao.safe);
    assert(safeAfter === safeBefore + 700n * SETTLEMENT_UNIT, `the Safe received every proceed: +${fmtS(700n * SETTLEMENT_UNIT)} USDC`);
    assert(safeAfter === seeded.safeSettlement + 200n * SETTLEMENT_UNIT, "treasury = start - 500 + 700: the 200 USDC gain belongs to all members in proportion");
    await expectRevert(simulateAt(mirror, "W", s1, "strategy", "run", []), "WrongStatus", "run() after completion is refused");

    step("a second Strategy (budget 1000) is voted down: B NO, C NO; nothing moves");
    const second = await proposeTemplate(mirror, "A", { template: "Strategy", params: { ...params, budget: 1_000n * SETTLEMENT_UNIT } }, "A: second strategy, 1000 USDC");
    await vote(mirror, "A", second.id, true);
    await vote(mirror, "B", second.id, false);
    await vote(mirror, "C", second.id, false);
    await warpPastGrace(mirror, second.id);
    assert((await stateOf(mirror, second.id)) === "Defeated", "second proposal is Defeated");
    await expectRevert(processProposal(mirror, "A", second), "!ready", "processProposal on the defeated proposal reverts");
    const rejected = await describeAt(mirror, second.instance.address, "voted down");
    assert(rejected.status === "Pending" && (await usdcOf(mirror, second.instance.address)) === 0n, "the rejected contract stays Pending and holds nothing");
    assert((await usdcOf(mirror, mirror.dao.safe)) === safeAfter, "treasury untouched by the rejected proposal");
    await expectRevert(simulateAt(mirror, "W", second.instance.address, "strategy", "run", []), "WrongStatus", "run() on a never-started contract is refused");
    passed = true;
  } finally {
    verdict("G", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
