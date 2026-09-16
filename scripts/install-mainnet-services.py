#!/usr/bin/env python3
"""Plan/install an isolated Base relay. Dry-run performs local reads only.

Sponsor file format: RELAY_SPONSOR_KEY=0x... (0600), as consumed by relay/common.ts.
The default hostname is deliberately unusable until PARAMETERS.md records a decision.
No deployment or transaction commands exist here. Apply creates a NEW named tunnel;
Cloudflare account authorization must already exist (no login/registration workflow).
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import socket
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
OLD = ('ai.mkyang.zero-one-relay', 'ai.mkyang.zero-one-tunnel')
LABELS = tuple(x + '-base' for x in OLD)
TUNNEL = 'zero-one-relay-base'
PLACEHOLDER = 'mainnet-hostname-undecided.invalid'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(cmd, **kwargs):
    return subprocess.run([str(x) for x in cmd], check=True, **kwargs)


def live_services():
    """Discover by launchd label, then read that job's actual plist; never mutate it."""
    result = []
    for label in OLD:
        output = run(['launchctl', 'print', f'gui/{os.getuid()}/{label}'], capture_output=True, text=True).stdout
        match = re.search(r'\n\s*path = (.+)', output)
        require(match, f'cannot locate live {label} plist')
        p = Path(match[1])
        result.append((p, plistlib.loads(p.read_bytes())))
    return result


def free_port(port):
    if not 1024 <= port <= 65535:
        return False
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def hostname_default(root):
    match = re.search(r'^- Mainnet relay hostname = `([^`]+)`.*\*\*DECIDE\*\*',
                      (root / 'docs/PARAMETERS.md').read_text(), re.M)
    return match[1] if match else PLACEHOLDER


