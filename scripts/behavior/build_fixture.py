#!/usr/bin/env python3
"""Build an isolated byte-for-byte snapshot of Compat Foundry's real fixture."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'state/g3'
JAVA_HOME = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'
manifest = []
for version in ('2.7.18', '3.0.13'):
    work = OUT / f'build-{version}'
    if work.exists():
        raise SystemExit(f'{work} exists: preserve old build; use its recorded artifacts')
    shutil.copytree(ROOT / 'evidence/g3/fixture', work)
    with open(OUT / f'build-{version}.log', 'wb') as log:
        subprocess.run(['mvn', '-B', '-q', 'package', '-DskipTests', f'-Dspring-boot.version={version}'],
                       cwd=work, env={**os.environ, 'JAVA_HOME': JAVA_HOME}, stdout=log,
                       stderr=subprocess.STDOUT, timeout=600, check=True)
    jar = work / 'target/spring-trailing-slash-compat-1.0.0.jar'
    manifest.append({'version': version, 'path': str(jar.relative_to(ROOT)),
                     'sha256': '0x' + hashlib.sha256(jar.read_bytes()).hexdigest()})
(OUT / 'artifacts.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
