#!/usr/bin/env python3
"""Zero One T1 helper: Python standard library only. Builds the exact sponsored GET URL for one signed intent.
Pure-Python curve arithmetic is not constant-time: use a key that holds nothing but Zero One shares. Keep the key file 0600.
"""
import re,argparse, base64, hashlib, hmac, json, os, secrets, sys, time, urllib.parse, urllib.request
CHAIN_ID={{CHAIN_ID}}
SETTLEMENT='{{SETTLEMENT}}'
ORIGIN='{{ORIGIN}}'
P=2**256-2**32-977
N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G=(0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
RC=[0x1,0x8082,0x800000000000808a,0x8000000080008000,0x808b,0x80000001,0x8000000080008081,0x8000000000008009,0x8a,0x88,0x80008009,0x8000000a,0x8000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x800a,0x800000008000000a,0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008]
ROT=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]
MASK=2**64-1

def keccak(data):
    length=len(data);data=bytearray(data)+bytearray(136-length%136)
    data[length]=1;data[-1]|=128;a=[0]*25
    def rot(x,n):return ((x<<n)|(x>>(64-n)))&MASK
    for offset in range(0,len(data),136):
        for j in range(17):a[j]^=int.from_bytes(data[offset+j*8:offset+j*8+8],'little')
        for rc in RC:
            c=[a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            d=[c[(x-1)%5]^rot(c[(x+1)%5],1) for x in range(5)]
            a=[v^d[j%5] for j,v in enumerate(a)];b=[0]*25
            for x in range(5):
                for y in range(5):b[y+5*((2*x+3*y)%5)]=rot(a[x+5*y],ROT[x+5*y])
            a=[b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]) for y in range(5) for x in range(5)]
            a[0]^=rc
    return b''.join(x.to_bytes(8,'little') for x in a)[:32]

def add(a,b):
    if a is None:return b
    if b is None:return a
    x,y=a;u,v=b
    if x==u and (y+v)%P==0:return None
    s=((3*x*x)*pow(2*y,-1,P) if a==b else (v-y)*pow(u-x,-1,P))%P
    z=(s*s-x-u)%P
    return z,(s*(x-z)-y)%P

def mul(n,a=G):
    r=None
    while n:
        if n&1:r=add(r,a)
        a=add(a,a);n>>=1
    return r

def word(v):return int(v,16).to_bytes(32,'big') if isinstance(v,str) and v.startswith('0x') else int(v).to_bytes(32,'big')
def hexbytes(h):return bytes.fromhex(str(h)[2:] if str(h).startswith('0x') else str(h))
def address(key):return '0x'+keccak(b''.join(word(x) for x in mul(key)))[12:].hex()
def sign(key,digest):
    z=int.from_bytes(digest,'big');v=b'\1'*32;k=b'\0'*32
    material=word(key)+word(z%N)
    def mac(k,v):return hmac.new(k,v,hashlib.sha256).digest()
    k=mac(k,v+b'\0'+material);v=mac(k,v);k=mac(k,v+b'\1'+material);v=mac(k,v)
    while True:
        v=mac(k,v);nonce=int.from_bytes(v,'big')
        if 0<nonce<N:
            x,y=mul(nonce);r=x%N;s=(pow(nonce,-1,N)*(z+r*key))%N
            if r and s and x<N:
                parity=y&1
                if s>N//2:s=N-s;parity^=1
                return '0x'+(word(r)+word(s)+bytes([27+parity])).hex()
        k=mac(k,v+b'\0');v=mac(k,v)

