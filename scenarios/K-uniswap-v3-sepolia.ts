/** Native Base Sepolia counterpart of K: own mock pair, published v3, real 1800-second history. */
import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, type Abi, type Address } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadLocalAbi } from '../src/baal.js';
import { deployLocal, simulateSettled, writeAndWait } from '../src/onchain.js';
import { deployTemplate, migrateCalls, stopCalls, unwindCalls, type StrategyParams } from '../src/proposals.js';
import { assert, atHead, boot, describeAt, expectDeployRevert, expectRevert, LIVE, now, observe, processProposal, propose, proposeTemplate, read, runIfMain, seedMembers, shutdown, simulate, UNIT, SETTLEMENT_UNIT as U, vote, warp, warpPastGrace, type Proposal } from './lib.js';

const V3 = {factory:getAddress('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'),router:getAddress('0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4'),quoter:getAddress('0xC5290058841028F1614F3A6F0F5816cAd0df5E27'),manager:getAddress('0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2')};
const dependencyAbi=parseAbi(['function factory() view returns(address)','function getPool(address,address,uint24) view returns(address)','function createPool(address,address,uint24) returns(address)']);
const poolAbi=parseAbi(['function initialize(uint160)','function increaseObservationCardinalityNext(uint16)','function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)','function observe(uint32[]) view returns(int56[],uint160[])']);
const managerAbi=parseAbi(['function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)']);
export async function main(){
 if(!LIVE) throw new Error('K Sepolia requires the explicit live deployment');
 const m=await boot('scenario-K-native-sepolia');
 try {
  await seedMembers(m);
  const c=m.actors.F, pc=c.publicClient, d=m.dao;
  const pinned=<T>(address:Address,abi:Abi,functionName:string,args:readonly unknown[]=[])=>atHead(m,blockNumber=>pc.readContract({address,abi,functionName,args,blockNumber} as never) as Promise<T>);
  const bal=(token:Address,holder:Address)=>pinned<bigint>(token,m.abi.settlement,'balanceOf',[holder]);
  const tx=async(address:Address,abi:Abi,functionName:string,args:readonly unknown[],label:string,gas=3_000_000n)=>{
   const simulation=await simulateSettled<{request:Record<string,unknown>}>(c,{address,abi,functionName,args});
   const r=await writeAndWait(c,{...simulation.request,gas});observe(m,r.receipt.blockNumber);
   console.log(`RECEIPT ${label} tx=${r.hash} block=${r.receipt.blockNumber} gas=${r.receipt.gasUsed}`);return r;
  };
  console.log('SOURCE https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments');
  for(const [name,address] of Object.entries(V3)) { const code=await pc.getCode({address}); assert(code && code!=='0x',`published Sepolia ${name} has code ${address}`); }
  for(const address of [V3.router,V3.quoter]) assert(getAddress(await pinned<Address>(address,dependencyAbi,'factory'))===V3.factory,'published dependency factory matches');
  const asset=await deployLocal(c,'TestToken',['K Sepolia asset','KASSET',100_000_000n*U]);
  console.log(`RECEIPT K asset deploy ${asset.hash} address=${asset.address}`);
  await tx(V3.factory,dependencyAbi,'createPool',[d.settlement,asset.address,500],'create own mock pair',8_000_000n);
  const pool=await pinned<Address>(V3.factory,dependencyAbi,'getPool',[d.settlement,asset.address,500]);
  await tx(pool,poolAbi,'initialize',[1n<<96n],'initialize price 1');
  const initialized=await now(m);
  await tx(pool,poolAbi,'increaseObservationCardinalityNext',[128],'grow observation ring');
  const venueArgs=[d.safe,d.settlement,asset.address,V3.router,V3.quoter,V3.factory,500] as const;
  const artifact=await import('../src/baal.js').then(x=>x.loadLocalArtifact('UniswapV3Venue'));
  await expectDeployRevert(m,'F','UniswapV3Venue',venueArgs,'WindowUnavailable','new pool refuses 30-minute TWAP');
  for(const token of [d.settlement,asset.address]) await tx(token,m.abi.settlement,'approve',[V3.manager,1_000_000n*U],'liquidity approval');
  const [token0,token1]=[d.settlement,asset.address].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
  await tx(V3.manager,managerAbi,'mint',[{token0,token1,fee:500,tickLower:-887270,tickUpper:887270,amount0Desired:1_000_000n*U,amount1Desired:1_000_000n*U,amount0Min:0n,amount1Min:0n,recipient:c.account.address,deadline:(await now(m))+600n}],'mint own full-range liquidity',5_000_000n);
  mkdirSync('evidence/testnet/phase5/K',{recursive:true});
  writeFileSync('evidence/testnet/phase5/K/pool.json',JSON.stringify({chainId:84532,dao:d.baal,safe:d.safe,settlement:d.settlement,asset:asset.address,pool,initialized:String(initialized),readyAt:String(initialized+1801n),dependencies:V3,source:'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments'},null,2)+'\n');
  console.log(`K POOL READY; waiting real TWAP history until ${new Date(Number(initialized+1801n)*1000).toISOString()}`);
  await warp(m,Number(initialized+1801n-await now(m)),'real Uniswap TWAP history');
  await pinned(pool,poolAbi,'observe',[[1800,0]]);
  const venue=await deployLocal(c,'UniswapV3Venue',venueArgs);console.log(`RECEIPT venue deploy ${venue.hash} address=${venue.address}`);
  const ledgerAbi=loadLocalAbi('TreasuryLedger');
  const ledger=<T>(name:string,args:readonly unknown[]=[])=>pinned<T>(d.treasuryLedger,ledgerAbi,name,args);
  const pass=async(p:Proposal)=>{await vote(m,'A',p.id,true);await vote(m,'B',p.id,true);await warpPastGrace(m,p.id);const r=await processProposal(m,'W',p);assert(r.info.status.passed&&!r.info.status.actionFailed,`K proposal ${p.id} executed`);return r;};
  const manage=async(calls:Parameters<typeof propose>[2],label:string)=>pass(await propose(m,'A',calls,label));
  const start=async(params:StrategyParams,label:string)=>{const p=await proposeTemplate(m,'A',{template:'Strategy',params},label);await pass(p);return p.instance.address;};
  const status=(address:Address)=>describeAt(m,address,'K instance').then(x=>x.status);
  const empty=async()=>{for(const token of [d.settlement,asset.address]){assert(await bal(token,venue.address)===0n,'venue has no retained tokens');assert(await pinned<bigint>(token,m.abi.settlement,'allowance',[venue.address,V3.router])===0n,'router allowance reset');}};
  const run=(address:Address)=>tx(address,m.abi.strategy,'run',[],'permissionless Strategy run',2_000_000n);
  const params:StrategyParams={venue:venue.address,asset:asset.address,budget:20n*U,rule:{maxPerRun:2n*U,minInterval:0n,deadline:(await now(m))+86400n,takeProfitBps:2500n,stopLossBps:5000n,slippageBps:50n}};
  const first=await start(params,'K two buys then voted stop and unwind');await run(first);const b1=await bal(asset.address,first);await run(first);const b2=await bal(asset.address,first);await empty();
  assert(b2>b1&&b1>0n&&await bal(d.settlement,first)===16n*U,'two real v3 buys spend exactly 2 mock USDC each');
  assert(!await ledger<boolean>('settled'),'asset in open instance pauses deposits');await expectRevert(simulate(m,'D','deposit','quote',[U]),'TreasuryNotSettled','running asset gate');
  await manage(stopCalls(first),'K stop');assert(await bal(asset.address,first)===b2&&await bal(d.settlement,first)===0n,'stop preserves asset and returns USDC');
  await expectRevert(simulate(m,'D','deposit','quote',[U]),'TreasuryNotSettled','stopped asset gate');
  await manage(unwindCalls(first),'K unwind');assert(await bal(asset.address,first)===0n&&await ledger<boolean>('settled'),'unwind sold asset and reopened deposits');await empty();
  const old=await start(params,'K migration source');await run(old);const oldUsdc=await bal(d.settlement,old),oldAsset=await bal(asset.address,old);
  const next=await deployTemplate(m.actors.A,d,{template:'Strategy',params});console.log(`RECEIPT migration target deploy ${next.deployHash}`);
  await manage(migrateCalls(old,next.address),'K migrate');assert(await status(old)==='Migrated'&&await status(next.address)==='Running'&&await bal(d.settlement,next.address)===oldUsdc&&await bal(asset.address,next.address)===oldAsset,'migration preserves both token balances');
  await run(next.address);
  await manage([{to:d.settlement,data:encodeFunctionData({abi:m.abi.settlement,functionName:'transfer',args:[next.address,6n*U]} as never)}],'K voted proceeds fixture');await run(next.address);
  assert(await status(next.address)==='Complete'&&await bal(asset.address,next.address)===0n,'take-profit sells via real router');await empty();
  const loss=await start({...params,budget:5n*U,rule:{...params.rule,maxPerRun:5n*U,stopLossBps:1n}},'K 1bp stop-loss after 5bp pool fee');await run(loss);await run(loss);assert(await status(loss)==='Complete','stop-loss sells via real router');await empty();
  const probe=await deployLocal(c,'TwapSandwichProbe',[venue.address]);console.log(`RECEIPT sandwich probe ${probe.hash}`);
  for(const token of [d.settlement,asset.address]) await tx(token,m.abi.settlement,'transfer',[probe.address,60_000_000n*U],'own mock sandwich capital');
  const sandwich=async(s:Address,rising:boolean,refusal:boolean)=>{
   const sqrt=(await pinned<readonly [bigint]>(pool,poolAbi,'slot0'))[0];
   const direction=rising?getAddress(token0!)===getAddress(d.settlement):getAddress(token0!)===getAddress(asset.address);
   const limit=direction?sqrt*89n/100n:sqrt*113n/100n;
   const r=await tx(probe.address,probe.artifact.abi,'sandwich',[s,direction,limit,refusal],'atomic spot print / victim / restoration',8_000_000n);
   const event=r.receipt.logs.filter(l=>getAddress(l.address)===getAddress(probe.address)).map(l=>decodeEventLog({abi:probe.artifact.abi,data:l.data,topics:l.topics})).find(e=>e.eventName==='Sandwiched') as unknown as {args:{report:{priceBefore:bigint;priceDuring:bigint;valueBefore:bigint;valueDuring:bigint;refusedOutput:bigint;refusedMinimum:bigint;sqrtBefore:bigint;sqrtDuring:bigint}}};
   assert(!!event,'Sandwiched event mined');const x=event.args.report;
   assert(x.priceBefore===x.priceDuring&&x.valueBefore===x.valueDuring,'same-block spot print does not change TWAP price or value');
   if(refusal) assert(x.refusedOutput<x.refusedMinimum,'sandwich victim refused by TWAP output bound');
   console.log(`SANDWICH rising=${rising} refusal=${refusal} report=${JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v)}`);await empty();
  };
  const rule={...params.rule,takeProfitBps:0n,stopLossBps:0n};
  const entry=await start({...params,rule},'K entry sandwich');await sandwich(entry,true,true);assert(await bal(d.settlement,entry)===18n*U&&await status(entry)==='Running','entry runs successfully after restoration');
  const print=await start({...params,budget:10n*U,rule:{...rule,maxPerRun:5n*U,stopLossBps:2500n}},'K print does not fire stop-loss');await run(print);const before=await bal(asset.address,print);await sandwich(print,false,false);assert(await status(print)==='Running'&&await bal(asset.address,print)>before,'print does not trigger stop-loss; buy succeeds');
  const deadline=(await now(m))+600n;
  const exit=await start({...params,budget:5n*U,rule:{...rule,maxPerRun:5n*U,deadline}},'K deadline exit sandwich');await run(exit);await warp(m,Number(deadline+1n-await now(m)),'real exit deadline');await sandwich(exit,false,true);assert(await status(exit)==='Complete'&&await bal(asset.address,exit)===0n,'deadline sell fills after restoration');
  console.log('=== SCENARIO K NATIVE SEPOLIA: PASS ===');
 } finally {await shutdown(m);}
}
runIfMain(import.meta.url,main);
