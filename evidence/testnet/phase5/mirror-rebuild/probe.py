"""Read-only origin probes; retain HTTP headers and assertions, never relay state."""
import concurrent.futures, difflib, hashlib, json, pathlib, re, subprocess, tempfile, urllib.parse
ROOT = pathlib.Path(__file__).resolve().parent
MIRROR = 'https://zero-one-beacon.vercel.app'
CANONICAL = 'https://relay-zero.mkyang.ai'
MEMBER = '0x321D04C0ED837304F90162e55e76317378038fF2'
TYPES = {'txt':r'^text/plain\b','js':r'^(text|application)/javascript\b','py':r'^(text/(x-python|plain)|application/(x-python|octet-stream))\b','md':r'^text/(markdown|x-markdown|plain)\b','json':r'^application/json\b','html':r'^text/html\b'}
TMP = pathlib.Path(tempfile.mkdtemp(prefix='mirror-rebuild-probes-'))
def probe(item):
    label,url,kind,expected = item
    body = TMP / label
    headers = ROOT / (label+'.headers')
    run = subprocess.run(['curl','-sS','--max-time','60','-D',str(headers),'-o',str(body),'-w','%{http_code}',url],capture_output=True,text=True)
    text = body.read_text() if body.exists() else ''
    h = headers.read_text() if headers.exists() else ''
    ct = re.findall(r'^content-type:\s*(.*)$',h,re.I|re.M)
    status = int(run.stdout) if run.stdout.isdigit() else 0
    challenge = bool(re.search(r'x-vercel-mitigated:|cf-mitigated:|Security Checkpoint|Just a moment',h+'\n'+text[:4000],re.I))
    row = dict(url=url,status=status,expectedStatus=expected,contentType=ct[-1].strip() if ct else '',challenge=challenge,headers=headers.name,sha256=hashlib.sha256(text.encode()).hexdigest())
    row['ok'] = run.returncode == 0 and status == expected and bool(re.search(TYPES[kind],row['contentType'])) and not challenge
    if kind == 'json' and not challenge:
        try:
            parsed = json.loads(text)
            if label == 'member':
                row['custody'] = parsed.get('custody')
                row['ok'] &= row['custody'] == 'custodial-lite' and parsed.get('address','').lower() == MEMBER.lower()
        except ValueError: row['ok'] = False
    if label in ('canonical-after','mirror-after') and row['ok']:
        (ROOT/(label+'.txt')).write_text(text)
    return row
items = [(label,MIRROR+target,kind,200) for label,target,kind in [
('mirror-after','/README.txt','txt'),('llms','/llms.txt','txt'),('snippet-js','/snippet.js','js'),('snippet-py','/snippet.py','py'),('constitution','/CONSTITUTION.md','md'),('robots','/robots.txt','txt'),('dashboard','/','html'),('health','/health.json','json'),('state','/state.json','json'),('proposals','/proposals.json','json'),('pending','/pending.json','json'),('member','/me/'+MEMBER+'.json','json'),('self-custody','/me/0x00000000000000000000000000000000c0ffee01.json','json'),('me-bare','/me','json')]]
# A synthetic, unregistered pass hash tests the advertised route without reading a secret or creating an account.
items.append(('pass-route',MIRROR+'/me/pass/'+'0'*64+'.json','json',404))
items.append(('quote',MIRROR+'/relay?'+urllib.parse.urlencode(dict(op='quote',member=MEMBER,template='Payment',params=json.dumps(dict(recipients=[MEMBER],amounts=['1000000'])),summary='mirror rebuild read only probe')),'json',200))
items.append(('canonical-after',CANONICAL+'/README.txt','txt',200))
constitution = re.search(r'Constitution (https://\S+) keccak256', (ROOT/'canonical-before.txt').read_text()).group(1)
items.append(('published-constitution',constitution,'txt',200))
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: rows=list(pool.map(probe,items))
    for row in rows: print(json.dumps(row))
    a,b=(ROOT/'canonical-after.txt').read_text(),(ROOT/'mirror-after.txt').read_text()
    (ROOT/'after.diff').write_text(''.join(difflib.unified_diff(a.splitlines(True),b.splitlines(True),fromfile='canonical/README.txt',tofile='mirror/README.txt')))
    normalize=lambda s:s.replace(CANONICAL,'<ORIGIN>').replace(MIRROR,'<ORIGIN>')
    normalized=normalize(a)==normalize(b)
    built=b==pathlib.Path('beacon/public-mirror-rebuild/README.txt').read_text()
    summary=dict(probes=rows,readmeOriginOnlyDiff=normalized,servedMatchesBuild=built,passed=sum(r['ok'] for r in rows),total=len(rows))
    (ROOT/'assertions.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(f"README origin-only diff: {normalized}; served matches build: {built}; HTTP assertions: {summary['passed']}/{len(rows)}")
finally:
    TMP.rename(pathlib.Path.home()/'.Trash'/TMP.name)
