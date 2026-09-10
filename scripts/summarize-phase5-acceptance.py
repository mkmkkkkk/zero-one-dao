"""Consolidate explicit phase-5 native assertions; fail closed on missing proofs."""
import json
from pathlib import Path
root = Path('evidence/testnet/phase5')
def read(name):
    return json.loads((root / name).read_text())
rows = {}
sources = ['corner-cases-daos-initial.json', 'corner-cases-daos-2026-09-10.json', 'vote-boundaries-resume.json']
for source in sources:
    for row in read(source)['rows']:
        rows[row['id']] = {**row, 'source': source}
migration = read('migration-followup.json')
assert migration['result'] == 'PASS'
rows['strategy-migrate-non-template'] = dict(id='strategy-migrate-non-template', expected='voted migration moves all 100 mock USDC to a non-template contract', observed='source zero; recipient increases by 100000000 base units', ok=True, receipt=migration['contractMigration'], source='migration-followup.json')
rows['strategy-migrate-EOA-refused'] = dict(id='strategy-migrate-EOA-refused', expected='EOA rejected with NotAContract; source funds unchanged', observed='mined proposal actionFailed; source retains 100000000 base units', ok=True, receipt=migration['eoaRefusal'], source='migration-followup.json')
same = read('same-block-vote.json')
assert same['result'] == 'PASS'
rows['vote-in-submission-block'] = dict(id='vote-in-submission-block', expected='same-transaction vote refused by timestamp snapshot gate; later block succeeds', observed='TimePointNotDetermined event; successful later-block vote', ok=True, receipt=same['sameBlockRefusal'], laterVote=same['laterVote'], source='same-block-vote.json')
assert all(row['ok'] for row in rows.values())
out = dict(chainId=84532, sources=sources+['migration-followup.json','same-block-vote.json'], count=len(rows), passed=sum(row['ok'] for row in rows.values()), rows=list(rows.values()))
(root / 'contract-corners-combined.json').write_text(json.dumps(out, indent=2)+'\n')
print(f"NATIVE CONTRACT CORNERS: {out['passed']}/{out['count']} rows with current-run evidence")
scenario_logs = {
 **{s:['scenarios-A-J-L.log'] for s in 'ACDEFG'},
 **{s:['scenarios-B-H-I-J-L-rerun.log'] for s in 'BHIJ'},
 'K':['scenario-K.log'],
 'L':['scenarios-L-native.log','scenarios-L-native-resume.log'],
}
scenarios=[]
for letter in 'ABCDEFGHIJKL':
    files=scenario_logs[letter]
    marker=f'SCENARIO {letter}'+(' NATIVE SEPOLIA: PASS' if letter=='K' else ': PASS')
    assert any(marker in (root/f).read_text() for f in files), f'missing {letter} native pass'
    scenarios.append(dict(scenario=letter,result='PASS',logs=files))
(root/'scenarios-summary.json').write_text(json.dumps(dict(chainId=84532,passed=len(scenarios),expected=12,scenarios=scenarios),indent=2)+'\n')
print('NATIVE SCENARIOS A-L: 12/12 PASS (failed attempts retained; L completed on its original DAO)')