def plan(args, root=ROOT, home=HOME, services=None):
    """Pure planner apart from read-only discovery and momentary port bind probes."""
    deployment = Path(args.deployment).resolve()
    require(deployment.is_file(), f'missing deployment record: {deployment}')
    d = json.loads(deployment.read_text())
    require(d.get('chainId') in (8453, 84532), 'deployment chain must be Base 8453 (84532 allowed for dry-run rehearsal only)')
    require(args.dry_run or d['chainId'] == 8453, 'apply refuses a non-mainnet deployment; use --dry-run for Sepolia fixture')
    for field in ('safe', 'baal', 'shares', 'loot', 'settlement', 'depositShaman', 'workManager', 'templateFactory', 'intentAccount'):
        require(re.fullmatch(r'0x[0-9a-fA-F]{40}', str(d.get(field, ''))), f'invalid deployment field: {field}')
    require(re.fullmatch(r'0x[0-9a-fA-F]{40}', d.get('constitution', {}).get('address', '')), 'invalid constitution address')
    key = Path(args.sponsor_key).absolute()
    require(key.is_file() and not key.is_symlink(), 'sponsor key must be a regular non-symlink file')
    require(stat.S_IMODE(key.stat().st_mode) == 0o600, 'sponsor key permissions must be 0600')
    require(key.stat().st_uid == os.getuid(), 'sponsor key must be owned by this user')
    # Never put the key or its hash in a plan, plist, receipt, or exception.
    require(re.search(r'^RELAY_SPONSOR_KEY\s*=\s*[\'"]?0x[0-9a-fA-F]{64}[\'"]?\s*$', key.read_text(), re.M),
            'sponsor file requires a RELAY_SPONSOR_KEY= line (key not displayed)')
    services = live_services() if services is None else services
    relay_old, tunnel_old = (s[1] for s in services)
    old_env = relay_old['EnvironmentVariables']
    old_args = tunnel_old['ProgramArguments']
    old_config = Path(old_args[old_args.index('--config') + 1])
    old_text = old_config.read_text()
    require(old_config.resolve().is_relative_to(root / 'state/tunnel'), 'live tunnel config not in repo state/tunnel; inspect manually')
    host = (args.hostname or hostname_default(root)).lower()
    require(re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+', host), 'invalid hostname')
    old_hosts = re.findall(r'hostname:\s*[\'"]?([^\s\'"]+)', old_text)
    require(not any(h == host or (h.startswith('*.') and host.endswith(h[1:])) for h in old_hosts), 'hostname collides with Sepolia ingress')
    require(args.dry_run or not host.endswith('.invalid'), 'mainnet hostname is DECIDE; set --hostname to the confirmed hostname')
    state = root / 'state/relay-base'
    tunnel_dir = root / 'state/tunnel-base'
    beacon = Path(args.beacon_dir).resolve() if args.beacon_dir else root / 'beacon/public-base'
    logs = root / 'state/logs-base'
    marker = tunnel_dir / 'installer.json'
    # Symlinks may alias old state, keys, logs or ingress. Reject before any writes.
    destinations = [state, tunnel_dir, beacon, logs, home / 'Library/LaunchAgents']
    for p in destinations:
        require(p.absolute() == p.resolve(), f'symlinked destination refused: {p}')
    protected = [(root / old_env[k]).resolve() for k in ('RELAY_STATE_DIR', 'RELAY_BEACON_DIR', 'RELAY_ENV_FILE')]
    protected += [old_config.parent.resolve(), *(Path(s[0]).resolve() for s in services)]
    for p in (state, tunnel_dir, beacon, logs):
        require(not p.exists() or not any(f.is_symlink() for f in p.rglob('*')), f'symlink inside destination refused: {p}')
        require(not any(p == q or p.is_relative_to(q) or q.is_relative_to(p) for q in protected), f'destination collides with Sepolia: {p}')
    require(key.resolve() != protected[2], 'sponsor file is the live Sepolia sponsor file')
    existing = json.loads(marker.read_text()) if marker.exists() else None
    ready = existing.pop('ready', False) if existing is not None else False
    require(existing is not None or not any(job_loaded(x) for x in LABELS), 'mainnet launchd label already loaded without installer ownership')
    if state.exists() and any(state.iterdir()):
        require(existing is not None, 'unowned/nonempty state/relay-base may hold Sepolia requests or T0 passes')
        identity = state / 'identity.json'
        require(identity.exists(), 'nonempty relay state lacks chain identity')
        ident = json.loads(identity.read_text())
        require(ident.get('chainId') == 8453 and ident.get('baal', '').lower() == d['baal'].lower(), 'relay state belongs to another chain/DAO')
    if existing:
        require(existing['deploymentHash'] == digest(deployment), 'installed deployment changed; refusing state reuse')
    port = args.port or (existing['port'] if existing else int(old_env['RELAY_PORT']) + 1)
    if args.port is None and existing is None:
        while port <= 65535 and not free_port(port):
            port += 1
    require(1024 <= port <= 65535, 'no free relay port')
    require(port != int(old_env['RELAY_PORT']), 'port collides with Sepolia relay')
    env = {'HOME': str(home), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
           'ZERO_ONE_DEPLOYMENT': str(deployment), 'RELAY_ENV_FILE': str(key),
           'RELAY_HOST': '127.0.0.1', 'RELAY_PORT': str(port), 'RELAY_STATE_DIR': str(state),
           'RELAY_BEACON_DIR': str(beacon), 'ZERO_ONE_ORIGIN': 'https://' + host, 'RELAY_LOG': '1'}
    node = relay_old['ProgramArguments'][0]
    cloudflared = old_args[0]
    for binary in (node, cloudflared, str(root / 'node_modules/tsx/dist/cli.mjs')):
        require(Path(binary).is_file(), f'missing executable/dependency: {binary}')
    credentials = tunnel_dir / 'credentials.json'
    config_path = tunnel_dir / 'cloudflared.yml'
    config = (f'tunnel: {TUNNEL}\ncredentials-file: {json.dumps(str(credentials))}\n'
              f'protocol: quic\nmetrics: 127.0.0.1:0\ningress:\n  - hostname: {host}\n'
              f'    service: http://127.0.0.1:{port}\n  - service: http_status:404\n')
    plists = {}
    for label, argv, job_env, log in (
        (LABELS[0], [node, '--import', 'tsx', str(root / 'relay/server.ts')], env, 'relay'),
        (LABELS[1], [cloudflared, 'tunnel', '--config', str(config_path), 'run'],
         {'HOME': str(home), 'PATH': env['PATH']}, 'tunnel')):
        obj = {'Label': label, 'ProgramArguments': argv, 'WorkingDirectory': str(root),
               'EnvironmentVariables': job_env, 'KeepAlive': True, 'RunAtLoad': True,
               'StandardOutPath': str(logs / (log + '.out.log')), 'StandardErrorPath': str(logs / (log + '.err.log'))}
        target = home / 'Library/LaunchAgents' / (label + '.plist')
        plists[str(target)] = plistlib.dumps(obj).decode()
    files = {str(config_path): config, **plists}
    for name in files:
        require(not Path(name).is_symlink(), f'symlinked output refused: {name}')
        require(existing is not None or not Path(name).exists(), f'unowned existing output: {name}')
    old_id = re.search(r'^tunnel:\s*(.+)', old_text, re.M)[1].strip()
    if credentials.exists():
        cred = json.loads(credentials.read_text())
        require(cred.get('TunnelID') and cred['TunnelID'] != old_id, 'tunnel credentials collide with Sepolia or lack TunnelID')
        require(existing is not None, 'unowned existing mainnet tunnel credentials')
    build = ['/usr/bin/env', 'RELAY_STATE_DIR=' + str(tunnel_dir / 'beacon-cache'), node, str(root / 'node_modules/tsx/dist/cli.mjs'), str(root / 'beacon/scripts/build.ts'),
             '--deployment', str(deployment), '--origin', 'https://' + host, '--out', str(beacon)]
    validate = ['/usr/bin/env', 'RELAY_STATE_DIR=' + str(tunnel_dir / 'beacon-cache'), node, str(root / 'node_modules/tsx/dist/cli.mjs'), str(root / 'beacon/scripts/validate.ts'),
                '--deployment', str(deployment), '--out', str(beacon)]
    readme = (beacon / 'README.txt').read_text() if (beacon / 'README.txt').exists() else None
    if readme is not None:
        st = json.loads((beacon / 'state.json').read_text())
        require(st['chain']['id'] == d['chainId'] and st['contracts']['baal'].lower() == d['baal'].lower(), 'beacon build belongs to another deployment')
        require('https://' + host in readme, 'beacon origin differs from mainnet hostname')
    spec = {'deploymentHash': digest(deployment), 'port': port, 'files': files,
            'beacon': str(beacon), 'hostname': host, 'sponsorFile': str(key),
            'sponsorMetadata': [key.stat().st_ino, key.stat().st_size, key.stat().st_mtime_ns]}
    unchanged = ready and credentials.exists() and readme is not None and existing == spec and all(Path(n).exists() and Path(n).read_text() == t for n, t in files.items())
    require(free_port(port) or (unchanged and owns_port(port)), f'chosen relay port {port} is taken')
    cmds = []
    if not unchanged:
        cmds += [build, validate + ['--no-fetch', '1']]
        if not credentials.exists():
            cmds += [[cloudflared, 'tunnel', 'create', '--credentials-file', str(credentials), TUNNEL]]
        cmds += [[cloudflared, 'tunnel', '--config', str(config_path), 'ingress', 'validate'],
                 [cloudflared, 'tunnel', 'route', 'dns', TUNNEL, host]]
    # Recover a missing own job on rerun, without restarting a healthy one.
    for label, p in zip(LABELS, plists):
        if not job_loaded(label):
            cmds.append(['launchctl', 'bootstrap', f'gui/{os.getuid()}', p])
    if not unchanged:
        cmds.append(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--retry', '12',
                     '--retry-delay', '5', '--retry-all-errors', '--connect-timeout', '10',
                     '--max-time', '20', 'https://' + host + '/health.json'])
        cmds.append(validate)
    return {'mode': 'DRY-RUN' if args.dry_run else 'APPLY', 'chainId': d['chainId'],
            'rehearsalOnly': d['chainId'] != 8453, 'designQuestions':
            ['mainnet hostname undecided; .invalid is a placeholder'] if host.endswith('.invalid') else [],
            'tunnelChoice': 'new named tunnel; existing Sepolia config untouched',
            'port': port, 'files': files, 'directories': list(map(str, destinations)),
            'commands': cmds, 'changes': [] if unchanged else list(files),
            'README': readme or 'NOT BUILT: build command above will create README.txt',
            'spec': spec, 'marker': str(marker), 'unchanged': unchanged}


