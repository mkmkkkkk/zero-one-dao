#!/usr/bin/env python3
"""Reinstall and rerun acceptance from the committed branch, preserving origin and full output."""
import datetime
import os
from pathlib import Path
import signal
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
log_path = root / 'evidence/phase5/acceptance-rerun-retention.log'
branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip()
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
origin = subprocess.check_output(['git', 'remote', 'get-url', 'origin'], cwd=root, text=True).strip()
if not branch:
    raise SystemExit('clean acceptance requires a named branch')
clone = Path(tempfile.mkdtemp(prefix='zero-one-retention-clean-', dir=Path.home() / 'srv'))
env = os.environ.copy()
env['HTTPS_PROXY'] = env.get('HTTPS_PROXY', 'http://127.0.0.1:7897')
env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost'
env['FORK_RPC'] = env.get('FORK_RPC', 'https://mainnet.base.org')
env['FORK_BLOCK'] = '51000000'
env.pop('ZERO_ONE_LIVE_DEPLOYMENT', None)

with log_path.open('w') as log:
    def note(message):
        print(message, file=log, flush=True)
        print(message, flush=True)

    def run(command, cwd):
        note('$ ' + ' '.join(command))
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait()
        finally:
            # Only this command's owned process group; also handles interrupted runs.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        note('CLEAN COMMAND exit=' + str(code))
        if code:
            raise SystemExit(code)

    try:
        note('CLEAN CLONE RETENTION ACCEPTANCE UTC=' + datetime.datetime.now(datetime.timezone.utc).isoformat())
        note('SOURCE=' + str(root) + ' branch=' + branch + ' commit=' + head)
        note('CLONE=' + str(clone))
        run(['git', 'clone', '--no-local', '--single-branch', '--branch', branch, str(root), str(clone)], root)
        # A local object source is not the published genesis repository. Deployment refusal
        # tests must retain the source checkout's real origin and its advertised ancestors.
        run(['git', 'remote', 'set-url', 'origin', origin], clone)
        run(['git', 'rev-parse', 'HEAD'], clone)
        assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=clone, text=True).strip() == head
        assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=clone, text=True).strip()
        note('ASSERT clean clone HEAD matches source; initial status empty; no dependency or state copy')
        run(['npm', 'ci'], clone)
        assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=clone, text=True).strip()
        note('ASSERT npm ci left tracked source clean')
        run(['python3', 'scripts/acceptance-retention.py'], clone)
        note('CLEAN CLONE ACCEPTANCE COMPLETE source=' + head)
    finally:
        trash = Path.home() / '.Trash' / (clone.name + '-' + str(os.getpid()))
        clone.rename(trash)
        note('CLEANUP clone moved to ' + str(trash))
