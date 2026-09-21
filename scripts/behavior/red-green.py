#!/usr/bin/env python3
"""Run the same acceptance gate first broken, then repaired, and retain both exits."""
import json
import subprocess
import sys
from pathlib import Path

rows = []
for name, flags, expected in [('red', ['--inject-drift'], 1), ('green', [], 0)]:
    cmd = [sys.executable, 'scripts/behavior/acceptance.py', 'evidence/g3/example.contract.json',
           '--out', f'evidence/g3/acceptance-{name}', *flags]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    row = {'stage': name, 'command': cmd, 'exit_code': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    rows.append(row)
    print(json.dumps(row), flush=True)
    if result.returncode != expected:
        raise SystemExit('unexpected acceptance exit')
Path('evidence/g3/red-green.json').write_text(json.dumps(rows, indent=2) + '\n')
