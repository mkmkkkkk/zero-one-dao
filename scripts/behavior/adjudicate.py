#!/usr/bin/env python3
"""Replay a pinned real Spring fixture; never execute commands supplied by a contract."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
JAVA = Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java')
COMMAND = ['java', '-jar', '${artifact}', '--compat.trailing-slash=true']


def canonical(value):
    """ASCII, sorted keys, compact JSON; all contract numbers are integers."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(data):
    return '0x' + hashlib.sha256(data).hexdigest()


def file_hash(path):
    return digest(Path(path).read_bytes())


def validate(contract):
    schema = json.loads((ROOT / 'schemas/behavior_contract.schema.json').read_text())
    Draft202012Validator(schema).validate(contract)
    ids = [r['drift_id'] for r in contract['replays']]
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate drift id')
    if contract['expires_at'] <= contract['starts_at']:
        raise ValueError('expiry must follow start')
    if contract['promisor'].lower() == contract['beneficiary'].lower():
        raise ValueError('beneficiary must differ from promisor')
    if any(r['command'] != COMMAND for r in contract['replays']):
        raise ValueError('unsupported command: only the pinned Spring harness is allowed')
    if contract['oracle']['runner_sha256'] != file_hash(__file__):
        raise ValueError('oracle runner hash mismatch')


def probe(jar, compat, log):
    """Bind only loopback on an available port; terminate and reap our JVM in finally."""
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    while subprocess.run(['lsof', f'-iTCP:{port}', '-sTCP:LISTEN'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        port += 1
    cmd = [str(JAVA), '-jar', str(jar), '--server.address=127.0.0.1',
           f'--server.port={port}', f'--compat.trailing-slash={str(compat).lower()}']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with open(log, 'wb') as output:
        proc = subprocess.Popen(cmd, stdout=output, stderr=subprocess.STDOUT)
        try:
            ready = False
            for _ in range(150):
                if proc.poll() is not None:
                    raise RuntimeError('JVM exited before readiness; see server log')
                try:
                    with opener.open(f'http://127.0.0.1:{port}/api/greeting', timeout=1) as r:
                        ready = r.status == 200
                    if ready:
                        break
                except (urllib.error.URLError, TimeoutError):
                    pass
                time.sleep(0.2)
            if not ready:
                raise RuntimeError('readiness timeout; no behavioral verdict')
            try:
                response = opener.open(f'http://127.0.0.1:{port}/api/greeting/', timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read().decode('utf-8')
                # Spring's 404 JSON has a wall-clock timestamp. Only that known volatile
                # field is excluded; every other field, including status/path, is retained.
                if 'application/json' in response.headers.get('Content-Type', ''):
                    body = json.loads(body)
                    body.pop('timestamp', None)
                return {'status': response.status, 'body': body}
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


def adjudicate(contract, artifact, output, inject=False):
    validate(contract)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    actual = file_hash(artifact)
    rows = []
    for replay in (contract['replays'] if actual == contract['patch']['sha256'] else []):
        observed = probe(artifact, not inject, output / f"{replay['drift_id']}.log")
        observed_hash = digest(canonical(observed))
        rows.append({'drift_id': replay['drift_id'], 'observed': observed,
                     'output_sha256': observed_hash,
                     'expected_output_sha256': replay['expected_output_sha256'],
                     'pass': observed_hash == replay['expected_output_sha256']})
    verdict = 'pass' if actual == contract['patch']['sha256'] and all(r['pass'] for r in rows) else 'fail'
    evidence = {'version': 1, 'contract_sha256': digest(canonical(contract)),
                'artifact_sha256': actual, 'artifact_matches': actual == contract['patch']['sha256'],
                'runner_sha256': file_hash(__file__), 'injected_drift': inject,
                'effective_compat_flag': not inject, 'replays': rows, 'verdict': verdict}
    encoded = canonical(evidence)
    (output / 'evidence.json').write_bytes(encoded)
    result = {'verdict': verdict, 'evidence_hash': digest(encoded)}
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('contract')
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--inject-drift', action='store_true', help='testnet fault injection: disable the repair')
    args = parser.parse_args()
    try:
        result = adjudicate(json.loads(Path(args.contract).read_text()), args.artifact, args.out, args.inject_drift)
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        # Invalid contract / unavailable JVM / IO failure is not grounds to slash.
        print(json.dumps({'status': 'blocked', 'reason': str(error)}))
        raise SystemExit(2)
