/** Phase 5 contract acceptance on a fresh DAO; live harness permits only Base Sepolia. */
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { encodeProposalData } from '../src/baal.js';
import { settleRetention } from '../src/retention.js';
import { assert, boot, deposit, observe, processProposal, propose, ragequit, read, seedMembers, send, shutdown, sponsor, UNIT, SETTLEMENT_UNIT, vote, warp, warpPastGrace, type Proposal } from './lib.js';

async function main() {
  const m = await boot('phase5-contract-corners');
  try {
    await seedMembers(m);
    const raw = async (actor: 'A'|'B'|'W', address: Address, abi: Abi, name: string, args: readonly unknown[], success: boolean, gas = 1_000_000n) => {
      const c = m.actors[actor];
      const hash = await c.walletClient.sendTransaction({ account:c.account, chain:c.chain, to:address, data:encodeFunctionData({abi,functionName:name,args} as never), gas });
      const r = await c.publicClient.waitForTransactionReceipt({hash}); observe(m,r.blockNumber);
      console.log(`RECEIPT ${name} tx=${hash} block=${r.blockNumber} status=${r.status} gas=${r.gasUsed}`);
      assert(r.status === (success?'success':'reverted'), `${name} mined ${success?'success':'reverted'}`);
      return {hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed};
    };
    const settle = async (id: number, chunk = 128n) => { const result = await settleRetention(m.actors.W,m.dao.shares,id,chunk); observe(m,result.blockNumber); return result; };
    const p = await propose(m,'A',[],'phase5 retention: account deficit and exit-return');
    await vote(m,'A',p.id,true); await vote(m,'B',p.id,true);
    await ragequit(m,'A',1000n*UNIT); await ragequit(m,'C',100n*UNIT);
    await settle(p.id);
    const deficit = async () => (await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[p.id]))[0];
    assert(await deficit()===1100n*UNIT,'retention deficit = 1100 shares (over 34% of 3050)');
    await deposit(m,'B',1000n*SETTLEMENT_UNIT); await settle(p.id);
    assert(await deficit()===1100n*UNIT,'another account deposit cannot repair exiting accounts');
    await deposit(m,'A',1000n*SETTLEMENT_UNIT); await settle(p.id);
    assert(await deficit()===100n*UNIT,'exit 1000 and return 1000 repairs that account deficit');
    await warpPastGrace(m,p.id);
    await deposit(m,'D',SETTLEMENT_UNIT);
    const before = await read<readonly boolean[]>(m,'baal','getProposalStatus',[p.id]);
    await raw('W',m.dao.baal,m.abi.baal,'processProposal',[p.id,p.data],false,5_000_000n);
    assert(JSON.stringify(await read(m,'baal','getProposalStatus',[p.id]))===JSON.stringify(before),'unsettled retention refuses atomically; proposal flags unchanged');
    await settle(p.id,1n);
    const restored=await processProposal(m,'W',p);
    assert(restored.info.status.passed && !restored.info.status.actionFailed,'returned shares restore retention and proposal executes');

    const taskSubmit=await send(m,'A','work','submitTask',[[m.actors.B.account.address,m.actors.C.account.address],2,305n*UNIT,0,'phase5 task liability'],'task liability submission');
    const taskId=await read<bigint>(m,'work','taskCount');
    const task=await read<{proposalId:number}>(m,'work','getTask',[taskId]);
    await sponsor(m,'A',task.proposalId); await vote(m,'A',task.proposalId,true); await vote(m,'B',task.proposalId,true);
    const taskProposal:Proposal={id:task.proposalId,data:await read<Hex>(m,'work','activationData',[taskId]),submit:taskSubmit};

    const callOnlyData=encodeProposalData([{operation:1,to:m.dao.settlement,value:0n,data:encodeFunctionData({abi:m.abi.settlement,functionName:'transfer',args:[m.actors.O.account.address,SETTLEMENT_UNIT]} as never)}]);
    const delegateSubmit=await raw('A',m.dao.baal,m.abi.baal,'submitProposal',[callOnlyData,0,1_000_000n,'delegatecall must fail in MultiSendCallOnly'],true);
    const delegateId=Number(await read(m,'baal','proposalCount')); await warp(m,2);
    await vote(m,'A',delegateId,true); await vote(m,'B',delegateId,true);
    const capData=encodeProposalData([]);
    for(const gas of [8_000_001n,20_000_000n]) await raw('A',m.dao.baal,m.abi.baal,'submitProposal',[capData,0,gas,'above baalGas cap'],false);
    const capSubmit=await raw('A',m.dao.baal,m.abi.baal,'submitProposal',[capData,0,8_000_000n,'at baalGas cap'],true);
    const capId=Number(await read(m,'baal','proposalCount')); await warp(m,2); await vote(m,'A',capId,true); await vote(m,'B',capId,true);
    await warpPastGrace(m,capId);
    const activated=await processProposal(m,'W',taskProposal);
    assert(activated.info.status.passed && !activated.info.status.actionFailed,'task activated by vote');
    const liability=await read<bigint>(m,'deposit','shareLiability');
    const supply=await read<bigint>(m,'shares','totalSupply');
    const treasury=await read<bigint>(m,'deposit','depositTreasury');
    const amount=10n*SETTLEMENT_UNIT;
    const minted=await deposit(m,'D',amount);
    assert(liability===305n*UNIT && minted.sharesMinted===amount*(supply+liability)/treasury,'actual deposit prices active task share liability');
    const safeBalance=await read<bigint>(m,'settlement','balanceOf',[m.dao.safe]);
    const delegated=await processProposal(m,'W',{id:delegateId,data:callOnlyData,submit:delegateSubmit});
    assert(delegated.info.status.passed && delegated.info.status.actionFailed,'voted delegatecall refused by MultiSendCallOnly');
    assert(await read<bigint>(m,'settlement','balanceOf',[m.dao.safe])===safeBalance,'delegatecall failure leaves Safe balance unchanged');
    await settle(capId);
    await raw('W',m.dao.baal,m.abi.baal,'processProposal',[capId,capData],false,5_000_000n);
    await raw('W',m.dao.baal,m.abi.baal,'processProposal',[capId,capData],true,8_500_000n);
    const capFlags=await read<readonly boolean[]>(m,'baal','getProposalStatus',[capId]);
    assert(capFlags[1] && capFlags[2] && !capFlags[3],`cap proposal ${capSubmit.hash} processed at 8.5M gas`);
    console.log('PHASE5 CONTRACT CORNERS PASS');
  } finally { await shutdown(m); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
