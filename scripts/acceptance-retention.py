#!/usr/bin/env python3
"""Run the complete acceptance sequentially on owned devnets; preserve actual output and failures."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
os.chdir(root)
env = os.environ.copy()
env['HTTPS_PROXY'] = env.get('HTTPS_PROXY', 'http://127.0.0.1:7897')
env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost'
env.pop('ZERO_ONE_LIVE_DEPLOYMENT', None)
rpc = env.pop('FORK_RPC', 'https://mainnet.base.org')
# t15 is an untracked, obsolete lotCount prototype, not part of the branch's test set.
tests = sorted(str(p) for p in (root/'evidence/audit').glob('**/*.ts')
               if (p.name.startswith('t') and p.name[1:3].isdigit() and not p.name.startswith('t15-'))
               or (p.name.startswith('T') and p.name[1:3].isdigit())
               or p.name in ['intent-account.test.ts', 'relay-adversarial.test.ts',
                             'factory-create2-onlysafe.ts', 'project-config-edges.ts',
                             'strategy-price-reference.ts', 'work-invariants.ts'])
jobs = [(['npm','run',name], name=='scenarios') for name in
        ['compile','typecheck','scenarios','e2e:relay','e2e:entry-point','test:deploy-refusals']]
jobs += [(['node_modules/.bin/tsx', str(Path(p).relative_to(root))], False) for p in tests]
print('ACCEPTANCE cwd=' + str(root), flush=True)
print('ACCEPTANCE commit=' + subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), flush=True)
print('ACCEPTANCE initial tracked status:\n' + subprocess.check_output(['git','status','--short','--untracked-files=no'],text=True),flush=True)
print('ACCEPTANCE fork RPC=' + rpc + ' pinned by src/baseFork.ts; public RPC reads only',flush=True)
results=[]
for command, fork in jobs:
    child_env=env.copy()
    if fork: child_env['FORK_RPC']=rpc
    label=' '.join(command)
    print('\n$ '+('FORK_RPC='+rpc+' ' if fork else '')+label,flush=True)
    result=subprocess.run(command,env=child_env)
    results.append((label,result.returncode))
    print('ACCEPTANCE RESULT '+label+' exit='+str(result.returncode),flush=True)
print('\nACCEPTANCE SUMMARY',flush=True)
for label, code in results: print(('GREEN ' if code==0 else 'RED ')+label+' exit='+str(code),flush=True)
print(f'ACCEPTANCE TOTAL jobs={len(results)} green={sum(c==0 for _,c in results)} red={sum(c!=0 for _,c in results)}',flush=True)
sys.exit(any(c!=0 for _,c in results))
