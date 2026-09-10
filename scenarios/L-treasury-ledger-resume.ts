/** Continue the recorded native L fixture after its test actor exhausted gas funds. */
import { decodeEventLog, getAddress, type Abi, type Address } from "viem";
import { loadLocalAbi } from "../src/baal.js";
import { writeAndWait } from "../src/onchain.js";
import { deployTemplate, migrateCalls, stopAndUnwindCalls, stopCalls, type StrategyParams } from "../src/proposals.js";
import {assert,atHead,deposit,describeAt,observe,processProposal,propose,read,sendAt,SETTLEMENT_UNIT,step,vote,warpPastGrace,type Proposal} from './lib.js';

import {readFileSync,readdirSync} from 'node:fs';
import {attach} from './phase5-resume-fixture.js';
const root='evidence/testnet/phase5';
const file=readdirSync(`${root}/scenario-daos`).filter(x=>x.startsWith('scenario-L-')).sort().at(-1)!;
const mirror=await attach(`${root}/scenario-daos/${file}`);
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


const log=readFileSync(`${root}/scenarios-L-native.log`,'utf8');
const detailLine=log.split('\n').find(l=>l.startsWith('   details: third Strategy:'))!;
const detail=JSON.parse(detailLine.slice(detailLine.indexOf('{')));
const p=detail.params;
const params:StrategyParams={venue:p.venue,asset:p.asset,budget:BigInt(p.budget),rule:{maxPerRun:BigInt(p.rule.maxPerRun),minInterval:BigInt(p.rule.minInterval),deadline:BigInt(p.rule.deadline),takeProfitBps:BigInt(p.rule.takeProfitBps),stopLossBps:BigInt(p.rule.stopLossBps),slippageBps:BigInt(p.rule.slippageBps)}};
const s3=detail.instance as Address,market={asset:p.asset as Address,dex:p.venue as Address};
const probe={address:log.match(/LedgerProbe (0x[0-9a-fA-F]{40}) deployment/)![1] as Address,artifact:{abi:loadLocalAbi('LedgerProbe')}};
const amount=1000n*SETTLEMENT_UNIT,sellPrice=await pinned<bigint>(market.dex,mirror.abi.dex,'price'),unit=await pinned<bigint>(market.dex,mirror.abi.dex,'assetUnit');
const s3Asset=await balance(market.asset,s3);
assert(await read<number>(mirror,'baal','proposalCount')===9 && s3Asset>0n && !await ledgerRead<boolean>('settled'),'resume begins after completed proposal 9 and S3 buy, before proposal 10');
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
console.log('=== SCENARIO L: PASS (original receipts plus resumed final stages) ===');
