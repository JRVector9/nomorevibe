#!/usr/bin/env bash
# No credentials: sample the public health endpoint until both standard web instances are seen.
# Run with bash; no executable permission changes are required.
set -euo pipefail
if [[ $# -ne 1 || ! $1 =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  printf 'Usage: bash scripts/ops/verify-prod-revision.sh <commit>\n' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
exec python3 - "$1" <<'PY'
import json
import os
import re
import subprocess
import sys
import time


def git(*args):
    return subprocess.run(['git', '--no-replace-objects', *args], capture_output=True, text=True)


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


resolved = git('rev-parse', '--verify', sys.argv[1] + '^{commit}')
if resolved.returncode:
    fail('Required commit is unavailable locally; run git fetch origin first.', 2)
required = resolved.stdout.strip()
expected = {'m3-web', 'mini-web'}
seen = set()
# Override only for local regression fixtures. Production uses the same public endpoint as the deploy gate.
url = os.environ.get('NMV_VERIFY_HEALTH_URL', 'https://nomorevibe.com/api/health')
for attempt in range(40):
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
    if not isinstance(health, dict) or health.get('status') != 'ok' or health.get('db') != 'ok':
        fail('Public health is not ready.')
    instance, release = health.get('instanceId'), health.get('release')
    if not isinstance(instance, str) or instance not in expected:
        fail('Public health returned an unexpected instance identity.')
    if not isinstance(release, str) or not re.fullmatch('[0-9a-f]{40}', release):
        fail('Public health returned an invalid release identity.')
    if git('cat-file', '-e', release + '^{commit}').returncode:
        fail(f'{instance}: release {release} is unavailable locally; run git fetch origin first.')
    ancestry = git('merge-base', '--is-ancestor', required, release)
    if ancestry.returncode:
        fail(f'{instance}: release {release} does not contain required commit {required} '
             f'(git merge-base --is-ancestor exit {ancestry.returncode}).')
    if instance not in seen:
        print(f'{instance}: release {release} contains {required}', flush=True)
        seen.add(instance)
    if seen == expected:
        print('PASS: both standard production web instances contain the required commit.')
        sys.exit(0)
    time.sleep(0.25)
fail('Could not verify all standard production instances; missing: ' + ', '.join(sorted(expected - seen)))
PY
