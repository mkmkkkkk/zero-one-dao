/** Finish the existing native template fixture: reject an EOA, allow a non-template contract. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { loadLocalAbi, loadBaalArtifact } from '../src/baal.js';
import { liveChain, liveContexts } from '../src/live.js';
import { awaitRead, simulateSettled, writeAndWait } from '../src/onchain.js';
import { submitCalls } from '../src/proposals.js';
import { settleRetention } from '../src/retention.js';
const root='evidence/testnet/phase5',records=`${root}/scenario-daos`;
const D=JSON.parse(readFileSync(`${records}/${readdirSync(records).filter(x=>x.startsWith('corner-templates-')).sort().at(-1)}`,'utf8'));
if(D.chainId!==84532||!process.env.ZERO_ONE_ACTORS_FILE)throw Error('explicit Sepolia actor fixture required');
const keys=JSON.parse(readFileSync(process.env.ZERO_ONE_ACTORS_FILE,'utf8'));
const chain=liveChain(84532),{publicClient:pc,contexts:[A,B]}=liveContexts(chain,[keys.A,keys.B]);
if(await pc.getChainId()!==84532)throw Error('RPC chain mismatch');
const log=readFileSync(`${root}/corner-cases.log`,'utf8');
function detail(prefix:string){const line=log.split('\n').find(s=>s.startsWith(`   details: ${prefix} `));if(!line)throw Error(prefix);return JSON.parse(line.slice(line.indexOf('{')));}
const source=detail('strategy for voted EOA migration').instance as Address;
const recipient=detail('ERC20 recipient without receive function').params.recipients[0] as Address;
const baal=loadBaalArtifact('Baal').abi,token=loadLocalAbi('MockUSDC'),strategy=loadLocalAbi('StrategyProposal');
let head=await pc.getBlockNumber({cacheTime:0});
async function read<T>(address:Address,abi:Abi,functionName:string,args:readonly unknown[]=[]){const n=await pc.getBlockNumber({cacheTime:0});if(n>head)head=n;return awaitRead(()=>pc.readContract({address,abi,functionName,args,blockNumber:head} as never) as Promise<T>,()=>true);}
const balance=(address:Address)=>read<bigint>(D.settlement,token,'balanceOf',[address]);
const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);console.log('ASSERT '+label);};
const rejectedHash='0x897253bcb2090dea69f2ef93178551a590a6ebfa1a94c37f1890e0d7563d6e54' as Hex;
const rejected=await pc.getTransactionReceipt({hash:rejectedHash});
const flags=await read<readonly boolean[]>(D.baal,baal,'getProposalStatus',[6]);
check(rejected.status==='success'&&flags[1]&&flags[2]&&flags[3]&&await balance(source)===100_000_000n,'mined EOA migration is actionFailed and leaves all 100 USDC in the source');
let decoded=false;try{await pc.simulateContract({address:source,abi:strategy,functionName:'migrate',args:[D.actors.O],account:D.safe,blockNumber:head} as never);}catch(e){decoded=e instanceof Error&&e.message.includes('NotAContract');}
check(decoded,'EOA refusal decodes NotAContract');console.log(`RECEIPT EOA refusal tx=${rejectedHash}`);
const before=await balance(recipient);
const proposal=await submitCalls(A!,D,[{to:source,data:encodeFunctionData({abi:strategy,functionName:'migrate',args:[recipient]})}],'phase5: non-template contract migration after EOA refusal');
console.log(`RECEIPT migration proposal tx=${proposal.submitHash} id=${proposal.id}`);
head=(await pc.getTransactionReceipt({hash:proposal.submitHash})).blockNumber;
const info=await read<readonly unknown[]>(D.baal,baal,'proposals',[proposal.id]),starts=Number(info[2]),ends=Number(info[4]);
while(Number((await pc.getBlock()).timestamp)<=starts)await new Promise(r=>setTimeout(r,2000));
for(const c of [A!,B!]){const s=await simulateSettled<{request:Record<string,unknown>}>(c,{address:D.baal,abi:baal,functionName:'submitVote',args:[proposal.id,true]});const r=await writeAndWait(c,s.request);head=r.receipt.blockNumber;console.log(`RECEIPT vote tx=${r.hash}`);}
while(Number((await pc.getBlock()).timestamp)<=ends){console.log(`WAIT real grace until ${new Date((ends+1)*1000).toISOString()}`);await new Promise(r=>setTimeout(r,30000));}
await settleRetention(A!,D.shares,proposal.id);
const s=await simulateSettled<{request:Record<string,unknown>}>(A!,{address:D.baal,abi:baal,functionName:'processProposal',args:[proposal.id,proposal.data],gas:5_000_000n});
const done=await writeAndWait(A!,{...s.request,gas:5_000_000n});head=done.receipt.blockNumber;console.log(`RECEIPT contract migration tx=${done.hash}`);
const afterFlags=await read<readonly boolean[]>(D.baal,baal,'getProposalStatus',[proposal.id]);
check(afterFlags[1]&&afterFlags[2]&&!afterFlags[3]&&await balance(source)===0n&&await balance(recipient)===before+100_000_000n,'voted migration to a non-template contract moves exactly 100 USDC');
writeFileSync(`${root}/migration-followup.json`,JSON.stringify({chainId:84532,baal:D.baal,source,recipient,eoaRefusal:rejectedHash,contractMigration:done.hash,proposalId:proposal.id,recipientBefore:String(before),recipientAfter:String(await balance(recipient)),result:'PASS'},null,2)+'\n');
console.log('NATIVE MIGRATION CORNERS PASS');
