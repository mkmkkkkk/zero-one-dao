#!/usr/bin/env python3
"""CI acceptance: a measured fail exits 1, infrastructure error exits 2 upstream."""
import argparse
import json
from pathlib import Path
from adjudicate import adjudicate

p = argparse.ArgumentParser()
p.add_argument('contract')
p.add_argument('--out', required=True)
p.add_argument('--inject-drift', action='store_true')
a = p.parse_args()
c = json.loads(Path(a.contract).read_text())
result = adjudicate(c, c['patch']['artifact'], a.out, a.inject_drift)
print(json.dumps(result), flush=True)
if result['verdict'] != 'pass':
    raise SystemExit(1)
