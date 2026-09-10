/** Real permissionless deposits; immutable-transition replay, atomic refusal and 5,000-record liveness. */
import { boot, shutdown, fund, deposit, vote, warp, warpPastGrace, read, UNIT, SETTLEMENT_UNIT, transferCall } from '../../../scenarios/lib.js';
import { encodeProposalData } from '../../../src/baal.js';
import { settleRetention } from '../../../src/retention.js';
import { deployHelper, runCalls, approveCall, depositCall, writeWithGas } from './audit-lib.js';
import { installVariant } from './retention/variants.js';
if (process.env.ZERO_ONE_LIVE_DEPLOYMENT || process.env.FORK_RPC) throw new Error('owned nonfork Anvil only');
function check(x: unknown, label: string): asserts x { if (!x) throw new Error(label); }
async function main() {
 const m = await boot('incremental');
 try {
  if (process.argv.includes('--legacy')) await installVariant(m, 'legacy');
  const rpc = (method: string, params: unknown[] = []) => m.chain.publicClient.request({ method, params } as never) as Promise<any>;
  const send = async (actor: 'A'|'B'|'W', target: 'shares'|'baal'|'deposit'|'settlement', name: string, args: unknown[], ok = true) => {
   const address = target==='shares'?m.dao.shares:target==='baal'?m.dao.baal:target==='deposit'?m.dao.depositShaman:m.dao.settlement;
   const r = await writeWithGas(m.actors[actor], address, m.abi[target], name, args, 9_000_000n);
   check(r.status === (ok?'success':'reverted'), `${name}: expected ${ok?'success':'reverted'}, got ${r.status}`); return r;
  };
  await fund(m,'A',1000n*SETTLEMENT_UNIT); await fund(m,'B',1000n*SETTLEMENT_UNIT);
  await deposit(m,'A',100n*SETTLEMENT_UNIT); await warp(m,2);
  // Initialize balance-history and totalBurned storage before both gas comparisons.
  await send('A','baal','ragequit',[m.actors.A.account.address,UNIT,0n,[m.dao.settlement]]); await warp(m,2);
  await deposit(m,'A',SETTLEMENT_UNIT); await warp(m,2);
  const data = encodeProposalData([transferCall(m,m.actors.O.account.address,0n)]);
  const submitted=await send('A','baal','submitProposal',[data,0,50_000n,'incremental 5000-record storm']);
  const p={id:1,data,submit:submitted}; await warp(m,2); await vote(m,'A',1,true); await warpPastGrace(m,1);
  await send('B','settlement','approve',[m.dao.depositShaman,1000n*SETTLEMENT_UNIT]);
  await send('B','deposit','deposit',[SETTLEMENT_UNIT]);
  const flags = () => read<readonly boolean[]>(m,'baal','getProposalStatus',[1]);
  const before=await flags();
  await send('W','baal','processProposal',[1,data],false);
  check((await flags()).every((v,i)=>v===before[i]),'unsettled changed flags');
  console.log('ASSERT UNSETTLED process reverts; all four flags unchanged');
  await send('B','deposit','deposit',[SETTLEMENT_UNIT]);
  await send('W','shares','settleRetention',[1,1n]);
  const partial=await read<readonly [bigint,bigint]>(m,'shares','settlements',[1]);
  const outOfGas=await writeWithGas(m.actors.W,m.dao.shares,m.abi.shares,'settleRetention',[1,128n],30_000n);
  check(outOfGas.status==='reverted' && (await read<readonly [bigint,bigint]>(m,'shares','settlements',[1])).every((v,i)=>v===partial[i]),'failed chunk lost progress');
  console.log('ASSERT OOG chunk reverts; saved cursor and growth unchanged');
  await send('W','baal','processProposal',[1,data],false);
  check((await flags()).every((v,i)=>v===before[i]),'partial changed flags');
  check((await read<readonly [bigint,bigint]>(m,'shares','settlements',[1])).every((v,i)=>v===partial[i]),'process changed partial');
  // Mutate BOTH an already replayed account and a not-yet replayed account between chunks.
  await send('B','baal','ragequit',[m.actors.B.account.address,UNIT,0n,[m.dao.settlement]]);
  await send('A','baal','ragequit',[m.actors.A.account.address,40n*UNIT,0n,[m.dao.settlement]]);
  await send('A','settlement','approve',[m.dao.depositShaman,100n*SETTLEMENT_UNIT]);
  await send('A','deposit','deposit',[40n*SETTLEMENT_UNIT]);
  await settleRetention(m.actors.W,m.dao.shares,1,1n);
  check((await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[1]))[0]===0n,'return not restored');
  console.log('ASSERT PARTIAL flags unchanged; interleaved mint/burn/exit40-return40 deficit=0');
  const finished=await read<readonly [bigint,bigint]>(m,'shares','settlements',[1]);
  const noop=await send('W','shares','settleRetention',[1,2n**256n-1n]);
  const noReceipt=await m.chain.publicClient.getTransactionReceipt({hash:noop.hash});
  check(noReceipt.logs.length===0 && (await read<readonly [bigint,bigint]>(m,'shares','settlements',[1])).every((v,i)=>v===finished[i]),'finished call mutated state');
  console.log(`ASSERT FINISHED settle no-op gas=${noop.gasUsed} logs=0`);
  await send('B','deposit','deposit',[1n]);
  await send('W','baal','processProposal',[1,data],false);
  await settleRetention(m.actors.W,m.dao.shares,1);
  console.log('ASSERT NEW MINT after finish reopens pending suffix; stale process reverts');
  // Isolate identical partial deposit/exit operations, including same checkpoint timestamp shape.
  const measure=async()=>{
   const snap=await rpc('evm_snapshot'); await warp(m,2);
   const dep=await send('A','deposit','deposit',[SETTLEMENT_UNIT]); await warp(m,2);
   const ex=await send('A','baal','ragequit',[m.actors.A.account.address,UNIT,0n,[m.dao.settlement]]);
   check(await rpc('evm_revert',[snap]),'gas snapshot'); return [dep.gasUsed,ex.gasUsed];
  };
  const quiet=await measure();
  const helper=await deployHelper(m,'B');
  await send('B','settlement','transfer',[helper.address,5000n]);
  await runCalls(m,'B',helper,[approveCall(m,m.dao.depositShaman,5000n)],'storm approval');
  const first=await read<bigint>(m,'shares','journalLength'); let attackGas=0n;
  for(let batch=0;batch<100;batch++) {
   // Smallest positive settlement unit, repeated address: no assumed anti-spam minimum or dedup discount.
   const receipt=await runCalls(m,'B',helper,Array.from({length:50},()=>depositCall(m,1n)),`STORM batch=${batch+1} records=50`,15_000_000n);
   attackGas+=receipt.gasUsed;
   if(batch===49) {
    const during=await measure(); check(during.every((x,i)=>x===quiet[i]),'mid-storm gas changed');
    console.log(`GAS MID_STORM records=2500 deposit=${during[0]} exit=${during[1]}`);
   }
  }
  const end=await read<bigint>(m,'shares','journalLength'); check(end-first===5000n,'not 5000 real records');
  check(await read<bigint>(m,'settlement','balanceOf',[helper.address])===0n,'attacker did not spend 5000 units');
  const storm=await measure(); check(storm.every((x,i)=>x===quiet[i]),'storm gas changed');
  console.log(`GAS CONSTANT quiet_deposit=${quiet[0]} storm_deposit=${storm[0]} quiet_exit=${quiet[1]} storm_exit=${storm[1]}`);
  await send('W','baal','processProposal',[1,data],false);
  const settled=await settleRetention(m.actors.W,m.dao.shares,1,128n);
  check(settled.calls===40,'expected ceil(5000/128) calls');
  const processed=await send('W','baal','processProposal',[1,data]); const status=await flags();
  check(status[1]&&status[2]&&!status[3],'storm proposal not successfully processed');
  console.log(`STORM records=5000 settle_calls=${settled.calls} settle_total_gas=${settled.gasUsed} settle_gas_per_record=${Number(settled.gasUsed)/5000} process_gas=${processed.gasUsed} processed=${status[1]} passed=${status[2]} actionFailed=${status[3]}`);
  console.log(`ECONOMICS attacker_deposit_gas=${attackGas} attacker_gas_per_record=${Number(attackGas)/5000} attacker_USDC=0.005 attacker_USDC_per_record=0.000001 settler_gas_per_record=${Number(settled.gasUsed)/5000} gas_ratio=${Number(attackGas)/Number(settled.gasUsed)} approval_and_helper_deployment_excluded=true USDC_recoverable_by_exit=true`);
  // Queue successor remains executable after all expensive work was settled outside proposal budget.
  await send('A','baal','submitProposal',[data,0,50_000n,'successor']); await warp(m,2); await vote(m,'A',2,true); await warpPastGrace(m,2);
  await settleRetention(m.actors.W,m.dao.shares,2); await send('W','baal','processProposal',[2,data]);
  check((await read<readonly boolean[]>(m,'baal','getProposalStatus',[2]))[2],'successor blocked');
  console.log('ASSERT QUEUE successor processed=true; baalGas=50000; no settlement deadline');
  console.log('GREEN incremental settlement all assertions');
 } finally { await shutdown(m); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
