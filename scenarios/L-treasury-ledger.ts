/** Phase 4: real balances, voted lifecycle and atomic deposit/ragequit on local Anvil only. */
import { decodeEventLog, encodeFunctionData, getAddress, type Abi, type Address } from "viem";
import { loadLocalAbi, type PackedCall } from "../src/baal.js";
import { deployLocal, writeAndWait } from "../src/onchain.js";
import { deployTemplate, migrateCalls, stopCalls, type StrategyParams } from "../src/proposals.js";
import { assert, boot, deposit, deployMockMarket, expectRevert, LIVE, now, processProposal, propose, proposeTemplate, read, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, setPrice, shutdown, simulate, step, verdict, vote, warpPastGrace, type Proposal } from "./lib.js";

export async function main(): Promise<void> {
  if (LIVE) throw new Error("Scenario L is restricted to an owned local Anvil");
  const mirror = await boot("scenario-L");
  let passed = false;
  try {
    await seedMembers(mirror);
    const { safe, settlement, treasuryLedger: ledger, shares, depositShaman, baal } = mirror.dao;
    const ledgerAbi = loadLocalAbi("TreasuryLedger");
    const pinned = async <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> => {
      const blockNumber = await mirror.chain.publicClient.getBlockNumber();
      return mirror.chain.publicClient.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
    };
    const ledgerRead = <T>(functionName: string, args: readonly unknown[] = []) => pinned<T>(ledger, ledgerAbi, functionName, args);
    const balance = (token: Address, holder: Address) => pinned<bigint>(token, mirror.abi.settlement, "balanceOf", [holder]);
    const active = () => ledgerRead<Address[]>("openInstances");
    const voteThrough = async (proposal: Proposal, actionFailed = false) => {
      await vote(mirror, "A", proposal.id, true);
      await vote(mirror, "B", proposal.id, true);
      await warpPastGrace(mirror, proposal.id);
      const result = await processProposal(mirror, "W", proposal);
      assert(result.info.status.passed && result.info.status.actionFailed === actionFailed, `proposal #${proposal.id}: passed=true actionFailed=${actionFailed}`);
    };
    const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[]): PackedCall => ({ to, data: encodeFunctionData({ abi, functionName, args } as never), value: 0n, operation: 0 });

    step("seed sufficient settlement for a voted 100k Strategy; record NAV from chain");
    await sendAt(mirror, "F", settlement, "settlement", "transfer", [safe, 200_000n * SETTLEMENT_UNIT], "fund Safe with additional settlement");
    const market = await deployMockMarket(mirror, 2n * SETTLEMENT_UNIT, 1_000_000n * SETTLEMENT_UNIT);
    const params: StrategyParams = { venue: market.dex, asset: market.asset, budget: 100_000n * SETTLEMENT_UNIT, rule: { maxPerRun: 10_000n * SETTLEMENT_UNIT, minInterval: 1n, deadline: (await now(mirror)) + 365n * 86400n, takeProfitBps: 0n, stopLossBps: 0n, slippageBps: 100n } };
    const probe = await deployLocal(mirror.actors.F, "LedgerProbe");
    console.log(`   LedgerProbe ${probe.address} deployment tx ${probe.hash}; TreasuryLedger ${ledger}`);
    for (const functionName of ["spoofOpen", "spoofClose"]) {
      await expectRevert(mirror.chain.publicClient.simulateContract({ address: probe.address, abi: [...probe.artifact.abi, ...ledgerAbi], functionName, args: [ledger], account: mirror.actors.F.account } as never), "UnknownInstance", `unregistered contract cannot ${functionName} despite claiming Running`);
    }
    await expectRevert(mirror.chain.publicClient.simulateContract({ address: ledger, abi: ledgerAbi, functionName: "open", account: mirror.actors.A.account } as never), "UnknownInstance", "EOA cannot open ledger");
    const spam = await deployTemplate(mirror.actors.A, mirror.dao, { template: "Strategy", params });
    const originalNav = await ledgerRead<bigint>("depositTreasury");
    await sendAt(mirror, "F", settlement, "settlement", "transfer", [spam.address, 1n], "donate one settlement unit to never-voted instance");
    assert((await active()).length === 0 && await ledgerRead<bigint>("assetCount") === 0n, "deployment alone adds no active instance and registers no asset");
    assert(await ledgerRead<bigint>("depositTreasury") === originalNav, "never-voted instance balance is excluded from deposit NAV");
    const failed = await propose(mirror, "A", [call(spam.address, mirror.abi.proposal, "start", [])], "underfunded start must roll back ledger registration");
    await voteThrough(failed, true);
    assert((await active()).length === 0 && await ledgerRead<bigint>("assetCount") === 0n, "actionFailed start rolls back active set and append-only asset registration");
    const pendingStop = await propose(mirror, "A", stopCalls(spam.address), "stop pending instance with donated settlement");
    await voteThrough(pendingStop);
    assert((await active()).length === 0, "stopping never-open instance does not corrupt active set");

    const beforeBudget = await ledgerRead<bigint>("depositTreasury");
    const supplyBeforeBudget = await balance(shares, mirror.actors.D.account.address);
    const first = await proposeTemplate(mirror, "A", { template: "Strategy", params }, "100k Strategy tests deposit treasury accounting");
    await voteThrough(first);
    const s1 = first.instance.address;
    const safeAfterBudget = await balance(settlement, safe);
    const instanceAfterBudget = await balance(settlement, s1);
    console.log(`   NAV before budget=${beforeBudget} Safe after=${safeAfterBudget} open instance=${instanceAfterBudget} ledger=${await ledgerRead<bigint>("depositTreasury")}`);
    assert(instanceAfterBudget === params.budget && safeAfterBudget + instanceAfterBudget === beforeBudget, "100k budget moved from Safe into active instance without changing total settlement");
    assert(await ledgerRead<bigint>("depositTreasury") === beforeBudget && await ledgerRead<boolean>("settled"), "ledger counts open USDC budget and permits settled deposits");
    assert((await active()).map(address => getAddress(address)).includes(getAddress(s1)), "voted Strategy is in the active set");
    const amount = 1_000n * SETTLEMENT_UNIT;
    const supply = await read<bigint>(mirror, "shares", "totalSupply");
    const minted = await deposit(mirror, "D", amount);
    assert(minted.sharesMinted === amount * supply / beforeBudget, "actual deposit mint uses ledger NAV including the 100k active budget");
    assert(minted.sharesMinted < amount * supply / safeAfterBudget && await balance(shares, mirror.actors.D.account.address) === supplyBeforeBudget + minted.sharesMinted, "receipt and balances reject the former Safe-only cheap-mint amount");

    step("two running Strategy instances share one registered asset; migrate closes old identity");
    const second = await proposeTemplate(mirror, "A", { template: "Strategy", params: { ...params, budget: 100n * SETTLEMENT_UNIT } }, "second Strategy shares registered asset");
    await voteThrough(second);
    assert((await active()).length === 2 && await ledgerRead<bigint>("assetCount") === 1n, "two active Strategies register the same asset only once");
    const migrated = await deployTemplate(mirror.actors.A, mirror.dao, { template: "Strategy", params: { ...params, budget: 100n * SETTLEMENT_UNIT } });
    await voteThrough(await propose(mirror, "A", migrateCalls(second.instance.address, migrated.address), "migrate second Strategy and start replacement"));
    const afterMigration = (await active()).map(address => getAddress(address));
    assert(afterMigration.length === 2 && !afterMigration.includes(getAddress(second.instance.address)) && afterMigration.includes(getAddress(migrated.address)), "migration removes old identity and opens voted replacement");
    await voteThrough(await propose(mirror, "A", stopCalls(migrated.address), "stop replacement while it holds only settlement"));
    assert((await active()).length === 1, "stop closes a running instance with zero asset holdings");

    step("actual buy blocks deposits while active; voted stop returns raw asset and keeps refusal");
    await sendAt(mirror, "W", s1, "strategy", "run", [], "buy asset with 10k settlement");
    const acquired = await balance(market.asset, s1);
    assert(acquired > 0n && !await ledgerRead<boolean>("settled"), "open instance asset balance makes treasury unsettled");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [amount]), "TreasuryNotSettled", "deposit refuses active asset holdings");
    await expectRevert(simulate(mirror, "D", "deposit", "quote", [amount]), "TreasuryNotSettled", "quote refuses active asset holdings");
    await voteThrough(await propose(mirror, "A", stopCalls(s1), "return Strategy raw holdings to Safe"));
    assert((await active()).length === 0 && await balance(market.asset, safe) === acquired, "stop closes active instance and returns its asset to Safe");
    assert(!await ledgerRead<boolean>("settled"), "registered asset in Safe refuses deposits even with empty active set");
    const safeBeforeRefusal = await balance(settlement, safe);
    const supplyBeforeRefusal = await read<bigint>(mirror, "shares", "totalSupply");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [amount]), "TreasuryNotSettled", "same deposit refuses asset returned by stop");
    const rejectedHash = await mirror.actors.D.walletClient.writeContract({ address: depositShaman, abi: mirror.abi.deposit, functionName: "deposit", args: [amount], account: mirror.actors.D.account, chain: mirror.actors.D.chain, gas: 500_000n } as never);
    const rejectedReceipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash: rejectedHash });
    console.log(`   actual rejected deposit tx ${rejectedHash} block ${rejectedReceipt.blockNumber} status ${rejectedReceipt.status}`);
    assert(rejectedReceipt.status === "reverted" && await balance(settlement, safe) === safeBeforeRefusal && await read<bigint>(mirror, "shares", "totalSupply") === supplyBeforeRefusal, "mined refusal changes neither Safe settlement nor share supply");

    step("Payment-style Safe vote sells returned asset at new price, restoring settled NAV");
    await setPrice(mirror, market, 3n * SETTLEMENT_UNIT);
    await voteThrough(await propose(mirror, "A", [call(market.asset, mirror.abi.settlement, "approve", [market.dex, acquired]), call(market.dex, mirror.abi.dex, "sell", [acquired, 100n])], "sell returned Strategy asset; settlement proceeds go directly to Safe"));
    const newNav = await ledgerRead<bigint>("depositTreasury");
    const sellPrice = await pinned<bigint>(market.dex, mirror.abi.dex, "price");
    const unit = await pinned<bigint>(market.dex, mirror.abi.dex, "assetUnit");
    assert(await balance(market.asset, safe) === 0n && await ledgerRead<boolean>("settled"), "voted sale clears all registered Safe asset holdings");
    assert(newNav === safeBeforeRefusal + acquired * sellPrice / unit, "new NAV comes from actual sale proceeds, not an assumed constant");
    const supplyBeforeNewDeposit = await read<bigint>(mirror, "shares", "totalSupply");
    const accepted = await deposit(mirror, "D", amount);
    assert(accepted.sharesMinted === amount * supplyBeforeNewDeposit / newNav, "same formerly-refused deposit succeeds at measured new NAV");

    step("one raw asset unit of Safe dust blocks until a sweep vote clears it");
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [safe, 1n], "one raw unit registered asset dust to Safe");
    assert(!await ledgerRead<boolean>("settled"), "one raw unit dust blocks settlement");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [amount]), "TreasuryNotSettled", "deposit refuses dust");
    await voteThrough(await propose(mirror, "A", [call(market.asset, mirror.abi.settlement, "transfer", [mirror.actors.F.account.address, 1n])], "sweep one raw unit asset dust"));
    assert(await ledgerRead<boolean>("settled"), "sweep vote restores settlement");

    step("one transaction deposits then ragequits: measured net USDC and share supply are zero");
    const atomicAmount = await ledgerRead<bigint>("depositTreasury");
    await sendAt(mirror, "F", settlement, "settlement", "transfer", [probe.address, atomicAmount], "fund local round-trip probe with exactly current treasury value");
    const probeBefore = await balance(settlement, probe.address);
    const safeBeforeAtomic = await balance(settlement, safe);
    const supplyBeforeAtomic = await read<bigint>(mirror, "shares", "totalSupply");
    const atomic = await writeAndWait(mirror.actors.W, { address: probe.address, abi: probe.artifact.abi, functionName: "roundTrip", args: [depositShaman, baal, atomicAmount] });
    const roundTrip = atomic.receipt.logs.filter(log => getAddress(log.address) === getAddress(probe.address)).map(log => decodeEventLog({ abi: probe.artifact.abi, data: log.data, topics: log.topics }))[0];
    const probeAfter = await balance(settlement, probe.address);
    console.log(`   atomic tx ${atomic.hash} block ${atomic.receipt.blockNumber} status ${atomic.receipt.status} probe before=${probeBefore} after=${probeAfter} net=${probeAfter - probeBefore}; event=${roundTrip?.eventName}`);
    assert(roundTrip?.eventName === "RoundTrip" && probeAfter === probeBefore, "same-transaction deposit plus ragequit nets exactly zero USDC (event and balances)");
    assert(await balance(settlement, safe) === safeBeforeAtomic && await read<bigint>(mirror, "shares", "totalSupply") === supplyBeforeAtomic && await balance(shares, probe.address) === 0n, "atomic round trip restores Safe balance and supply, leaving probe with zero shares");
    assert((await active()).length === 0 && await ledgerRead<boolean>("settled"), "final ledger is settled with no active instances");
    passed = true;
  } finally {
    verdict("L", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
