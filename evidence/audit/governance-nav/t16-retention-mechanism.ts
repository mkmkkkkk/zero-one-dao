/** Exact-deficit oracle and quiet/100-open-proposal gas receipts. Local Anvil only. */
import { boot, shutdown, fund, deposit, vote, warp, warpPastGrace, read, fmt, UNIT, SETTLEMENT_UNIT, transferCall, type ActorName, type Proposal } from '../../../scenarios/lib.js';
import { encodeProposalData } from '../../../src/baal.js';
import { deployHelper, runCalls, approveCall, depositCall, submitCall, ragequitCall } from './audit-lib.js';
import { installVariant } from './retention/variants.js';
if (process.env.ZERO_ONE_LIVE_DEPLOYMENT || process.env.FORK_RPC) throw new Error('LOCAL ONLY: unset live/fork environment');
const variant = process.argv.find(x => x.startsWith('--variant='))?.split('=')[1] ?? 'c';
const gasOnly = process.argv.includes('--gas-only');
function check(x: unknown, message: string): asserts x { if (!x) throw new Error(message); }
async function main() {
 const m = await boot(`retention-${variant}`);
 try {
  if (variant !== 'c') await installVariant(m, variant);
  const rpc = (method: string, params: unknown[] = []) => m.chain.publicClient.request({ method, params } as never) as Promise<any>;
  const raw = async (actor: ActorName, target: 'baal'|'deposit'|'settlement', name: string, args: unknown[], gas = 12_000_000n) => {
   const c = m.actors[actor], address = target === 'baal' ? m.dao.baal : target === 'deposit' ? m.dao.depositShaman : m.dao.settlement;
   const hash = await c.walletClient.writeContract({ address, abi: m.abi[target], functionName: name, args, gas, account: c.account, chain: c.chain } as never);
   const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
   check(receipt.status === 'success', `${name} reverted: ${hash} gas=${receipt.gasUsed}`); return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  };
  for (const a of ['A','B','C'] as const) await fund(m, a, 100_000n * SETTLEMENT_UNIT);
  await deposit(m, 'A', 100n * SETTLEMENT_UNIT); await warp(m, 2);
  const data = encodeProposalData([transferCall(m, m.actors.O.account.address, 0n)]);
  const start = async (budget = 8_000_000n) => {
   const submit = await raw('A','baal','submitProposal',[data,0,budget,'retention exactness']);
   const id = Number(await read(m,'baal','proposalCount')); await warp(m,2); return { id, data, submit };
  };
  const processP = async (p: Proposal) => { await warpPastGrace(m,p.id); const r = await raw('A','baal','processProposal',[p.id,p.data]); return r; };
  let base = await rpc('evm_snapshot');
  const reset = async () => { check(await rpc('evm_revert',[base]),'reset'); base = await rpc('evm_snapshot'); };
  const mint = async (n: bigint, who: ActorName = 'A') => { await warp(m,2); await raw(who,'settlement','approve',[m.dao.depositShaman,n*SETTLEMENT_UNIT]); return raw(who,'deposit','deposit',[n*SETTLEMENT_UNIT]); };
  const burn = async (n: bigint, who: ActorName = 'A') => { await warp(m,2); return raw(who,'baal','ragequit',[m.actors[who].account.address,n*UNIT,0n,[m.dao.settlement]]); };
  const result = (id: number) => read<readonly [bigint,bigint]>(m,'shares','exitedSince',[id]);
  const equal = async (label: string, id: number, expected: bigint, supply?: bigint) => { const [actual, a] = await result(id); console.log(`ASSERT ${label}: exited=${fmt(actual)} expected=${expected} supplyAtStart=${fmt(a)}`); check(actual === expected*UNIT && (supply === undefined || a === supply*UNIT),label); };
  if (!gasOnly) {
   let p = await start(); await vote(m,'A',p.id,true); await burn(40n); await mint(40n);
   check(await read<bigint>(m,'shares','balanceOf',[m.actors.A.account.address]) === 100n*UNIT,'restored balance');
   await equal('COUNTEREXAMPLE exit40 return40 balance100',p.id,0n,100n);
   await processP(p); check((await read<readonly boolean[]>(m,'baal','getProposalStatus',[p.id]))[2], 'returned member proposal passes');
   await reset();
   try { await m.actors.A.publicClient.simulateContract({address:m.dao.shares,abi:m.abi.shares,functionName:'registerProposal',args:[999n],account:m.actors.A.account} as never); throw new Error('unauthorized registration succeeded'); }
   catch(e) { check(String(e).includes('OnlyBaal'),'registration access control'); }
   try { await result(999); throw new Error('unregistered read succeeded'); }
   catch(e) { check(String(e).includes('NotRegistered'),'unregistered read'); }
   await raw('B','baal','submitProposal',[data,0,8_000_000n,'separate sponsorship']);
   check(await read<bigint>(m,'shares','votingStarts',[1])===0n,'unsponsored snapshot');
   await raw('A','baal','sponsorProposal',[1]);
   check(await read<bigint>(m,'shares','votingStarts',[1])>0n,'separate sponsor snapshot');
   await warp(m,2); await equal('separate sponsorship',1,0n,100n);
   console.log('ASSERT registration: unauthorized/unknown rejected; separate sponsorship records start');
   await reset(); p=await start(); await mint(40n); await burn(80n); await mint(40n); await equal('mint40 exit80 return40',p.id,0n);
   await reset(); p=await start(); await mint(40n); const q=await start(); await burn(60n); await equal('MULTI earlier window',p.id,20n,100n); await equal('MULTI later window',q.id,60n,140n);
   await mint(20n); await equal('MULTI earlier return',p.id,0n); await equal('MULTI later return',q.id,40n);
   await reset(); p=await start(); await burn(40n); await mint(40n,'B'); await equal('different-account refill does not mask exit',p.id,40n,100n);
   await reset(); p=await start(); await vote(m,'A',p.id,true); await burn(40n); await equal('YES voter leaves: deficit reduces retained support',p.id,40n,100n); await processP(p);
   check(!(await read<readonly boolean[]>(m,'baal','getProposalStatus',[p.id]))[2], 'YES departure defeats proposal');
   console.log('ASSERT YES voter departure: passed=false (historical yesVotes remain the Baal ballot)');
   await reset(); p=await start();
   const zeroBefore=await Promise.all([read(m,'shares','numCheckpoints',[m.actors.A.account.address]),read(m,'shares','totalSupply'),read(m,'shares','totalBurned'),read(m,'settlement','balanceOf',[m.dao.safe])]);
   const zero=await burn(0n);
   const zeroAfter=await Promise.all([read(m,'shares','numCheckpoints',[m.actors.A.account.address]),read(m,'shares','totalSupply'),read(m,'shares','totalBurned'),read(m,'settlement','balanceOf',[m.dao.safe])]);
   check(zeroBefore.every((v,i)=>v===zeroAfter[i]),'zero changed state'); await equal('ragequit(0) no-op',p.id,0n); console.log(`ASSERT ZERO state unchanged gas=${zero.gasUsed}`);
   // Timestamp tie: P, mint, Q in one transaction; both use end-of-second balances and supply.
   await reset(); const h=await deployHelper(m,'B'); await raw('B','settlement','transfer',[h.address,200n*SETTLEMENT_UNIT]);
   await runCalls(m,'B',h,[approveCall(m,m.dao.depositShaman,200n*SETTLEMENT_UNIT),depositCall(m,100n*SETTLEMENT_UNIT)],'helper seed'); await warp(m,2);
   const s1=submitCall(m,[transferCall(m,m.actors.O.account.address,0n)],'same-second P');
   const s2=submitCall(m,[transferCall(m,m.actors.O.account.address,0n)],'same-second Q');
   await runCalls(m,'B',h,[s1,depositCall(m,40n*SETTLEMENT_UNIT),s2],'P mint40 Q'); await warp(m,2);
   await runCalls(m,'B',h,[ragequitCall(m,h.address,40n*UNIT)],'helper exits40');
   await equal('TIMESTAMP P',1,40n,240n); await equal('TIMESTAMP Q',2,40n,240n);
   // Deterministic multi-account oracle: snapshots are independent JS copies, never the implementation formula.
   await reset(); const windows: {p: Proposal; balances: bigint[]}[]=[];
   const actors=['A','B','C'] as const;
   const balances=()=>Promise.all(actors.map(a=>read<bigint>(m,'shares','balanceOf',[m.actors[a].account.address])));
   for (let i=0;i<36;i++) {
    if(i%6===0) windows.push({p:await start(),balances:await balances()});
    const who=actors[(i*7)%3]; const held=(await balances())[actors.indexOf(who)]/UNIT;
    if(i%4===0 && held>3n) await burn(3n,who); else await mint(BigInt(1+i%5),who);
    const current=await balances();
    for(const w of windows) { const expected=w.balances.reduce((sum,b,j)=>sum+(b>current[j]?b-current[j]:0n),0n); const [actual,a]=await result(w.p.id);check(actual===expected && a===w.balances.reduce((x,y)=>x+y,0n),`oracle step ${i} window ${w.p.id}`); }
   }
   console.log('ASSERT ORACLE 36 changes / 6 overlapping windows: exact per-account deficits and supply');
   // Budget exhaustion must not accept a partial sum or set processed. 100 later mints cost the processor.
   if (variant === 'c') {
   await reset(); p=await start(50_000n); await vote(m,'A',p.id,true);
   for(let i=0;i<100;i++) await mint(1n,'B'); await warpPastGrace(m,p.id);
   const c=m.actors.A; const hash=await c.walletClient.writeContract({address:m.dao.baal,abi:m.abi.baal,functionName:'processProposal',args:[p.id,p.data],gas:5_000_000n,account:c.account,chain:c.chain} as never);
   const failed=await c.publicClient.waitForTransactionReceipt({hash}); check(failed.status==='reverted','budget should exhaust');
   check(!(await read<readonly boolean[]>(m,'baal','getProposalStatus',[p.id]))[1],'incomplete scan processed');
   await equal('budget exhausted but full read exact',p.id,0n,100n); console.log(`ASSERT BUDGET exhaustion reverts atomically processed=false gas=${failed.gasUsed}`);
  }
  }
  // One window vs 100, same state shape. Snapshot isolates each measured operation.
  for(const n of [1,100]) {
   await reset(); const proposals: Proposal[]=[];
   for(let i=0;i<n;i++) proposals.push(await start());
   await vote(m,'A',proposals[0].id,true);
   let snap=await rpc('evm_snapshot'); const ordinary=await burn(40n); await rpc('evm_revert',[snap]);
   const dep=await mint(40n); snap=await rpc('evm_snapshot'); const received=await burn(40n); await rpc('evm_revert',[snap]);
   const processed=await processP(proposals[0]);
   const status=await read<readonly boolean[]>(m,'baal','getProposalStatus',[proposals[0].id]);
   check(status[1] && status[2] && !status[3], 'gas workload must process, pass and execute');
   console.log(`GAS ${variant} open=${n} deposit=${dep.gasUsed} exit_ordinary=${ordinary.gasUsed} exit_after_mint=${received.gasUsed} process=${processed.gasUsed}`);
  }
  // Adversarial interleaving fragments legacy lots; complete exit must still be cheap in c.
  await reset(); for(let i=0;i<100;i++){await start();await mint(1n);}
  const frag=await burn(200n); console.log(`GAS ${variant} open=100 interleaved_mints=100 full_exit=${frag.gasUsed}`);
  console.log(`GREEN retention ${variant} ${gasOnly?'gas comparison':'all exact-deficit assertions'}`);
 } finally { await shutdown(m); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