def rlp(v):
    if isinstance(v,list):
        b=b''.join(rlp(x) for x in v);return bytes([192+len(b)])+b
    if isinstance(v,int):v=v.to_bytes((v.bit_length()+7)//8,'big')
    if len(v)==1 and v[0]<128:return v
    return bytes([128+len(v)])+v
TYPE=b'Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)'
def digest(m,adapter):
    domain=keccak(keccak(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')+keccak(b'ZeroOneIntent')+keccak(b'1')+word(CHAIN_ID)+word(adapter))
    struct=keccak(keccak(TYPE)+word(m['member'])+word(m['op'])+word(m['proposalId'])+word(m['amount'])+word(m['evidenceHash'])+keccak(hexbytes(m['data']))+keccak(m['details'].encode())+word(m['nonce'])+word(m['deadline']))
    return keccak(b'\x19\x01'+domain+struct)
def personal(text):
    raw=text.encode();return keccak(b'\x19Ethereum Signed Message:\n'+str(len(raw)).encode()+raw)
def address_array(items):return '0x'+(word(32)+word(len(items))+b''.join(word(a) for a in items)).hex()
def work_data(verifiers,threshold,reward,expiration):return '0x'+(word(128)+word(threshold)+word(reward)+word(expiration)+word(len(verifiers))+b''.join(word(a) for a in verifiers)).hex()
def b64(o):return base64.urlsafe_b64encode(json.dumps(o,separators=(',',':')).encode()).decode().rstrip('=')
OPS={'propose':0,'vote':2,'execute':3,'ragequit':4,'deposit':5,'work':6,'task':7,'deliver':8,'confirm':9}
TEMPLATES={'Payment':0,'Strategy':1,'Project':2,'Config':3}
def load_key(path):
    if not os.path.exists(path):
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:f.write(f'{secrets.randbelow(N-1)+1:064x}\n')
    if os.path.islink(path) or os.stat(path).st_mode&0o077:raise ValueError('key must be a regular private file (chmod 600)')
    with open(path) as f:key=int(f.read().strip().replace('0x',''),16)
    if not 0<key<N:raise ValueError('invalid key')
    return key
def get(base,path):
    for attempt in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(base+path,headers={'User-Agent':'zero-one-snippet/1.0 Python'}),timeout=90) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code<500 and e.code!=429 or attempt==7:raise ValueError('GET '+path+' HTTP '+str(e.code)+' '+e.read().decode(errors='replace'))
            time.sleep(3*(attempt+1))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('op',choices=['address','join','deposit','task','deliver','propose','vote','execute','ragequit','work','confirm','hash','selftest'])
    for name in ['key','base','usdc','amount','proposal','approve','task','evidence','evidence-hash','template','params','summary','verifiers','threshold','reward-shares','details','expiration','tokens','deadline','salt']:p.add_argument('--'+name)
    a=p.parse_args();base=a.base or ORIGIN
    if a.op=='hash':print('0x'+keccak((a.evidence or '').encode()).hex());return
    if a.op=='selftest':
        assert address(1)=='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf' and keccak(b'').hex()=='c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';print('Python keccak and curve vectors PASS');return
    key=load_key(a.key or './agent.key');addr=address(key)
    if a.op=='address':print(addr);return
    print(addr,file=sys.stderr)
    state=get(base,'/me/'+addr+'.json')
    if state['chainId']!=CHAIN_ID:raise ValueError('wrong chain')
    def authorization():
        h=keccak(b'\x05'+rlp([CHAIN_ID,hexbytes(state['adapter']),state['authorizationNonce']]));sig=hexbytes(sign(key,h))
        return {'chainId':CHAIN_ID,'address':state['adapter'],'nonce':state['authorizationNonce'],'r':'0x'+sig[:32].hex(),'s':'0x'+sig[32:64].hex(),'yParity':sig[64]-27}
    if a.op=='join':
        if state['delegated']:print('already joined',file=sys.stderr)
        print(base+'/relay?op=join&authorization='+b64(authorization()));return
    def need(n):
        v=getattr(a,n.replace('-','_'))
        if v is None:raise ValueError('--'+n+' is required for '+a.op)
        return v
    m={'member':addr,'op':OPS[a.op],'proposalId':0,'amount':'0','evidenceHash':'0x'+'0'*64,'data':'0x','details':'','nonce':str(state['nonce']),'deadline':a.deadline or str(state['chainTime']+900)}
    if a.op=='deposit':m['amount']=str(int(round(float(a.usdc)*1000000))) if a.usdc is not None else need('amount')
    if a.op=='vote':
        m['proposalId']=int(need('proposal'));ap=need('approve').lower()
        if ap not in('yes','no'):raise ValueError('--approve yes|no')
        m['amount']='1' if ap=='yes' else '0'
    if a.op=='execute':
        m['proposalId']=int(need('proposal'));plist=get(base,'/proposals.json')
        found=[x for x in plist['proposals'] if x['id']==m['proposalId']]
        if not found:raise ValueError('unknown proposal')
        m['data']=found[0]['proposalData']
    if a.op=='ragequit':
        m['amount']=a.amount if a.amount and a.amount!='all' else str(state['shares']);m['data']=address_array((a.tokens or SETTLEMENT).split(','))
    if a.op=='task':m['amount']=need('task')
    if a.op=='deliver':m['amount']=need('task');m['evidenceHash']=a.evidence_hash or '0x'+keccak(need('evidence').encode()).hex()
    if a.op=='confirm':m['amount']=need('task');m['data']='0x'+need('evidence').encode().hex()
    if a.op=='work':
        v=need('verifiers').split(',');m['data']=work_data(v,int(a.threshold or len(v)),need('reward-shares'),int(a.expiration or 0));m['details']=a.details or ''
    if a.op=='propose':
        template=need('template');params=need('params')
        if template not in TEMPLATES:raise ValueError('--template Payment|Strategy|Project|Config')
        salt=a.salt or '0x'+word(state['nonce']).hex()
        if not re.fullmatch(r'0x[0-9a-f]{64}',salt):raise ValueError('--salt must be 32 bytes hex')
        q=get(base,'/relay?op=quote&member='+addr+'&template='+urllib.parse.quote(template)+'&params='+urllib.parse.quote(params)+'&summary='+urllib.parse.quote(a.summary or '')+'&salt='+salt)
        print(json.dumps({k:q.get(k) for k in('instance','exists','codeHash','paramsHash','operator','budgetUsdc','canPropose')}),file=sys.stderr)
        # Check the quoted intent before signing: data = abi.encode(uint8 template, bytes params, bytes32 salt); the account rebuilds the instance from it.
        d=hexbytes(q['message']['data']);num=lambda b:int.from_bytes(b,'big');off=num(d[32:64]);ln=num(d[off:off+32]);pb=d[off+32:off+32+ln]
        if num(d[:32])!=TEMPLATES[template] or '0x'+d[64:96].hex()!=salt or '0x'+keccak(pb).hex()!=q['paramsHash'] or q['paramsHash'] not in q['details'] or q['codeHash'] not in q['details'] or q['message']['op']!=0:raise ValueError('quote does not match the request')
        if template=='Payment':
            pj=json.loads(params);n=len(pj['recipients'])
            enc=word(64)+word(96+32*n)+word(n)+b''.join(word(x) for x in pj['recipients'])+word(n)+b''.join(word(x) for x in pj['amounts'])
            if enc!=pb:raise ValueError('Payment params were not encoded as given')
        m.update(q['message']);m['member']=addr;m['nonce']=str(state['nonce'])
        if a.deadline:m['deadline']=a.deadline
    env={'message':m,'signature':sign(key,digest(m,state['adapter']))}
    if not state['delegated']:env['authorization']=authorization()
    print(base+'/relay?intent='+b64(env))
if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Snippet could not build the intent: '+str(e),file=sys.stderr);sys.exit(1)
