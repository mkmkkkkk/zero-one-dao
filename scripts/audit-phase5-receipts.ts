/** Independent readback of native Sepolia deployment/scenario receipts; no credentials or writes. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, type Hex } from 'viem';
const root='evidence/testnet/phase5';
const client=createPublicClient({transport:http('https://sepolia.base.org',{retryCount:4,retryDelay:1500,timeout:60000}),cacheTime:0});
const expected=new Map<Hex,Set<string>>();
function add(hash:unknown,origin:string){if(typeof hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(hash))return;const key=hash.toLowerCase() as Hex;const origins=expected.get(key)??new Set<string>();origins.add(origin);expected.set(key,origins);}
function deployment(file:string){const d=JSON.parse(readFileSync(file,'utf8'));if(d.chainId!==84532)throw Error(`not Sepolia: ${file}`);for(const h of Object.values(d.txHashes??{}))add(h,file);for(const k of ['approveHash','depositHash'])add(d.genesis?.[k],file);add(d.sponsorFloat?.hash,file);}
deployment('deployments/base-sepolia.json');
for(const f of readdirSync(path.join(root,'scenario-daos')))if(f.endsWith('.json'))deployment(path.join(root,'scenario-daos',f));
// Only native-chain logs. Local regressions deliberately remain outside this receipt set.
for(const f of readdirSync(root)){
 if(!/^(scenarios-|scenario-K|phase5-contract-corners|corner-cases|cold-start-mini|[KL]-fund|corners.*fund|weth18-fund|relay-corners-(?:fund|topup)|actor-gas-topups|resume-actor-gas-topups|governance-).*\.log$/.test(f)||f.includes('-local-'))continue;
 const lines=readFileSync(path.join(root,f),'utf8').split('\n');
 for(const [i,line] of lines.entries()){
  const origin=`${f}:${i+1}`;
  for(const match of line.matchAll(/\btx(?:=|\s+[^\n]*?:\s*)(0x[0-9a-fA-F]{64})\b/g))add(match[1],origin);
  for(const match of line.matchAll(/\btx\s+(0x[0-9a-fA-F]{64})\b/g))add(match[1],origin);
  for(const match of line.matchAll(/\breceipt [^\n]*? deploy (0x[0-9a-fA-F]{64})\b/g))add(match[1],origin);
  for(const match of line.matchAll(/"(?:hash|deployHash|submitHash|voteHash)"\s*:\s*"(0x[0-9a-fA-F]{64})"/g))add(match[1],origin);
  for(const match of line.matchAll(/(?:receipt:\s*|Transaction reverted:\s*|Deployment failed for [^:]+:\s*)(0x[0-9a-fA-F]{64})/g))add(match[1],origin);
  if(/\bRECEIPT\b/.test(line))for(const match of line.matchAll(/0x[0-9a-fA-F]{64}\b/g))add(match[0],origin);
  if(line.startsWith('{'))try{const b=JSON.parse(line);for(const k of ['hash','voteHash'])add(b[k],origin);for(const k of ['faucet','deposit','eth','usdc'])add(b[k]?.hash,origin);for(const h of b.retentionHashes??[])add(h,origin);}catch{}
 }
}
const out=path.join(root,'receipt-readback.json');
const previous=existsSync(out)?JSON.parse(readFileSync(out,'utf8')):{receipts:[]};
const cache=new Map<string,Record<string,unknown>>(previous.receipts.filter((r:Record<string,unknown>)=>r.blockHash).map((r:Record<string,unknown>)=>[String(r.hash),r]));
const rows=[];let unknown=0;
if(await client.getChainId()!==84532)throw Error('RPC chain mismatch');
for(const [hash,origins] of expected){
 try{
  const old=cache.get(hash);
  const r=old??await client.getTransactionReceipt({hash});
  rows.push({...('transactionHash' in r?{hash:r.transactionHash,blockNumber:String(r.blockNumber),blockHash:r.blockHash,status:r.status,gasUsed:String(r.gasUsed),from:r.from,to:r.to,contractAddress:r.contractAddress,logs:Array.isArray(r.logs)?r.logs.length:0}:r),origins:[...origins]});
 }catch(e){unknown++;rows.push({hash,origins:[...origins],status:'unknown',error:e instanceof Error?e.message.slice(0,180):String(e)});}
 if(rows.length%25===0)console.log(`receipts read ${rows.length}/${expected.size}; unknown=${unknown}`);
}
const summary={chainId:84532,rpc:'https://sepolia.base.org',checkedAt:new Date().toISOString(),count:rows.length,success:rows.filter(r=>r.status==='success').length,reverted:rows.filter(r=>r.status==='reverted').length,unknown,receipts:rows};
writeFileSync(out,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({...summary,receipts:undefined}));
if(unknown)process.exitCode=1;
