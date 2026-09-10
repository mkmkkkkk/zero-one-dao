/** Disposable loopback relay against a fresh phase-5 Sepolia corner DAO; always stops its child. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readdirSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

const evidence='evidence/testnet/phase5';
const records=path.join(evidence,'scenario-daos');
const deployment=path.join(records,readdirSync(records).filter(x=>x.startsWith('corner-money-')).sort().at(-1)!);
const d=JSON.parse(readFileSync(deployment,'utf8'));
if(d.chainId!==84532)throw Error('Sepolia only');
let port=18871;
for(;;){const probe=createServer();try{await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise<void>(resolve=>probe.close(()=>resolve()));break;}catch{port++;}}
const origin=`http://127.0.0.1:${port}`,state='state/relay-phase5-contract-corners',beacon='beacon/public-phase5-corners';
const env={...process.env,ZERO_ONE_DEPLOYMENT:deployment,ZERO_ONE_ORIGIN:origin,RELAY_ENV_FILE:'state/relay-phase5-corners-sponsor.env',RELAY_STATE_DIR:state,RELAY_BEACON_DIR:beacon,RELAY_PORT:String(port),ZERO_ONE_CORNER_EVIDENCE:evidence};
mkdirSync(state,{recursive:true,mode:0o700});
async function command(args:string[],file:string){const fd=openSync(file,'a');const p=spawn(process.execPath,['--import','tsx',...args],{env,stdio:['ignore',fd,fd]});try{const [code]=await once(p,'exit');if(code!==0)throw Error(`${args[0]} exited ${code}; ${file}`);}finally{closeSync(fd);}}
await command(['beacon/scripts/build.ts','--deployment',deployment,'--origin',origin,'--out',beacon],`${evidence}/relay-corners-build.log`);
const fd=openSync(`${evidence}/relay-corners-server.log`,'a');
let server:ChildProcess|undefined;
try{
 server=spawn(process.execPath,['--import','tsx','relay/server.ts'],{env,stdio:['ignore',fd,fd]});
 const stop=()=>server?.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let ready=false;
 for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('relay exited');try{const r=await fetch(`${origin}/health.json`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
 if(!ready)throw Error('temporary relay did not become ready');
 console.log(`Temporary relay ${origin} DAO=${d.baal} state=${state}`);
 if(process.env.ZERO_ONE_RESUME_SPAM==='1')await command(['relay/phase5-spam-resume.ts'],`${evidence}/corner-cases-relay-spam-resume.log`);
 else await command(['relay/corner-cases-relay.ts','--beacon',origin,'--spam','100','--work','state/agent-phase5-relay-corners'],`${evidence}/corner-cases-relay.log`);
 console.log('NATIVE RELAY CORNERS PASS');
}finally{
 if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}
 closeSync(fd);console.log(`Temporary relay stopped: ${origin}`);
}
