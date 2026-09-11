/** Strengthen K: the manipulated spot portfolio must cross the actual stop-loss threshold. */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeEventLog, getAddress, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { loadLocalAbi } from '../src/baal.js';
import { liveChain, liveContexts, keyFromEnvFile } from '../src/live.js';
import { awaitRead, simulateSettled, writeAndWait } from '../src/onchain.js';

const dir='evidence/testnet/phase5',log=readFileSync(`${dir}/scenario-K.log`,'utf8');
if(!log.includes('=== SCENARIO K NATIVE SEPOLIA: PASS ==='))throw Error('finish native K before using its signer and fixtures');
const key=process.env.ZERO_ONE_DEPLOYER_KEY_FILE;if(!key)throw Error('explicit isolated Sepolia key required');
const p=JSON.parse(readFileSync(`${dir}/K/pool.json`,'utf8'));if(p.chainId!==84532)throw Error('Sepolia only');
const line=log.split('\n').find(s=>s.startsWith('   details: K print does not fire stop-loss '));
if(!line)throw Error('K print fixture not found');
const detail=JSON.parse(line.slice(line.indexOf('{'))),strategy=getAddress(detail.instance);
const probeHash=/RECEIPT sandwich probe (0x[0-9a-fA-F]{64})/.exec(log)?.[1] as Hex;
const chain=liveChain(84532),{publicClient:pc,contexts:[c]}=liveContexts(chain,[keyFromEnvFile(key)]);
if(await pc.getChainId()!==84532)throw Error('RPC chain mismatch');
const probe=(await pc.getTransactionReceipt({hash:probeHash})).contractAddress!;
const venue=getAddress(detail.params.venue),token=loadLocalAbi('MockUSDC'),strategyAbi=loadLocalAbi('StrategyProposal'),probeAbi=loadLocalAbi('TwapSandwichProbe');
let head=await pc.getBlockNumber();
async function read<T>(address:Address,abi:Abi,functionName:string,args:readonly unknown[]=[]){const latest=await pc.getBlockNumber({cacheTime:0});if(latest>head)head=latest;return awaitRead(()=>pc.readContract({address,abi,functionName,args,blockNumber:head} as never) as Promise<T>,()=>true);}
async function tx(address:Address,abi:Abi,functionName:string,args:readonly unknown[],gas:bigint){const s=await simulateSettled<{request:Record<string,unknown>}>(c!,{address,abi,functionName,args});const r=await writeAndWait(c!,{...s.request,gas});head=r.receipt.blockNumber;console.log(`RECEIPT ${functionName} tx=${r.hash} block=${head}`);return r;}
const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);console.log(`ASSERT ${label}`);};
// The original two-buy print fixture has no cash left. A disclosed one-USDC donation makes
// another permissionless buy possible, while a >50% asset spot fall crosses its portfolio threshold.
await tx(p.settlement,token,'transfer',[strategy,1_000_000n],200_000n);
const held=await read<bigint>(p.asset,token,'balanceOf',[strategy]);
const cash=await read<bigint>(p.settlement,token,'balanceOf',[strategy]);
const budget=await read<bigint>(strategy,strategyAbi,'budget');
const rule=await read<readonly bigint[]>(strategy,strategyAbi,'rule');
const threshold=budget*(10_000n-rule[4]!)/10_000n;
const stateBefore=await read(strategy,strategyAbi,'status');
const poolAbi=parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const before=(await read<readonly bigint[]>(p.pool,poolAbi,'slot0'))[0]!;
const assetIsToken0=BigInt(p.asset)<BigInt(p.settlement),direction=assetIsToken0;
const limit=direction?before*66n/100n:before*3n/2n;
const r=await tx(probe,probeAbi,'sandwich',[strategy,direction,limit,false],8_000_000n);
const event=r.receipt.logs.filter(l=>getAddress(l.address)===getAddress(probe)).map(l=>decodeEventLog({abi:probeAbi,data:l.data,topics:l.topics})).find(e=>e.eventName==='Sandwiched') as unknown as {args:{report:{priceBefore:bigint;priceDuring:bigint;valueBefore:bigint;valueDuring:bigint;sqrtBefore:bigint;sqrtDuring:bigint;sqrtAfter:bigint}}};
const x=event.args.report,unit=await read<bigint>(venue,loadLocalAbi('UniswapV3Venue'),'assetUnit');
const spotPrice=assetIsToken0?x.sqrtDuring*x.sqrtDuring*unit/(1n<<192n):(1n<<192n)*unit/(x.sqrtDuring*x.sqrtDuring);
const hypotheticalSpotValue=cash+held*spotPrice/unit;
check(hypotheticalSpotValue<=threshold&&x.valueBefore>threshold,'spot portfolio crosses the voted stop-loss while TWAP portfolio remains above it');
check(x.priceBefore===x.priceDuring&&x.valueBefore===x.valueDuring,'same-transaction manipulation leaves TWAP price and value unchanged');
check(await read(strategy,strategyAbi,'status')===stateBefore&&await read<bigint>(p.asset,token,'balanceOf',[strategy])>held&&await read<bigint>(p.settlement,token,'balanceOf',[strategy])===0n,'run bought with the donated cash and did not fire a false stop-loss');
const result={chainId:84532,hash:r.hash,blockNumber:String(r.receipt.blockNumber),readBlockNumber:String(head),strategy,probe,donation:'1000000',held,cash,threshold,spotPrice,hypotheticalSpotValue,report:x,result:'PASS'};
writeFileSync(`${dir}/K/spot-threshold.json`,JSON.stringify(result,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
console.log('NATIVE SPOT THRESHOLD COUNTEREXAMPLE PASS');
