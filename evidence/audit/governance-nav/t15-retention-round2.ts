/** Round-2 local-only review. Default asserts the deficit specification (RED on dcb3e83).
 * --observe records known mismatches without treating them as implementation correctness.
 * --candidate deploys an in-memory holder-scan prototype, then installs its runtime at the EMPTY
 * DAO token using anvil_setCode. This is a local fix experiment, never a production source edit.
 */
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { toHex } from 'viem';
import { boot, shutdown, fund, deposit, ragequit, propose, vote, warp, warpPastGrace, processProposal, read, fmt, UNIT, SETTLEMENT_UNIT, transferCall, type Mirror } from '../../../scenarios/lib.js';
import { deployHelper, runCalls, approveCall, depositCall, submitCall, ragequitCall } from './audit-lib.js';

if (process.env.ZERO_ONE_LIVE_DEPLOYMENT || process.env.FORK_RPC) throw new Error('LOCAL ONLY: unset live/fork environment');
const candidate = process.argv.includes('--candidate');
const observe = process.argv.includes('--observe');
let mismatches = 0;
function check(x: unknown, message: string) { if (!x) throw new Error(message); }
function record(label: string, actual: bigint, expected: bigint) {
  console.log(`R2 ${label}: exited=${fmt(actual)} deficit=${fmt(expected)} ${actual === expected ? 'MATCH' : 'MISMATCH'}`);
  if (actual !== expected) mismatches++;
}
async function rpc(m: Mirror, method: string, params: unknown[] = []): Promise<any> {
  check(m.devnet?.rpcUrl.startsWith('http://127.0.0.1:'), 'must own loopback devnet');
  return m.chain.publicClient.request({ method, params } as never);
}
async function raw(m: Mirror, actor: 'A'|'B', target: 'baal'|'deposit'|'settlement', name: string, args: unknown[], gas?: bigint) {
  const c=m.actors[actor];
  const address=target==='deposit'?m.dao.depositShaman:target==='baal'?m.dao.baal:m.dao.settlement;
  const hash=await c.walletClient.writeContract({address,abi:m.abi[target],functionName:name,args,account:c.account,chain:c.chain,...(gas?{gas}:{})} as never);
  const r=await c.publicClient.waitForTransactionReceipt({hash}); check(r.status==='success',`raw ${name} reverted`); return r;
}
async function negative(label: string, fn: ()=>Promise<unknown>, needle: string) {
  try { await fn(); } catch(e) { check(String(e).includes(needle),`${label}: wrong error ${e}`); console.log(`R2 ${label}: REVERT ${needle}`); return; }
  throw new Error(`${label}: expected revert`);
}
function compileToken(useCandidate: boolean) {
  let source=readFileSync('contracts/NavShareToken.sol','utf8');
  if(useCandidate) {
    source=source.replace('mapping(address account => Lot[]) private _lots;',`mapping(address account => Lot[]) private _lots;
      address[] private _holders;
      mapping(address => bool) private _seen;
      mapping(uint256 => uint256) private _starts;`);
    source=source.replace('index = ++epoch;', 'index = ++epoch; _starts[proposalId] = block.timestamp;');
    source=source.replace('exited = _prefix(index) - burnedAtRegistration[index];',`for (uint256 k; k < _holders.length; ++k) {
       address a = _holders[k]; uint256 b = getPastVotes(a, _starts[proposalId]);
       supplyAtStart += b; if (b > balanceOf[a]) exited += b - balanceOf[a];
    }`);
    source=source.replace('supplyAtStart = supplyAtRegistration[index];', '// denominator summed from the same timestamp snapshots');
    source=source.replace('function getPastVotes(address account, uint256 timePoint) external view', 'function getPastVotes(address account, uint256 timePoint) public view');
    source=source.replace('_consumeLots(account, amount);','// holder-scan prototype: no burn tree');
    source=source.replace('_pushLot(recipient, amount);','if (!_seen[recipient]) { _seen[recipient] = true; _holders.push(recipient); }');
  }
  const input={language:'Solidity',sources:{'contracts/NavShareToken.sol':{content:source}},settings:{evmVersion:'cancun',optimizer:{enabled:true,runs:200},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','storageLayout']}}}};
  const out=JSON.parse(solc.compile(JSON.stringify(input),{import:(p:string)=>{for(const f of [p,`node_modules/${p}`]) {try{return {contents:readFileSync(f,'utf8')}}catch{}} return {error:p};}}));
  check(!(out.errors??[]).some((e:any)=>e.severity==='error'),JSON.stringify(out.errors));
  return out.contracts['contracts/NavShareToken.sol'].NavShareToken;
}
async function main() {
 const m=await boot('retention-r2');
 try {
  console.log(`R2 MODE ${candidate?'CANDIDATE local runtime replacement':'ORIGINAL dcb3e83'} chain=${m.devnet!.chainId}`);
  const artifact=compileToken(candidate);
  if(candidate) {
   check(await read<bigint>(m,'shares','totalSupply')===0n,'candidate must install before any mint');
   const c=m.actors.F;
   const h=await c.walletClient.deployContract({abi:artifact.abi,bytecode:`0x${artifact.evm.bytecode.object}`,args:['Candidate','CAND',m.dao.baal,m.dao.safe,m.dao.settlement],account:c.account,chain:c.chain} as never);
   const r=await c.publicClient.waitForTransactionReceipt({hash:h}); check(r.status==='success','candidate deploy');
   const code=await c.publicClient.getCode({address:r.contractAddress!});
   await rpc(m,'anvil_setCode',[m.dao.shares,code]);
   check(await c.publicClient.getCode({address:m.dao.shares})===code,'candidate runtime readback');
   console.log(`R2 CANDIDATE deployed=${r.contractAddress} runtime installed before mint; holder scan uses the timestamp snapshot for both numerator and denominator`);
  }
  await fund(m,'A',10_000n*SETTLEMENT_UNIT); await fund(m,'B',10_000n*SETTLEMENT_UNIT);
  await deposit(m,'A',100n*SETTLEMENT_UNIT); await warp(m,2);
  let base=await rpc(m,'evm_snapshot');
  const reset=async()=>{check(await rpc(m,'evm_revert',[base]),'snapshot revert');base=await rpc(m,'evm_snapshot');};
  const mint=async(n:bigint,who:'A'|'B'='A')=>{await warp(m,2);return deposit(m,who,n*SETTLEMENT_UNIT);};
  const burn=async(n:bigint)=>{await warp(m,2);return ragequit(m,'A',n*UNIT);};
  const start=async()=>propose(m,'A',[transferCall(m,m.actors.O.account.address,0n)],'retention round2');
  const exits=async(id:number)=>(await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[id]))[0];
  const compare=async(label:string,id:number,n:bigint)=>record(label,await exits(id),n*UNIT);

  const p=await start(); await vote(m,'A',p.id,true);
  console.log(`R2 Q1 startBalance=${fmt(await read<bigint>(m,'shares','balanceOf',[m.actors.A.account.address]))}`);
  const first=await burn(40n); const remint=await mint(40n);
  const result=await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[p.id]);
  console.log(`R2 Q1 exitedSince(${p.id}) raw=[${result[0]},${result[1]}] balanceNow=${fmt(await read<bigint>(m,'shares','balanceOf',[m.actors.A.account.address]))}`);
  await compare('Q1 burn40 -> mint40',p.id,0n);
  await warpPastGrace(m,p.id); const processed=await processProposal(m,'A',p);
  console.log(`R2 Q1 ragequitGas=${first.receipt.gasUsed} remintGas=${remint.receipt.gasUsed} processGas=${processed.receipt.gasUsed} passed=${processed.info.status.passed} actionFailed=${processed.info.status.actionFailed}`);
  check(processed.info.status.passed===candidate,'Q1 processing tracks measured semantics');
  await reset(); let x=await start(); await mint(40n); await burn(40n); await compare('mint40 -> burn40',x.id,0n);
  await reset(); x=await start(); await mint(40n); await burn(80n); await mint(40n); await compare('deposit40 -> exit80 -> deposit40',x.id,0n);
  await reset(); x=await start(); await mint(40n); const y=await start(); await burn(60n); await compare('old+new lots P',x.id,20n);await compare('old+new lots Q',y.id,60n);
  await reset(); x=await start(); await burn(40n);await mint(40n);const z=await start();await burn(20n);await compare('one account two windows P',x.id,20n);await compare('one account two windows Q',z.id,20n);
  await reset(); x=await start();const count=await read<bigint>(m,'shares','lotCount',[m.actors.A.account.address]); const zero=await burn(0n);await compare('ragequit(0)',x.id,0n);check(count===await read<bigint>(m,'shares','lotCount',[m.actors.A.account.address]),'zero changed lots');console.log(`R2 ragequit(0) gas=${zero.receipt.gasUsed} lots unchanged`);
  await reset(); x=await start();await burn(40n);await mint(40n,'B');await compare('different-account refill',x.id,40n);
  await reset();await burn(40n);x=await start();await compare('pre-start burn baseline',x.id,0n);
  await reset();x=await start();await burn(40n);await mint(40n);await burn(40n);await mint(40n);await compare('repeat same-account roundtrip twice',x.id,0n);
  await reset();x=await start();const cold=await burn(1n);const warm=await burn(1n);console.log(`R2 gas epoch0 single lot firstTouch=${cold.receipt.gasUsed} initializedTree=${warm.receipt.gasUsed}`);

  // Both real sponsorship paths and direct-call protections.
  await reset();
  await negative('unauthorized register',()=>m.actors.A.publicClient.simulateContract({address:m.dao.shares,abi:m.abi.shares,functionName:'registerProposal',args:[999n],account:m.actors.A.account} as never),'OnlyBaal');
  await negative('unknown proposal read',()=>exits(999),'NotRegistered');
  const unsponsored=await propose(m,'B',[transferCall(m,m.actors.O.account.address,0n)],'unsponsored');
  check(await read<number>(m,'shares','registrationOf',[unsponsored.id])===0,'unsponsored registered early');
  await raw(m,'A','baal','sponsorProposal',[unsponsored.id]);
  check(Number(await read(m,'shares','registrationOf',[unsponsored.id]))===1,'separate sponsor registration missing');
  await negative('duplicate sponsor',()=>m.actors.A.publicClient.simulateContract({address:m.dao.baal,abi:m.abi.baal,functionName:'sponsorProposal',args:[unsponsored.id],account:m.actors.A.account} as never),'!submitted');
  console.log('R2 unsponsored registration=0; separate sponsorship registration=1');

  // Endpoint injection avoids 16,777,214 prior transactions; no production path is claimed.
  await reset();x=await start();await vote(m,'A',x.id,true);
  const slot=artifact.storageLayout.storage.find((s:any)=>s.label==='epoch');check(slot && slot.offset===0,'epoch storage layout');
  const max=await read<bigint>(m,'shares','MAX_EPOCHS');
  await rpc(m,'anvil_setStorageAt',[m.dao.shares,toHex(BigInt(slot.slot),{size:32}),toHex(max-2n,{size:32})]);
  const last=await start();check(BigInt(await read(m,'shares','epoch'))===max-1n,'last valid epoch');
  await negative('MAX_EPOCHS next sponsorship',()=>m.actors.A.publicClient.simulateContract({address:m.dao.baal,abi:[...m.abi.baal,...m.abi.shares],functionName:'submitProposal',args:[last.data,0,0n,'exhausted'],account:m.actors.A.account} as never),'EpochsExhausted');
  await mint(1n);await burn(1n);await warpPastGrace(m,x.id);const end=await processProposal(m,'A',x);
  console.log(`R2 MAX_EPOCHS=${max} lastRegistration=${max-1n} epochSlot=${slot.slot}; mint/burn work; oldProposalPassed=${end.info.status.passed}`);

  // Stress through real deposits and self-sponsorship, no synthetic lot storage.
  await reset();
  for(let i=1;i<=256;i++) {
    await raw(m,'A','baal','submitProposal',['0x',0,0n,'lot stress']);
    await raw(m,'A','settlement','approve',[m.dao.depositShaman,SETTLEMENT_UNIT]);
    await raw(m,'A','deposit','deposit',[SETTLEMENT_UNIT]);
    if([16,64,256].includes(i)) {
      const snap=await rpc(m,'evm_snapshot'); await warp(m,2);
      const lots=await read<bigint>(m,'shares','lotCount',[m.actors.A.account.address]);const r=await ragequit(m,'A');
      console.log(`R2 STRESS liveLots=${lots} fullExitGas=${r.receipt.gasUsed} blockGasLimit=${(await m.chain.publicClient.getBlock()).gasLimit}`);
      check(await rpc(m,'evm_revert',[snap]),'stress revert');
    }
  }

  // One transaction: P starts, mint 40, Q starts. Both vote snapshots are end-of-second 140.
  await reset(); const h=await deployHelper(m,'B');
  await raw(m,'B','settlement','transfer',[h.address,200n*SETTLEMENT_UNIT]);
  await runCalls(m,'B',h,[approveCall(m,m.dao.depositShaman,200n*SETTLEMENT_UNIT),depositCall(m,100n*SETTLEMENT_UNIT)],'helper seed');
  await warp(m,2);
  const s1=submitCall(m,[transferCall(m,m.actors.O.account.address,0n)],'same timestamp P');
  const s2=submitCall(m,[transferCall(m,m.actors.O.account.address,0n)],'same timestamp Q');
  const tx=await runCalls(m,'B',h,[s1,depositCall(m,40n*SETTLEMENT_UNIT),s2],'P + mint40 + Q');
  const time=(await m.chain.publicClient.getBlock({blockNumber:tx.blockNumber})).timestamp;await warp(m,2);
  const past=await read<bigint>(m,'shares','getPastVotes',[h.address,time]);
  await runCalls(m,'B',h,[ragequitCall(m,h.address,40n*UNIT)],'helper burns40');
  const r1=await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[1]); const r2=await read<readonly [bigint,bigint]>(m,'shares','exitedSince',[2]);
  console.log(`R2 TIMESTAMP P/Q same start=${time} helperPastVotes=${fmt(past)} helperNow=100 Pbase=${fmt(r1[1])} Qbase=${fmt(r2[1])}`);
  record('same-timestamp P after burn40',r1[0],40n*UNIT);record('same-timestamp Q after burn40',r2[0],40n*UNIT);
  console.log(`R2 ${candidate?'CANDIDATE':'ORIGINAL'} specification mismatches=${mismatches}; ${mismatches?(observe?'OBSERVATION run completed; NOT correctness PASS':'RED: deficit specification fails'):'GREEN: executed deficit assertions match'}`);
  if(!observe && mismatches) process.exitCode=1;
 } finally {await shutdown(m);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