def job_loaded(label):
    return subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{label}'], capture_output=True).returncode == 0


def owns_port(port):
    job = subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{LABELS[0]}'], capture_output=True, text=True)
    match = re.search(r'\n\s*pid = (\d+)', job.stdout)
    listening = subprocess.run(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True)
    return bool(match and set(listening.stdout.split()) == {match[1]})


def apply(p, args):
    """Only invoked without --dry-run. Never replaces live Sepolia files/jobs."""
    if p['unchanged'] and not p['commands']:
        print('NO-OP: config identical; both mainnet jobs loaded')
        return
    require(p['unchanged'] or not any(job_loaded(x) for x in LABELS),
            'mainnet config changed while own jobs loaded; refusing implicit restart; review printed changes')
    require((HOME / '.cloudflared/cert.pem').is_file(), 'existing Cloudflare origin certificate required; no account registration/login is performed')
    # Serialize installers using an existing directory fd: no lock file in dry-run.
    with open(ROOT / 'package.json', 'rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Re-plan after acquiring the lock so concurrent invocations cannot use a stale plan.
        p = plan(args)
        require(p['unchanged'] or not any(job_loaded(x) for x in LABELS), 'own jobs already loaded; config update needs review')
        require(free_port(p['port']) or (p['unchanged'] and owns_port(p['port'])), 'port became occupied after preflight')
        for folder in p['directories']:
            Path(folder).mkdir(parents=True, exist_ok=True, mode=0o700)
        if not p['unchanged']:
            # Build and locally validate before publishing any service configuration.
            for cmd in p['commands'][:2]:
                run(cmd, cwd=ROOT, env=clean_env())
            for name, text in p['files'].items():
                Path(name).write_text(text)
            # Persist ownership before tunnel creation: interrupted runs can resume.
            Path(p['marker']).write_text(json.dumps({**p['spec'], 'ready': False}, indent=2) + '\n')
        for cmd in p['commands'][2:] if not p['unchanged'] else p['commands']:
            # Cloudflare create output can include credentials: suppress tool output entirely.
            if 'create' in cmd:
                run(cmd, cwd=ROOT, env=clean_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                run(cmd, cwd=ROOT, env=clean_env())

        Path(p['marker']).write_text(json.dumps({**p['spec'], 'ready': True}, indent=2) + '\n')

def clean_env():
    return {'HOME': str(HOME), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'TMPDIR': os.environ.get('TMPDIR', '/tmp')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', default=str(ROOT / 'deployments/base.json'))
    parser.add_argument('--sponsor-key', required=True, help='0600 env file with RELAY_SPONSOR_KEY=; never printed')
    parser.add_argument('--hostname', help='confirmed mainnet hostname; default PARAMETERS.md DECIDE value')
    parser.add_argument('--port', type=int, help='explicit free port; otherwise pick/persist next free port after Sepolia')
    parser.add_argument('--beacon-dir', help='mainnet beacon output directory')
    parser.add_argument('--dry-run', action='store_true', help='local read-only plan; no files, subprocess services, DNS, RPC or transactions')
    args = parser.parse_args()
    try:
        p = plan(args)
        for k in ('mode', 'chainId', 'rehearsalOnly', 'designQuestions', 'tunnelChoice', 'port', 'changes'):
            print(f'{k}: {json.dumps(p[k])}')
        for name, text in p['files'].items():
            print(f'\nWRITE {name}\n{text}')
        print('\nDIRECTORIES: ' + json.dumps(p['directories']))
        print(f"WRITE ownership manifest {p['marker']} (configuration only; no keys)")
        print('\nCOMMANDS:\n' + '\n'.join(shlex.join(c) for c in p['commands']))
        print('\nREADME the relay would serve at /README.txt:\n' + p['README'])
        if args.dry_run:
            print('DRY-RUN COMPLETE: zero file writes; zero service/DNS/chain actions')
        else:
            apply(p, args)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        # Do not echo exception payloads from commands or JSON files containing credentials.
        message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else type(exc).__name__
        print('PREFLIGHT/INSTALL FAILED: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
