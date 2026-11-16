"""scripts/ops/verify-prod-revision.sh: each web container's commit is read on its server; the public URL only for status.

The public /api/health answers only {status} since 2026-11-16. A fake `ssh` (runs the remote command locally) and a fake
`docker` stand first on PATH, and a local HTTP server stands in for the public endpoint (NMV_VERIFY_HEALTH_URL).
Nothing here reaches a real host or nomorevibe.com.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/ops/verify-prod-revision.sh'
SECRET = 'sample-secret-value-not-for-output'

FAKE_SSH = '''import os,subprocess,sys
with open(os.environ['FAKE_SSH_LOG'],'a') as log: log.write(sys.argv[-2]+'\\n')
if os.environ.get('FAKE_SSH_FAIL'): sys.exit(255)
sys.exit(subprocess.run(['sh','-c',sys.argv[-1]]).returncode)
'''
FAKE_DOCKER = '''import json,os,sys
f=json.loads(os.environ['FAKE_DOCKER']);a=sys.argv[1:]
if a[0]=='ps': print('\\n'.join(c['id'] for c in f))
elif a[0]=='inspect':
 print(json.dumps([{'Id':c['id'],'Config':{'Env':c['env'],'Labels':{'com.docker.swarm.service.name':c['service']}},
                    'State':{'Running':c.get('running',True)}} for c in f if c['id'] in a[1:]]))
elif a[0]=='exec': print(json.dumps(next(c for c in f if c['id']==a[1])['health']))
else: sys.exit(1)
'''


def head():
    return subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()


def web(cid, instance, release, *, http=200, status='ok', reported=None, running=True):
    return {'id': cid + '0' * (64 - len(cid)), 'service': 'svc-' + instance, 'running': running,
            'env': ['SERVICE_INSTANCE_ID=' + instance, 'RELEASE_TAG=' + release, 'AUTH_SECRET=' + SECRET],
            'health': {'status': http, 'body': {'status': status, 'db': 'ok', 'release': release,
                                                'instanceId': reported or instance}}}


class PublicHealth:
    """Local stand-in for the public endpoint — answers like the minimal public body."""

    def __init__(self, status, body):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.paths.append(self.path)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self.paths = []
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/api/health'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class VerifyProdRevisionTests(unittest.TestCase):
    def setUp(self):
        self.sha = head()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        bin_dir = Path(self.directory.name) / 'bin'
        bin_dir.mkdir()
        for name, source in (('ssh', FAKE_SSH), ('docker', FAKE_DOCKER)):
            path = bin_dir / name
            path.write_text('#!' + sys.executable + '\n' + source)
            path.chmod(0o755)
        self.bin = str(bin_dir)
        self.log = Path(self.directory.name) / 'ssh.log'

    def verify(self, containers, *, public=(200, {'status': 'ok'}), ssh_fail=False):
        server = PublicHealth(*public)
        self.addCleanup(server.close)
        env = {key: value for key, value in os.environ.items() if key != 'NMV_DEPLOY_SSH_USER'}
        env.update(PATH=self.bin + os.pathsep + os.environ['PATH'], FAKE_DOCKER=json.dumps(containers),
                   FAKE_SSH_LOG=str(self.log), NMV_VERIFY_HEALTH_URL=server.url)
        if ssh_fail:
            env['FAKE_SSH_FAIL'] = '1'
        result = subprocess.run(['bash', str(SCRIPT), self.sha], capture_output=True, text=True, env=env, timeout=120)
        hosts = self.log.read_text().split() if self.log.exists() else []
        return result, hosts, server.paths

    def fleet(self, **overrides):
        rows = [web('aa', 'mini-web', self.sha), web('ab', 'mini-web', self.sha),
                web('ba', 'm3-web', self.sha), web('bb', 'm3-web', self.sha), web('bc', 'm3-web', self.sha),
                # a stopped old web task and a worker are not standard web containers
                web('ac', 'mini-web', '0' * 40, running=False),
                {'id': 'c' * 64, 'service': 'svc-worker', 'env': ['SERVICE_INSTANCE_ID=crawler-m3', 'AUTH_SECRET=' + SECRET],
                 'health': {}}]
        for index, row in overrides.items():
            rows[int(index[1:])] = row
        return rows

    def test_passes_when_every_container_on_both_servers_contains_the_commit_and_public_is_ok(self):
        result, hosts, paths = self.verify(self.fleet())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS: every running standard production web container (m3-web, mini-web) contains the required commit.',
                      result.stdout)
        self.assertEqual(result.stdout.count('contains ' + self.sha), 5)
        self.assertIn('public health: ok', result.stdout)
        # The deploy tool's SSH path: default root account, the registered mini then M3 host
        self.assertEqual(hosts, ['root@100.116.119.93', 'root@100.92.77.66'])
        self.assertEqual(paths, ['/api/health'])
        self.assertNotIn(SECRET, result.stdout + result.stderr)

    def test_public_status_only_body_is_enough_and_a_public_503_fails(self):
        result, _hosts, _paths = self.verify(self.fleet(), public=(503, {'status': 'error'}))
        self.assertEqual(result.returncode, 22)
        self.assertIn('Public health request failed', result.stderr)
        result, _hosts, _paths = self.verify(self.fleet(), public=(200, {'status': 'error'}))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Public health is not ready.', result.stderr)

    def test_any_container_without_the_commit_or_not_ready_fails_before_the_public_check(self):
        cases = {
            'release_unknown': (self.fleet(r4=web('bc', 'm3-web', '0' * 40)), 'is unavailable locally'),
            'not_ready': (self.fleet(r3=web('bb', 'm3-web', self.sha, http=503, status='error')), 'direct health is not ready'),
            'wrong_identity': (self.fleet(r1=web('ab', 'mini-web', self.sha, reported='m3-web')), 'unexpected instance identity'),
            'invalid_release': (self.fleet(r2=web('ba', 'm3-web', 'unknown')), 'invalid release identity'),
        }
        for name, (containers, message) in cases.items():
            with self.subTest(name):
                result, _hosts, paths = self.verify(containers)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(paths, [])

    def test_a_server_without_its_web_containers_or_unreachable_fails(self):
        result, _hosts, _paths = self.verify([row for row in self.fleet() if 'mini-web' not in row['env'][0]])
        self.assertEqual(result.returncode, 1)
        self.assertIn('mini-web: no running web container was found on its server.', result.stderr)
        result, _hosts, _paths = self.verify(self.fleet(), ssh_fail=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('mini-web: could not read the web containers on their server (RuntimeError).', result.stderr)

    def test_rejects_bad_arguments_before_any_ssh(self):
        result = subprocess.run(['bash', str(SCRIPT), 'not-a-commit'], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
