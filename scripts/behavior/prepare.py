#!/usr/bin/env python3
"""Measure legacy baseline and write a complete, hash-bound Sepolia demo contract."""
import argparse
import json
from pathlib import Path
from adjudicate import ROOT, COMMAND, canonical, digest, file_hash, probe, validate

p = argparse.ArgumentParser()
p.add_argument('--promisor', required=True)
p.add_argument('--oracle', required=True)
p.add_argument('--beneficiary', required=True)
p.add_argument('--starts', required=True, type=int)
p.add_argument('--expires', required=True, type=int)
p.add_argument('--id', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
artifacts = json.loads((ROOT / 'state/g3/artifacts.json').read_text())
baseline = probe(ROOT / artifacts[0]['path'], False, ROOT / 'state/g3/baseline.log')
(ROOT / 'evidence/g3/baseline.json').write_text(json.dumps({'observed': baseline, 'sha256': digest(canonical(baseline)), 'artifact': artifacts[0]}, indent=2) + '\n')
c = {'schema_version': '1', 'contract_id': a.id, 'chain_id': 84532,
     'promisor': a.promisor, 'beneficiary': a.beneficiary,
     'patch': {'artifact': artifacts[1]['path'], 'sha256': artifacts[1]['sha256'],
               'source': 'compat-foundry/java-spring-trailing-slash', 'spring_boot': '3.0.13'},
     'replays': [{'drift_id': 'mvc-trailing-slash', 'command': COMMAND,
                  'request': 'GET /api/greeting/', 'normalization': 'status-body-json-v1',
                  'expected_output_sha256': digest(canonical(baseline))}],
     'bond': {'amount_wei': '1000000000', 'currency': 'Base Sepolia ETH', 'decimals': 18},
     'oracle': {'kind': 'named-runner', 'address': a.oracle,
                'runner_sha256': file_hash(ROOT / 'scripts/behavior/adjudicate.py'),
                'evidence_commitment': 'sha256-canonical-json-onchain-event',
                'relay_validation': 'unsupported-direct-testnet-client'},
     'starts_at': a.starts, 'expires_at': a.expires,
     'release_condition': 'pass-replay-after-expiry-and-dispute-window',
     'slash_condition': 'replay-output-or-artifact-hash-mismatch',
     'dispute': {'seconds': 6, 'policy': 'oracle-rerun-fail-overrides-pass', 'unavailable_oracle': 'locked-until-report'}}
validate(c)
Path(a.out).write_text(json.dumps(c, indent=2) + '\n')
print(json.dumps({'contract_sha256': digest(canonical(c)), 'baseline': baseline}))
