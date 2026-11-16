#!/usr/bin/env bash
# Verify that every running standard web container (m3-web on M3, mini-web on mini) contains a commit.
# The public /api/health answers only {status} since 2026-11-16, so each container's own /api/health is read on its server
# the way the deploy tool does (SSH as NMV_DEPLOY_SSH_USER, default root, + docker exec). The public endpoint is checked for status ok.
# No Dokploy key or other credential beyond the deploy tool's SSH access. Run with bash; no executable permission changes are required.
set -euo pipefail
if [[ $# -ne 1 || ! $1 =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  printf 'Usage: bash scripts/ops/verify-prod-revision.sh <commit>\n' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
exec python3 - "$1" <<'PY'
import importlib.util
import json
import os
import re
import subprocess
import sys


def git(*args):
    return subprocess.run(['git', '--no-replace-objects', *args], capture_output=True, text=True)


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


resolved = git('rev-parse', '--verify', sys.argv[1] + '^{commit}')
if resolved.returncode:
    fail('Required commit is unavailable locally; run git fetch origin first.', 2)
required = resolved.stdout.strip()

spec = importlib.util.spec_from_file_location('deploy_shared_images', 'scripts/ops/deploy_shared_images.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)

expected = {short: (shared.APPS[short][2][1], instance) for short, instance in shared.WEB_INSTANCE_IDS.items()}
for short, (host, instance) in expected.items():
    try:
        rows = json.loads(shared.ssh_python(host, shared.REMOTE_WEB_RELEASES, instance, timeout=120))
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        # ssh/command errors carry only the command name and exit code (deploy_shared_images.run).
        fail(f'{instance}: could not read the web containers on their server ({type(error).__name__}).')
    if not isinstance(rows, list) or not rows:
        fail(f'{instance}: no running web container was found on its server.')
    for row in rows:
        if not isinstance(row, dict):
            fail(f'{instance}: unreadable container report.')
        container = row.get('container') if isinstance(row.get('container'), str) else '?'
        if (row.get('http'), row.get('status'), row.get('db')) != (200, 'ok', 'ok'):
            fail(f'{instance} {container}: direct health is not ready.')
        if row.get('instanceId') != instance:
            fail(f'{instance} {container}: direct health returned an unexpected instance identity.')
        release = row.get('release')
        if not isinstance(release, str) or not re.fullmatch('[0-9a-f]{40}', release):
            fail(f'{instance} {container}: direct health returned an invalid release identity.')
        if git('cat-file', '-e', release + '^{commit}').returncode:
            fail(f'{instance} {container}: release {release} is unavailable locally; run git fetch origin first.')
        ancestry = git('merge-base', '--is-ancestor', required, release)
        if ancestry.returncode:
            fail(f'{instance} {container}: release {release} does not contain required commit {required} '
                 f'(git merge-base --is-ancestor exit {ancestry.returncode}).')
        print(f'{instance} {container}: release {release} contains {required}', flush=True)

# Override only for local regression fixtures (tests also put a fake ssh/docker first on PATH).
# Production uses the same public endpoint as the deploy gate; it answers only {status}.
url = os.environ.get('NMV_VERIFY_HEALTH_URL', shared.PUBLIC_HEALTH_URL)
response = subprocess.run([
    'curl', '--noproxy', '', '--fail', '--silent', '--show-error', '--max-time', '10',
    '--header', 'Cache-Control: no-cache', url,
], capture_output=True, text=True)
if response.returncode:
    # curl errors contain no credentials: this request has no auth or secret headers.
    fail('Public health request failed: ' + response.stderr.strip(), response.returncode)
try:
    health = json.loads(response.stdout)
except ValueError:
    fail('Public health returned invalid JSON.')
if not isinstance(health, dict) or health.get('status') != 'ok':
    fail('Public health is not ready.')
print('public health: ok', flush=True)
print('PASS: every running standard production web container (m3-web, mini-web) contains the required commit.')
PY
