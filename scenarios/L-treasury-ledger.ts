/**
 * Phase 4 + 5 (decision.md phase 4 rulings, phase 5 ruling 4): the TreasuryLedger on local Anvil or Base Sepolia through the live harness.
 * Real balances, voted lifecycle and atomic deposit/ragequit: (a) a voted 100k Strategy budget keeps
 * deposit NAV unchanged (instance USDC counted); (b) while an open instance holds its asset deposits
 * revert TreasuryNotSettled, and a voted stop() keeps the asset inside the stopped instance (still open);
 * (c) a voted unwind() sells it on the venue at the rule's slippage bound, returns the proceeds to the
 * Safe and reopens deposits at the measured NAV; a stopped instance can also be migrated by vote and the
 * successor unwound; (d) 1 raw unit of a registered asset on the Safe does NOT pause deposits (NAV-07);
 * (e) deposit + ragequit in one transaction nets exactly zero.
 */
import { decodeEventLog, encodeFunctionData, getAddress, type Abi, type Address } from "viem";
import { loadLocalAbi, type PackedCall } from "../src/baal.js";
import { deployLocal, writeAndWait } from "../src/onchain.js";
import { deployTemplate, migrateCalls, stopAndUnwindCalls, stopCalls, unwindCalls, type StrategyParams } from "../src/proposals.js";
import { assert, atHead, boot, deposit, deployMockMarket, describeAt, expectRevert, LIVE, now, observe, processProposal, propose, proposeTemplate, read, runIfMain, seedMembers, sendAt, SETTLEMENT_UNIT, setPrice, shutdown, simulate, simulateAt, step, verdict, vote, warpPastGrace, type Proposal } from "./lib.js";

