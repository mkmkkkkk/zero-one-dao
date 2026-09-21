#!/usr/bin/env python3
"""Schema rejection and real-JVM acceptance tests for the G3 contract."""
import copy
import json
from pathlib import Path
import unittest
from adjudicate import ROOT, adjudicate, canonical, digest, validate

class BehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads((ROOT / 'evidence/g3/example.contract.json').read_text())

    def test_valid_contract(self):
        validate(self.contract)

    def test_invalid_contracts(self):
        for field, value in [('chain_id', 1), ('bond', {'amount_wei': '0'}), ('unknown', True)]:
            with self.subTest(field=field):
                c = copy.deepcopy(self.contract)
                c[field] = value
                with self.assertRaises(Exception):
                    validate(c)
        c = copy.deepcopy(self.contract)
        c['expires_at'] = c['starts_at']
        with self.assertRaises(ValueError):
            validate(c)
        c = copy.deepcopy(self.contract)
        c['replays'][0]['command'] = ['sh', '-c', 'echo unsafe']
        with self.assertRaises(Exception):
            validate(c)
        c = copy.deepcopy(self.contract)
        c['oracle']['runner_sha256'] = '0x' + '0' * 64
        with self.assertRaises(ValueError):
            validate(c)

    def test_repaired_artifact_passes(self):
        result = adjudicate(self.contract, ROOT / self.contract['patch']['artifact'], ROOT / 'evidence/g3/pass')
        print(json.dumps(result), flush=True)
        self.assertEqual(result['verdict'], 'pass')
        evidence = (ROOT / 'evidence/g3/pass/evidence.json').read_bytes()
        self.assertEqual(digest(evidence), result['evidence_hash'])

    def test_disabled_repair_fails(self):
        result = adjudicate(self.contract, ROOT / self.contract['patch']['artifact'], ROOT / 'evidence/g3/fail', True)
        print(json.dumps(result), flush=True)
        self.assertEqual(result['verdict'], 'fail')
        evidence = json.loads((ROOT / 'evidence/g3/fail/evidence.json').read_text())
        self.assertTrue(evidence['artifact_matches'])
        self.assertEqual(evidence['replays'][0]['observed']['status'], 404)

    def test_replaced_artifact_fails_without_execution(self):
        artifacts = json.loads((ROOT / 'state/g3/artifacts.json').read_text())
        result = adjudicate(self.contract, ROOT / artifacts[0]['path'], ROOT / 'evidence/g3/artifact-mismatch')
        self.assertEqual(result['verdict'], 'fail')
        evidence = json.loads((ROOT / 'evidence/g3/artifact-mismatch/evidence.json').read_text())
        self.assertFalse(evidence['artifact_matches'])
        self.assertEqual(evidence['replays'], [])

    def test_missing_artifact_blocks(self):
        with self.assertRaises(FileNotFoundError):
            adjudicate(self.contract, ROOT / 'state/g3/does-not-exist.jar', ROOT / 'state/g3/missing')

if __name__ == '__main__':
    unittest.main(verbosity=2)
