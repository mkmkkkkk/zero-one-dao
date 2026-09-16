#!/usr/bin/env python3
"""Isolated planner tests; no launchctl mutations, DNS calls, relay or tunnel startup."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-mainnet-services.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='mainnet-installer-test-')).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        for name in ('docs', 'state/tunnel', 'node_modules/tsx/dist', 'relay', 'bin'):
            (self.root / name).mkdir(parents=True)
        for name in ('bin/node', 'bin/cloudflared', 'node_modules/tsx/dist/cli.mjs'):
            (self.root / name).touch()
        (self.root / 'docs/PARAMETERS.md').write_text('')
        self.config = self.root / 'state/tunnel/cloudflared.yml'
        self.config.write_text('tunnel: live-id\nprotocol: quic\ningress:\n - hostname: relay-zero.mkyang.ai\n   service: http://127.0.0.1:18761\n - service: http_status:404\n')
        self.deployment = self.root / 'deployment.json'
        shutil.copyfile(m.ROOT / 'deployments/base-sepolia.json', self.deployment)
        self.key = self.root / 'sponsor.env'
        self.key.write_text('RELAY_SPONSOR_KEY=0x' + '1' * 64 + '\n')
        self.key.chmod(0o600)
        self.services = [(self.home / 'old-relay.plist', {'ProgramArguments': [str(self.root / 'bin/node')], 'EnvironmentVariables': {
            'RELAY_PORT': '18761', 'RELAY_STATE_DIR': 'state/relay-base-sepolia-phase5',
            'RELAY_ENV_FILE': 'state/relay.env', 'RELAY_BEACON_DIR': 'beacon/public-phase5'}}),
            (self.home / 'old-tunnel.plist', {'ProgramArguments': [str(self.root / 'bin/cloudflared'), 'tunnel', '--config', str(self.config), 'run']})]
        self.args = argparse.Namespace(deployment=str(self.deployment), sponsor_key=str(self.key),
                                       dry_run=True, hostname=None, port=None, beacon_dir=None)
        self.loaded = patch.object(m, 'job_loaded', return_value=False)
        self.loaded.start()

    def tearDown(self):
        self.loaded.stop()
        trash = Path.home() / '.Trash'
        trash.mkdir(exist_ok=True)
        shutil.move(str(self.root), str(trash / self.root.name))

    def plan(self):
        return m.plan(self.args, root=self.root, home=self.home, services=self.services)

    def fail(self, text):
        with self.assertRaisesRegex(ValueError, text):
            self.plan()

    def test_missing_record(self):
        self.args.deployment = str(self.root / 'base.json')
        self.fail('missing deployment record')

    def test_permissions(self):
        self.key.chmod(0o644)
        self.fail('0600')

    def test_live_port(self):
        self.args.port = 18761
        self.fail('Sepolia relay')

    def test_occupied_port(self):
        # Select an unoccupied port before binding the isolated negative fixture.
        p = 28761
        while not m.free_port(p):
            p += 1
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', p))
            sock.listen()
            self.args.port = p
            self.fail('is taken')

    def test_auto_port_skips_occupied(self):
        with patch.object(m, 'free_port', side_effect=lambda p: p != 18762):
            self.assertEqual(self.plan()['port'], 18763)

    def test_host_collision(self):
        self.args.hostname = 'RELAY-ZERO.MKYANG.AI'
        self.fail('Sepolia ingress')

    def test_state_symlink(self):
        (self.root / 'state/relay-base').symlink_to(self.root / 'state/relay-base-sepolia-phase5')
        self.fail('symlinked destination')

    def test_beacon_file_symlink(self):
        beacon = self.root / 'beacon/public-base'
        beacon.mkdir(parents=True)
        (beacon / 'README.txt').symlink_to(self.config)
        self.fail('symlink inside destination')

    def test_unowned_state(self):
        state = self.root / 'state/relay-base'
        state.mkdir()
        (state / 'db.json').write_text('{"passes":{"test":"old"}}')
        self.fail('unowned/nonempty')

    def test_beacon_collision(self):
        self.args.beacon_dir = str(self.root / 'beacon/public-phase5')
        self.fail('collides with Sepolia')

    def test_label_collision(self):
        with patch.object(m, 'job_loaded', return_value=True):
            self.fail('label already loaded')

    def test_sepolia_apply_refused(self):
        self.args.dry_run = False
        self.fail('non-mainnet')

    def test_placeholder_apply_refused(self):
        d = json.loads(self.deployment.read_text()); d['chainId'] = 8453
        self.deployment.write_text(json.dumps(d))
        self.args.dry_run = False
        self.fail('hostname is DECIDE')

    def test_exact_plan_no_writes(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        p = self.plan()
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        for file, body in p['files'].items():
            if file.endswith('.plist'):
                obj = plistlib.loads(body.encode())
                self.assertIn(obj['Label'], m.LABELS)
                self.assertTrue(obj['KeepAlive'])
                self.assertEqual(obj['EnvironmentVariables']['HOME'], str(self.home))
        self.assertNotIn('1' * 64, json.dumps(p))
        self.assertIn('protocol: quic', p['files'][str(self.root / 'state/tunnel-base/cloudflared.yml')])
        self.assertEqual(p, self.plan())

    def test_installed_noop_and_interrupted_recovery(self):
        d = json.loads(self.deployment.read_text()); d['chainId'] = 8453
        self.deployment.write_text(json.dumps(d))
        p = self.plan()
        for name, body in p['files'].items():
            path = Path(name); path.parent.mkdir(parents=True, exist_ok=True); path.write_text(body)
        Path(p['marker']).write_text(json.dumps({**p['spec'], 'ready': True}))
        creds = self.root / 'state/tunnel-base/credentials.json'
        creds.write_text('{"TunnelID":"independent-id"}')
        beacon = Path(p['spec']['beacon']); beacon.mkdir(parents=True)
        (beacon / 'README.txt').write_text('https://' + m.PLACEHOLDER)
        (beacon / 'state.json').write_text(json.dumps({'chain': {'id':8453}, 'contracts': {'baal': d['baal']}}))
        with patch.object(m, 'job_loaded', return_value=True):
            q = self.plan()
        self.assertTrue(q['unchanged'])
        self.assertEqual(q['commands'], [])
        self.assertEqual(q['changes'], [])
        # A missing own job is recovered via bootstrap; neither old label is touched.
        q = self.plan()
        self.assertEqual(len(q['commands']), 2)
        self.assertTrue(all(c[1] == 'bootstrap' for c in q['commands']))
        # DNS/public-validation failure must not be mistaken for completed provisioning.
        Path(p['marker']).write_text(json.dumps({**p['spec'], 'ready': False}))
        q = self.plan()
        self.assertFalse(q['unchanged'])
        self.assertTrue(any('dns' in c for c in q['commands']))
        Path(p['marker']).write_text(json.dumps({**p['spec'], 'ready': True}))
        # Incomplete tunnel provisioning must never be mistaken for a no-op.
        shutil.move(str(creds), str(self.root / 'saved-credentials'))
        q = self.plan()
        self.assertFalse(q['unchanged'])
        self.assertTrue(any('create' in c for c in q['commands']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