export async function main(): Promise<void> {
  const mirror = await boot("scenario-L");
  let passed = false;
  try {
    await seedMembers(mirror);
    const { safe, settlement, treasuryLedger: ledger, shares, depositShaman, baal } = mirror.dao;
    const ledgerAbi = loadLocalAbi("TreasuryLedger");
    const pinned = async <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> => {
      return atHead(mirror, blockNumber => mirror.chain.publicClient.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) } as never) as Promise<T>);
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

    step("actual buy blocks deposits while active; voted stop returns the raw settlement, keeps the asset inside and leaves the instance open");
    await sendAt(mirror, "W", s1, "strategy", "run", [], "buy asset with 10k settlement");
    const acquired = await balance(market.asset, s1);
    assert(acquired > 0n && !await ledgerRead<boolean>("settled"), "open instance asset balance makes treasury unsettled");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [amount]), "TreasuryNotSettled", "deposit refuses active asset holdings");
    await expectRevert(simulate(mirror, "D", "deposit", "quote", [amount]), "TreasuryNotSettled", "quote refuses active asset holdings");
    const safeBeforeStop = await balance(settlement, safe);
    const instanceSettlementBeforeStop = await balance(settlement, s1);
    await voteThrough(await propose(mirror, "A", stopCalls(s1), "stop Strategy: raw settlement back to the Safe, asset stays inside"));
    const s1Description = await describeAt(mirror, s1, "S1 after stop");
    assert(s1Description.status === "Stopped" && await balance(settlement, safe) === safeBeforeStop + instanceSettlementBeforeStop && await balance(settlement, s1) === 0n, "stop returned every settlement unit to the Safe");
    assert(await balance(market.asset, s1) === acquired && await balance(market.asset, safe) === 0n, "stop left the asset inside the stopped instance (no venue call, nothing raw on the Safe)");
    assert((await active()).map(address => getAddress(address)).includes(getAddress(s1)) && await ledgerRead<boolean>("isOpen", [s1]), "the stopped instance stays open in the ledger while it holds its asset");
    assert(!await ledgerRead<boolean>("settled"), "the stopped instance's asset keeps the treasury unsettled");
    const safeBeforeRefusal = await balance(settlement, safe);
    const supplyBeforeRefusal = await read<bigint>(mirror, "shares", "totalSupply");
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [amount]), "TreasuryNotSettled", "same deposit refuses while the stopped instance holds the asset");
    const rejectedHash = await mirror.actors.D.walletClient.writeContract({ address: depositShaman, abi: mirror.abi.deposit, functionName: "deposit", args: [amount], account: mirror.actors.D.account, chain: mirror.actors.D.chain, gas: 500_000n } as never);
    const rejectedReceipt = await mirror.chain.publicClient.waitForTransactionReceipt({ hash: rejectedHash });
    observe(mirror, rejectedReceipt.blockNumber);
    console.log(`   actual rejected deposit tx ${rejectedHash} block ${rejectedReceipt.blockNumber} status ${rejectedReceipt.status}`);
    assert(rejectedReceipt.status === "reverted" && await balance(settlement, safe) === safeBeforeRefusal && await read<bigint>(mirror, "shares", "totalSupply") === supplyBeforeRefusal, "mined refusal changes neither Safe settlement nor share supply");
    await expectRevert(simulateAt(mirror, "W", s1, "strategy", "unwind", []), "OnlySafe", "nobody but the Safe can unwind");

    step("voted unwind() sells the stopped instance's asset on the venue at the rule's slippage bound, returns the proceeds and reopens deposits at the measured NAV");
    await setPrice(mirror, market, 3n * SETTLEMENT_UNIT);
    await voteThrough(await propose(mirror, "A", unwindCalls(s1), "unwind stopped Strategy through its venue"));
    const newNav = await ledgerRead<bigint>("depositTreasury");
    const sellPrice = await pinned<bigint>(market.dex, mirror.abi.dex, "price");
    const unit = await pinned<bigint>(market.dex, mirror.abi.dex, "assetUnit");
    assert(await balance(market.asset, s1) === 0n && await balance(settlement, s1) === 0n && await balance(market.asset, safe) === 0n, "unwind sold every asset unit and left nothing inside");
    assert((await active()).length === 0 && !await ledgerRead<boolean>("isOpen", [s1]) && await ledgerRead<boolean>("settled"), "unwind closed the ledger entry; the treasury is settled");
    assert(newNav === safeBeforeRefusal + acquired * sellPrice / unit, "new NAV comes from actual sale proceeds, not an assumed constant");
    await expectRevert(mirror.chain.publicClient.simulateContract({ address: s1, abi: mirror.abi.strategy, functionName: "unwind", account: safe } as never), "NotUnwindable", "a closed instance cannot be unwound twice (simulated from the Safe)");
    const supplyBeforeNewDeposit = await read<bigint>(mirror, "shares", "totalSupply");
    const accepted = await deposit(mirror, "D", amount);
    assert(accepted.sharesMinted === amount * supplyBeforeNewDeposit / newNav, "same formerly-refused deposit succeeds at measured new NAV");

    step("the other voted way out of a stopped instance: migrate it (raw asset moves, no venue call), then stop + unwind the successor in one vote");
    const third = await proposeTemplate(mirror, "A", { template: "Strategy", params: { ...params, budget: 100n * SETTLEMENT_UNIT, rule: { ...params.rule, maxPerRun: 100n * SETTLEMENT_UNIT } } }, "third Strategy: buy, stop, migrate, unwind successor");
    await voteThrough(third);
    const s3 = third.instance.address;
    await sendAt(mirror, "W", s3, "strategy", "run", [], "S3 buys with its whole 100 budget");
    const s3Asset = await balance(market.asset, s3);
    assert(s3Asset > 0n && !await ledgerRead<boolean>("settled"), "S3 holds the asset; deposits paused");
    await voteThrough(await propose(mirror, "A", stopCalls(s3), "stop S3 while it holds only the asset"));
    assert(await ledgerRead<boolean>("isOpen", [s3]) && await balance(market.asset, s3) === s3Asset, "stopped S3 stays open holding its asset");
    const s4 = await deployTemplate(mirror.actors.A, mirror.dao, { template: "Strategy", params: { ...params, budget: 100n * SETTLEMENT_UNIT } });
    await voteThrough(await propose(mirror, "A", migrateCalls(s3, s4.address), "migrate stopped S3 -> S4 and start S4 on the migrated asset"));
    assert((await describeAt(mirror, s3, "S3")).status === "Migrated" && !await ledgerRead<boolean>("isOpen", [s3]) && await balance(market.asset, s3) === 0n, "migrate closed S3 and moved the raw asset without touching the venue");
    assert(await ledgerRead<boolean>("isOpen", [s4.address]) && await balance(market.asset, s4.address) === s3Asset && !await ledgerRead<boolean>("settled"), "S4 opened holding the migrated asset; deposits still paused");
    const safeBeforeS4 = await balance(settlement, safe);
    await voteThrough(await propose(mirror, "A", stopAndUnwindCalls(s4.address), "stop S4 and unwind it in the same vote"));
    assert((await describeAt(mirror, s4.address, "S4")).status === "Stopped" && !await ledgerRead<boolean>("isOpen", [s4.address]) && await ledgerRead<boolean>("settled"), "stop + unwind in one vote closed S4 and settled the treasury");
    assert(await balance(settlement, safe) === safeBeforeS4 + s3Asset * sellPrice / unit && await balance(market.asset, s4.address) === 0n, "the successor's asset was sold on the venue and the proceeds reached the Safe");

    step("NAV-07: one raw unit of a registered asset on the Safe does NOT pause deposits (the gate looks only at open instances)");
    await sendAt(mirror, "F", market.asset, "settlement", "transfer", [safe, 1n], "one raw unit registered asset dust to Safe");
    assert(await balance(market.asset, safe) === 1n && await ledgerRead<boolean>("registeredAsset", [market.asset]), "the Safe holds 1 raw unit of an asset the ledger has registered");
    assert(await ledgerRead<boolean>("settled"), "the treasury is still settled: Safe balances are never consulted");
    const dustNav = await ledgerRead<bigint>("depositTreasury");
    const supplyBeforeDustDeposit = await read<bigint>(mirror, "shares", "totalSupply");
    const withDust = await deposit(mirror, "D", amount);
    assert(withDust.sharesMinted === amount * supplyBeforeDustDeposit / dustNav, "a deposit succeeds with dust on the Safe, priced on settlement only (the dust is shared by exit)");

    step("one transaction deposits then ragequits: measured net USDC and share supply are zero");
    const atomicAmount = await ledgerRead<bigint>("depositTreasury");
    await sendAt(mirror, "F", settlement, "settlement", "transfer", [probe.address, atomicAmount], "fund local round-trip probe with exactly current treasury value");
    const probeBefore = await balance(settlement, probe.address);
    const safeBeforeAtomic = await balance(settlement, safe);
    const supplyBeforeAtomic = await read<bigint>(mirror, "shares", "totalSupply");
    const atomic = await writeAndWait(mirror.actors.W, { address: probe.address, abi: probe.artifact.abi, functionName: "roundTrip", args: [depositShaman, baal, atomicAmount] });
    observe(mirror, atomic.receipt.blockNumber);
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
