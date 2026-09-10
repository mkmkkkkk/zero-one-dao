/** Standalone outside-agent harness: Node builtins + served README/snippet only; no repo imports. */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const opts=Object.fromEntries(process.argv.slice(2).reduce((rows,v,i,a)=>i%2?rows:[...rows,[v.replace(/^--/,''),a[i+1]]],[]));
const dir=resolve(opts.work??'cold-start-private');mkdirSync(dir,{recursive:true,mode:0o700});
const file=join(dir,'session.json');
const session=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{mode:opts.mode??'T1',stage:0,pass:randomBytes(32).toString('hex'),verifiers:[],createdAt:new Date().toISOString()};
const save=()=>writeFileSync(file,JSON.stringify(session),{mode:0o600});
const check=(value,label)=>{if(!value)throw Error(label);console.log(`ASSERT ${label}`);};
const redact=text=>[session.pass,...session.verifiers.map(x=>x.pass)].reduce((s,p)=>s.replaceAll(p,'[REDACTED]'),text);
async function fetchText(url){const r=await fetch(url,{signal:AbortSignal.timeout(90000)});const text=await r.text();console.log(`GET ${redact(url)} -> ${r.status}`);check(r.status===200,'HTTP 200');return text;}
const readme=await fetchText(`${opts.beacon??'https://relay-zero.mkyang.ai'}/README.txt`);
check(readme.trimEnd().split('\n').length<=44,'README <=44 lines');
const origin=/Relay (https?:\/\/\S+)\./.exec(readme)?.[1];check(origin,'origin discovered in served README');
check(/\(84532\)/.test(readme),'served README names Base Sepolia');
console.log(JSON.stringify({host:hostname(),mode:session.mode,at:new Date().toISOString(),origin,readmeSha256:createHash('sha256').update(readme).digest('hex'),stage:session.stage}));
writeFileSync(join(dir,'README.txt'),readme);
const snippetFile=join(dir,'snippet.js');
writeFileSync(snippetFile,await fetchText(`${origin}/snippet.js`));
console.log(execFileSync(process.execPath,[snippetFile,'selftest'],{encoding:'utf8'}).trim());
const keyFile=join(dir,'agent.key');
if(session.mode==='T1'&&!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
const document=async path=>JSON.parse(await fetchText(`${origin}${path}`));
async function get(url){const b=JSON.parse(await fetchText(url));console.log(redact(JSON.stringify(b)));check(b.ok===true,`relay accepted ${b.hash??''}`);return b;}
async function verb(op,fields={}){
 if(session.mode==='T0')return get(`${origin}/relay?${new URLSearchParams({op,pass:session.pass,...fields})}`);
 const aliases={proposalId:'proposal',amount:'amount',taskId:'task',rewardShares:'reward-shares'};
 const args=Object.entries(fields).flatMap(([k,v])=>['--'+(aliases[k]??k),String(v)]);
 const url=execFileSync(process.execPath,[snippetFile,op,'--key',keyFile,...args],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}).trim().split('\n').pop();
 check(url?.startsWith(origin+'/relay?'),'snippet generated a relay URL on discovered origin');return get(url);
}
async function verifier(op,v,fields={}){return get(`${origin}/relay?${new URLSearchParams({op,pass:v.pass,...fields})}`);}
async function ready(id){
 const p=(await document('/proposals.json')).proposals.find(p=>p.id===id);check(p,'proposal present');
 if(p.state!=='Ready'){
  check(['Voting','Grace'].includes(p.state),`proposal can still become ready: ${p.state}`);
  console.log(`BLOCKED real-chain governance: proposal=${id} state=${p.state} earliest=${new Date(p.graceEnds*1000).toISOString()}; rerun with the same private --work directory`);save();process.exitCode=2;return false;
 }return true;
}
save();
if(session.stage===0){
 const joined=await verb('join');session.address=joined.address??joined.member;
 if(session.mode==='T1')session.address=execFileSync(process.execPath,[snippetFile,'address','--key',keyFile],{encoding:'utf8'}).trim();
 else session.address=(await verifier('identity',{pass:session.pass})).address;
 const before=await document(`/me/${session.address}.json`);check(before.shares==='0','fresh account has zero shares');
 await verb('deposit',{amount:'100000000'});const me=await document(`/me/${session.address}.json`);check(BigInt(me.shares)>0n,'deposit minted shares');session.depositShares=me.shares;
 const p=await verb('propose',{template:'Payment',params:JSON.stringify({recipients:[session.address],amounts:['10000000']}),summary:'README-only cold-start payment'});session.payment=Number(p.proposalId);save();
 await verb('vote',{proposalId:String(session.payment),approve:'yes'});session.stage=1;save();
}
if(session.stage===1&&await ready(session.payment)){
 const r=await verb('execute',{proposalId:String(session.payment)});check(r.processed?.passed&&!r.processed.actionFailed,'payment executed');session.stage=2;save();
}
if(session.stage===2){
 if(session.verifiers.length===0){session.verifiers=[0,1].map(()=>({pass:randomBytes(32).toString('hex')}));save();}
 for(const v of session.verifiers){v.address=(await verifier('identity',v)).address;await verifier('join',v);}save();
 const r=await verb('work',{verifiers:session.verifiers.map(v=>v.address).join(','),threshold:'2',rewardShares:'5000000000000000000',details:'README-only task evidence'});session.task=r.task;save();
 await verb('vote',{proposalId:String(session.task.proposalId),approve:'yes'});session.stage=3;save();
}
if(session.stage===3&&await ready(session.task.proposalId)){
 const r=await verb('execute',{proposalId:String(session.task.proposalId)});check(r.processed?.passed&&!r.processed.actionFailed,'task activated');session.stage=4;save();
}
if(session.stage===4){
 const taskId=String(session.task.taskId), evidence=`README-only cold start on ${hostname()}`;
 await verb('task',{taskId});await verb('deliver',{taskId,evidence});
 for(const v of session.verifiers)await verifier('confirm',v,{taskId,evidence});
 const me=await document(`/me/${session.address}.json`);check(BigInt(me.shares)===BigInt(session.depositShares)+5000000000000000000n,'voted task minted exactly five shares');
 await verb('ragequit');check((await document(`/me/${session.address}.json`)).shares==='0','exit leaves zero shares');session.stage=5;save();
}
if(session.stage===5)console.log(`COLD START ${session.mode} PASS host=${hostname()} address=${session.address}`);
