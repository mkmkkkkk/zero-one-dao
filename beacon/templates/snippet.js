#!/usr/bin/env node
// Zero One T1 helper: Node built-ins only. Builds the exact sponsored GET URL for one signed intent.
// Variable-time arithmetic: use a key that holds nothing but Zero One shares. Keep the key file 0600.
const CHAIN_ID={{CHAIN_ID}};
const SETTLEMENT='{{SETTLEMENT}}';
const ORIGIN='{{ORIGIN}}';
(async()=>{
const fs=await import('node:fs'),crypto=await import('node:crypto');
const P=2n**256n-2n**32n-977n,N=BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const G=[BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8')];
const RC=['1','8082','800000000000808a','8000000080008000','808b','80000001','8000000080008081','8000000000008009','8a','88','80008009','8000000a','8000808b','800000000000008b','8000000000008089','8000000000008003','8000000000008002','8000000000000080','800a','800000008000000a','8000000080008081','8000000000008080','80000001','8000000080008008'].map(x=>BigInt('0x'+x));
const ROT=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14],MASK=2n**64n-1n;
const cat=(...a)=>Buffer.concat(a),word=x=>Buffer.from(BigInt(x).toString(16).padStart(64,'0'),'hex'),hexBytes=h=>Buffer.from(String(h).replace(/^0x/,''),'hex');
function keccak(input){
 const pad=136-input.length%136,data=cat(Buffer.from(input),Buffer.alloc(pad));data[input.length]=1;data[data.length-1]|=128;
 let a=Array(25).fill(0n);const rot=(x,n)=>((x<<BigInt(n))|(x>>BigInt(64-n)))&MASK;
 for(let offset=0;offset<data.length;offset+=136){
  for(let j=0;j<17;j++)a[j]^=data.readBigUInt64LE(offset+j*8);
  for(const rc of RC){
   const c=Array.from({length:5},(_,x)=>a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20]);
   const d=c.map((_,x)=>c[(x+4)%5]^rot(c[(x+1)%5],1));a=a.map((v,j)=>v^d[j%5]);
   const b=Array(25).fill(0n);for(let x=0;x<5;x++)for(let y=0;y<5;y++)b[y+5*((2*x+3*y)%5)]=rot(a[x+5*y],ROT[x+5*y]);
   for(let y=0;y<5;y++)for(let x=0;x<5;x++)a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);a[0]^=rc;
  }
 }
 const out=Buffer.alloc(200);a.forEach((x,i)=>out.writeBigUInt64LE(x,i*8));return out.subarray(0,32);
}
const mod=(v,p=P)=>(v%p+p)%p;
function inv(v,p=P){let a=mod(v,p),b=p,x=1n,y=0n;while(b){const q=a/b;[a,b]=[b,a-q*b];[x,y]=[y,x-q*y];}if(a!==1n)throw Error('noninvertible');return mod(x,p);}
function add(a,b){if(!a)return b;if(!b)return a;const [x,y]=a,[u,v]=b;if(x===u&&mod(y+v)===0n)return null;const s=mod(x===u?3n*x*x*inv(2n*y):(v-y)*inv(u-x));const z=mod(s*s-x-u);return [z,mod(s*(x-z)-y)];}
function mul(n,a=G){let r=null;while(n){if(n&1n)r=add(r,a);a=add(a,a);n>>=1n;}return r;}
const address=k=>'0x'+keccak(cat(...mul(k).map(word))).subarray(12).toString('hex');
function sign(key,hash){
 const z=BigInt('0x'+hash.toString('hex')),material=cat(word(key),word(z%N));let v=Buffer.alloc(32,1),k=Buffer.alloc(32);
 const mac=(k,v)=>crypto.createHmac('sha256',k).update(v).digest();
 k=mac(k,cat(v,Buffer.from([0]),material));v=mac(k,v);k=mac(k,cat(v,Buffer.from([1]),material));v=mac(k,v);
 for(;;){v=mac(k,v);const nonce=BigInt('0x'+v.toString('hex'));if(nonce>0n&&nonce<N){const [x,y]=mul(nonce),r=x%N;let s=mod(inv(nonce,N)*(z+r*key),N),parity=Number(y&1n);if(r&&s&&x<N){if(s>N/2n){s=N-s;parity^=1;}return '0x'+cat(word(r),word(s),Buffer.from([27+parity])).toString('hex');}}k=mac(k,cat(v,Buffer.from([0])));v=mac(k,v);}
}
function rlp(v){if(Array.isArray(v)){const b=cat(...v.map(rlp));return cat(Buffer.from([192+b.length]),b);}if(typeof v==='number'){let h=v.toString(16);if(h.length%2)h='0'+h;v=v?Buffer.from(h,'hex'):Buffer.alloc(0);}if(v.length===1&&v[0]<128)return v;return cat(Buffer.from([128+v.length]),v);}
const h=s=>keccak(Buffer.from(s));
const TYPE='Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)';
function digest(m,adapter){const domain=keccak(cat(h('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),h('ZeroOneIntent'),h('1'),word(CHAIN_ID),word(adapter)));const struct=keccak(cat(h(TYPE),word(m.member),word(m.op),word(m.proposalId),word(m.amount),word(m.evidenceHash),keccak(hexBytes(m.data)),keccak(Buffer.from(m.details,'utf8')),word(m.nonce),word(m.deadline)));return keccak(cat(Buffer.from('1901','hex'),domain,struct));}
const personal=text=>keccak(cat(Buffer.from('\x19Ethereum Signed Message:\n'+Buffer.byteLength(text)),Buffer.from(text)));
const addressArray=list=>'0x'+word(32).toString('hex')+word(list.length).toString('hex')+list.map(a=>word(a).toString('hex')).join('');
const workData=(verifiers,threshold,reward,expiration)=>'0x'+[word(128),word(threshold),word(reward),word(expiration),word(verifiers.length),...verifiers.map(word)].map(b=>b.toString('hex')).join('');
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const OPS={propose:0,vote:2,execute:3,ragequit:4,deposit:5,work:6,task:7,deliver:8,confirm:9},TEMPLATES={Payment:0,Strategy:1,Project:2,Config:3};
const argv=process.argv.slice(2),op=argv.shift(),args={key:'./agent.key',base:ORIGIN};
while(argv.length){const name=argv.shift();if(!name.startsWith('--')||!argv.length)throw Error('Expected --name value');args[name.slice(2)]=argv.shift();}
if(op==='hash'){console.log('0x'+h(args['evidence']||'').toString('hex'));return;}
if(op==='selftest'){if(address(1n)!=='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'||h('').toString('hex')!=='c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')throw Error('vector');console.log('JavaScript keccak and curve vectors PASS');return;}
const VERBS=['address','join','deposit','task','deliver','propose','vote','execute','ragequit','work','confirm'];
if(!VERBS.includes(op))throw Error('Usage: node snippet.js '+VERBS.join('|')+' --key FILE [--usdc N | --amount RAW] [--proposal ID --approve yes|no] [--task ID --evidence TEXT] [--template T --params JSON] [--verifiers a,b --threshold N --reward-shares RAW --details TEXT]');
if(!fs.existsSync(args.key)){let k;do{k=BigInt('0x'+Buffer.from(crypto.webcrypto.getRandomValues(new Uint8Array(32))).toString('hex'));}while(k===0n||k>=N);fs.writeFileSync(args.key,k.toString(16).padStart(64,'0')+'\n',{mode:0o600,flag:'wx'});}
if(fs.lstatSync(args.key).isSymbolicLink()||(fs.statSync(args.key).mode&0o077))throw Error('key file must be private (chmod 600)');
const key=BigInt('0x'+fs.readFileSync(args.key,'utf8').trim().replace(/^0x/,''));if(key<=0n||key>=N)throw Error('invalid key');const addr=address(key);
if(op==='address'){console.log(addr);return;}console.error(addr);
async function get(path){let r;for(let attempt=0;;attempt++){r=await fetch(args.base+path,{headers:{'User-Agent':'zero-one-snippet/1.0 JavaScript'}});if(r.ok||attempt>=7||(r.status<500&&r.status!==429))break;await new Promise(res=>setTimeout(res,3000*(attempt+1)));}const text=await r.text();if(!r.ok)throw Error('GET '+path+' HTTP '+r.status+' '+text.trim());return JSON.parse(text);}
const state=await get('/me/'+addr+'.json');if(state.chainId!==CHAIN_ID)throw Error('wrong chain');
const authorization=()=>{const hash=keccak(cat(Buffer.from([5]),rlp([CHAIN_ID,hexBytes(state.adapter),state.authorizationNonce]))),sig=hexBytes(sign(key,hash));return {chainId:CHAIN_ID,address:state.adapter,nonce:state.authorizationNonce,r:'0x'+sig.subarray(0,32).toString('hex'),s:'0x'+sig.subarray(32,64).toString('hex'),yParity:sig[64]-27};};
if(op==='join'){if(state.delegated){console.error('already joined');}console.log(args.base+'/relay?op=join&authorization='+b64(authorization()));return;}
const zero32='0x'+'0'.repeat(64);
const m={member:addr,op:OPS[op],proposalId:0,amount:'0',evidenceHash:zero32,data:'0x',details:'',nonce:String(state.nonce),deadline:args.deadline||String(state.chainTime+900)};
const need=n=>{if(args[n]===undefined)throw Error('--'+n+' is required for '+op);return args[n];};
if(op==='deposit')m.amount=args.usdc!==undefined?String(BigInt(Math.round(Number(args.usdc)*1e6))):need('amount');
if(op==='vote'){m.proposalId=Number(need('proposal'));const a=String(need('approve')).toLowerCase();if(!['yes','no'].includes(a))throw Error('--approve yes|no');m.amount=a==='yes'?'1':'0';}
if(op==='execute'){m.proposalId=Number(need('proposal'));const list=await get('/proposals.json');const p=list.proposals.find(x=>x.id===m.proposalId);if(!p)throw Error('unknown proposal');m.data=p.proposalData;}
if(op==='ragequit'){m.amount=args.amount&&args.amount!=='all'?args.amount:String(state.shares);m.data=addressArray((args.tokens||SETTLEMENT).split(','));}
if(op==='task')m.amount=need('task');
if(op==='deliver'){m.amount=need('task');m.evidenceHash=args['evidence-hash']||('0x'+h(need('evidence')).toString('hex'));}
if(op==='confirm'){m.amount=need('task');m.data='0x'+Buffer.from(need('evidence'),'utf8').toString('hex');}
if(op==='work'){const v=need('verifiers').split(',');m.data=workData(v,Number(args.threshold||v.length),need('reward-shares'),Number(args.expiration||0));m.details=args.details||'';}
if(op==='propose'){
 const template=need('template'),params=need('params');if(TEMPLATES[template]===undefined)throw Error('--template Payment|Strategy|Project|Config');
 const salt=args.salt||'0x'+word(state.nonce).toString('hex');if(!/^0x[0-9a-f]{64}$/.test(salt))throw Error('--salt must be 32 bytes hex');
 const q=await get('/relay?op=quote&member='+addr+'&template='+encodeURIComponent(template)+'&params='+encodeURIComponent(params)+'&summary='+encodeURIComponent(args.summary||'')+'&salt='+salt);
 console.error(JSON.stringify({instance:q.instance,exists:q.exists,codeHash:q.codeHash,paramsHash:q.paramsHash,operator:q.operator,budgetUsdc:q.budgetUsdc,canPropose:q.canPropose}));
 // Check the quoted intent before signing: data = abi.encode(uint8 template, bytes params, bytes32 salt); the account rebuilds the instance from it.
 const d=hexBytes(q.message.data),num=b=>Number('0x'+b.toString('hex')),off=num(d.subarray(32,64)),len=num(d.subarray(off,off+32)),pb=d.subarray(off+32,off+32+len);
 if(num(d.subarray(0,32))!==TEMPLATES[template]||'0x'+d.subarray(64,96).toString('hex')!==salt||'0x'+keccak(pb).toString('hex')!==q.paramsHash||!q.details.includes(q.paramsHash)||!q.details.includes(q.codeHash)||q.message.op!==0)throw Error('quote does not match the request');
 if(template==='Payment'){const p=JSON.parse(params),n=p.recipients.length;const enc=[word(64),word(96+32*n),word(n),...p.recipients.map(word),word(n),...p.amounts.map(word)].map(b=>b.toString('hex')).join('');if(enc!==pb.toString('hex'))throw Error('Payment params were not encoded as given');}
 Object.assign(m,q.message,{member:addr,nonce:String(state.nonce)});m.deadline=args.deadline||m.deadline;
}
const env={message:m,signature:sign(key,digest(m,state.adapter))};
if(!state.delegated)env.authorization=authorization();
console.log(args.base+'/relay?intent='+b64(env));
})().catch(e=>{console.error('Snippet could not build the intent: '+(e&&e.message?e.message:e));process.exitCode=1;});
