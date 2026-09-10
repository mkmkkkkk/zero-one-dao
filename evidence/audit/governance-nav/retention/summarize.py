"""Read receipts back, require decisive assertions, and emit the acceptance receipt; no network."""
from pathlib import Path
import hashlib
import re
import subprocess

root = Path('evidence/phase5/retention')
read = lambda name: (root / name).read_text()
red, green = read('t16-red.log'), read('t16-green.log')
assert 'exited=40 expected=0 supplyAtStart=100' in red
assert 'Error: COUNTEREXAMPLE' in red
assert 'exited=0 expected=0 supplyAtStart=100' in green
assert 'GREEN retention c all exact-deficit assertions' in green
assert 'GREEN retention b all exact-deficit assertions' in read('gas-b.log')
assert 'GREEN retention a gas comparison' in read('gas-a.log')
assert 'ASSERT ORACLE 36 changes / 6 overlapping windows' in green
assert 'ASSERT BUDGET exhaustion reverts atomically processed=false' in green
assert 'ASSERT ZERO state unchanged' in green
assert 'status=reverted' in read('t17-red.log')
assert 'GREEN empty-DAO zero exit no-op' in read('t17-green.log')
for name in ['t03.log', 't07.log', 't09.log']:
    assert re.search(r'^=== SCENARIO .*: PASS ===$', read(name), re.M), name
assert 'GOV-03 exact deficit stays 2000' in read('t03.log')
scenarios = re.findall(r'^([A-L]): (PASS|FAIL.*)$', read('scenarios.log'), re.M)
assert scenarios == [(x, 'PASS') for x in 'ABCDEFGHIJL'], scenarios
assert '=== RELAY E2E: PASS ===' in read('e2e-relay.log')
assert 'Wrote 47 local artifacts' in read('compile.log')
assert '> tsc --noEmit' in read('typecheck.log') and 'error TS' not in read('typecheck.log')
for name in ['docs/CONSTITUTION.md', 'CLAUDE.md']:
    assert Path(name).read_bytes() == subprocess.check_output(['git', 'show', 'dcb3e83:' + name])

lines = ['Zero One retention mechanism — local receipt readback',
         'Base commit dcb3e83; selected (c) append-only mint journal / exact A + growth - S.',
         'All transaction destinations were owned local Anvil. No public-network transaction or push.',
         'RED (original runtime, same new regression):']
lines += [x for x in red.splitlines() if x.startswith('ASSERT COUNTEREXAMPLE')]
lines += ['GREEN (normally deployed current contracts):']
lines += [x for x in green.splitlines() if x.startswith(('ASSERT ', 'GREEN '))]
lines += ['GAS TABLE (receipt gasUsed; deposits exclude approval; quiet=1, storm=100):']
for name in ['gas-a.log', 'gas-b.log', 't16-green.log']:
    gas = [x for x in read(name).splitlines() if x.startswith('GAS ')]
    assert len(gas) == 3
    lines += gas
lines += ['ZERO EXIT EMPTY DAO RED -> GREEN:']
for name in ['t17-red.log', 't17-green.log']:
    lines += [x for x in read(name).splitlines() if x.startswith(('ASSERT ', 'GREEN '))]
lines += ['AUDIT:']
for name in ['t03.log', 't07.log', 't09.log']:
    lines += [x for x in read(name).splitlines() if x.startswith('=== SCENARIO')]
lines += ['COMPILE: ' + read('compile.log').strip().splitlines()[-1],
          'TYPECHECK: tsc --noEmit, no diagnostics',
          'npm run scenarios (FORK_RPC unset):']
lines += [f'{name}: {result}' for name, result in scenarios]
lines += [read('k-blocked.log').strip(), '=== RELAY E2E: PASS ===',
          'PROTECTED: docs/CONSTITUTION.md and CLAUDE.md byte-identical to dcb3e83.',
          'RETENTION-ONLY acceptance green; full A-L acceptance BLOCKED on K.',
          'SHA256 of source and full receipt files:']
files = [Path('contracts/NavShareToken.sol'), Path('contracts/vendor/Baal.sol'),
         Path('evidence/audit/governance-nav/t16-retention-mechanism.ts'),
         Path('evidence/audit/governance-nav/retention/EpochLots.sol.txt'),
         Path('evidence/audit/governance-nav/retention/Eager.sol.txt')]
files += sorted(root.glob('*.log'))
for path in files:
    lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path}')
output = Path('evidence/phase5/retention-mechanism.log')
output.write_text('\n'.join(lines) + '\n')
print(output.read_text())
