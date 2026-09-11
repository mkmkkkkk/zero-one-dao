/** Complete the same phase-5 native 100-proposal fixture after its real sponsor-reserve refusal. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAddress } from 'viem';
import { fetchBeacon, fetchRetry, getJson, snippet, sleep, assert } from './agentio.js';
const root='evidence/testnet/phase5',workRoot='state/agent-phase5-relay-corners';
const work=path.resolve(workRoot,readdirSync(workRoot).sort().at(-1)!);
const {origin}=await fetchBeacon(process.env.ZERO_ONE_ORIGIN!,work);
const health=await getJson(`${origin}/health.json`);assert(health.chainId===84532,'Sepolia only');
const old=JSON.parse(readFileSync(path.join(root,'corner-cases-relay-2026-09-10.json'),'utf8'));
const log=readFileSync(path.join(root,'corner-cases-relay.log'),'utf8');
const initial=[...log.matchAll(/RECEIPT spam \d+ tx=(0x[0-9a-fA-F]{64})/g)].map(x=>x[1]!);
assert(initial.length===24&&new Set(initial).size===24,'initial fixture contains 24 distinct proposal receipts');
const checkpoint=path.join(root,'relay-spam-receipts.json');
const hashes:string[]=existsSync(checkpoint)?JSON.parse(readFileSync(checkpoint,'utf8')).hashes:initial;
assert(initial.every((h,i)=>hashes[i]===h)&&hashes.length<=100,'resume receipt prefix matches the same fixture');
const key=path.join(work,'agent.key');
const address=getAddress(execFileSync(process.execPath,[path.join(work,'snippet.js'),'address','--key',key],{encoding:'utf8',timeout:30000}).trim());
const params=JSON.stringify({recipients:[address],amounts:['1000000']});
const started=Date.now();let limited=0;
while(hashes.length<100){
 const i=hashes.length+1;
 const url=snippet('node',work,['propose','--key',key,'--template','Payment','--params',params,'--summary',`corner: spam ${i}`]);
 const r=await fetchRetry(url),body=await r.json() as Record<string,unknown>;
 if(r.status===429){limited++;await sleep(10000);continue;}
 assert(r.ok&&body.ok===true,`proposal ${i} accepted: ${r.status} ${body.reason??''}`);
 hashes.push(String(body.hash));console.log(`RECEIPT spam ${i} tx=${body.hash} deploy=${body.deployHash??'existing'}`);
 writeFileSync(checkpoint,JSON.stringify({chainId:84532,baal:health.baal,hashes},null,2)+'\n');
}
let all=await getJson(`${origin}/proposals.json`);
for(let attempt=0;Number(all.total)<102&&attempt<30;attempt++){await sleep(2000);all=await getJson(`${origin}/proposals.json`);}
const page=await getJson(`${origin}/proposals.json?limit=10`),open=await getJson(`${origin}/proposals.json?open=1&limit=5`);
const ok=new Set(hashes).size===100&&(page.proposals as unknown[]).length===10&&(open.proposals as unknown[]).length<=5&&Number(all.total)>=102;
assert(ok,'100 distinct accepted proposals and bounded pagination');
const updated=old.rows.map((r:Record<string,unknown>)=>r.id==='spam-100-proposals'?{...r,ok,observed:`100 distinct receipts across initial 24 plus resumed 76; total ${all.total}; page 10; open ${(open.proposals as unknown[]).length}`,receipt:hashes.at(-1)}:r);
const result={chainId:84532,baal:health.baal,at:new Date().toISOString(),sources:['corner-cases-relay.log','corner-cases-relay-spam-index-red.log','corner-cases-relay-spam-resume.log'],rows:updated,proposalHashes:hashes};
writeFileSync(path.join(root,'relay-corners-combined.json'),JSON.stringify(result,null,2)+'\n');
assert(updated.every((r:Record<string,unknown>)=>r.ok===true),'every phase5 relay corner has current-run evidence');
console.log(`NATIVE RELAY CORNERS PASS (${updated.length}/${updated.length}); 100 distinct proposal receipts`);
