"""Opt-in real Engine acceptance, confined to an explicitly named local dind.

RECOVERY_LIVE_DOCKER_HOST=tcp://127.0.0.1:<port>
RECOVERY_LIVE_ENGINE_NAME=<isolated dind hostname> python3 tests/test_recovery_live_engine.py

The caller creates/initializes the isolated daemon and loads node:24.22.1-alpine.
No Docker context is changed. This test waits the real 180-second age gate.
"""
import copy
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from urllib.parse import urlsplit

OPS = Path(__file__).resolve().parents[1] / 'scripts/ops'
sys.path.insert(0, str(OPS))
import oracle_watchdog as watchdog  # noqa: E402

SERVER = """const fs=require('fs'),http=require('http');
const seen=fs.existsSync('/state/started');fs.writeFileSync('/state/started','1');
http.createServer((req,res)=>{if(req.url==='/api/health'){
res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',db:'ok'}));
}else{res.statusCode=seen?200:500;res.end(seen?'recovered':'fixture failure');}}).listen(3000,'0.0.0.0');"""


@unittest.skipUnless(os.environ.get('RECOVERY_LIVE_DOCKER_HOST'), 'requires explicitly isolated local dind')
class LiveEngineTests(unittest.TestCase):
    def docker(self, *args, timeout=40):
        return subprocess.check_output(['docker', *args], env=self.env, text=True, timeout=timeout).strip()

    def gateway(self, action, *, code=None):
        env = {**self.env, 'SSH_ORIGINAL_COMMAND': action}
        argv = [sys.executable, str(OPS / 'recovery_gateway.py'), '--config', str(self.config_path)]
        if code is not None:
            argv = [sys.executable, '-c', code, str(self.config_path), *action.split()[1:]]
        return json.loads(subprocess.check_output(argv, env=env, text=True, timeout=100))

    def inspect(self, name):
        return json.loads(self.docker('service', 'inspect', name))[0]

    def wait_for(self, read, ready, timeout=90):
        end = time.monotonic() + timeout
        while True:
            result = read()
            if ready(result):
                return result
            self.assertLess(time.monotonic(), end, f'fixture deadline: {result}')
            time.sleep(2)

    def task(self, name):
        ids = self.docker('ps', '--filter', 'label=com.docker.swarm.service.name=' + name,
                          '--filter', 'status=running', '--format', '{{.ID}}').split()
        return ids[0] if len(ids) == 1 else None

    def setUp(self):
        endpoint = os.environ['RECOVERY_LIVE_DOCKER_HOST']
        self.assertRegex(endpoint, r'^tcp://127[.]0[.]0[.]1:[0-9]{2,5}$')
        expected = os.environ.get('RECOVERY_LIVE_ENGINE_NAME')
        self.assertTrue(expected, 'explicit isolated daemon identity required')
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ('DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION')}
        self.env['DOCKER_HOST'] = endpoint
        info = json.loads(self.docker('info', '--format', '{{json .}}'))
        self.assertEqual(info['Name'], expected)
        self.assertEqual(info['Driver'], 'vfs', 'only the disposable vfs dind is permitted')
        self.assertEqual(info['Swarm']['LocalNodeState'], 'active')
        self.assertTrue(info['Swarm']['ControlAvailable'])
        self.docker('image', 'inspect', 'node:24.22.1-alpine')
        self.tmp = tempfile.TemporaryDirectory(prefix='nomorevibe-recovery-live-')
        self.addCleanup(self.tmp.cleanup)
        self.config_path = Path(self.tmp.name) / 'gateway.json'
        self.prefix = 'nmv-recovery-live-' + uuid.uuid4().hex[:10]
        self.services = []
        self.addCleanup(self.cleanup_services)
        cfg = {'state': str(Path(self.tmp.name) / 'gateway-state.json'), 'services': {}}
        for key in ('web', 'timeout', 'worker'):
            name = self.prefix + '-' + key
            self.services.append(name)
            argv = ['service', 'create', '--quiet', '--no-resolve-image', '--name', name,
                    '--label', 'nomorevibe.recovery.fixture=live-test', '--replicas', '1',
                    '--limit-memory', '96M', '--limit-cpu', '0.15', '--stop-grace-period', '3s',
                    '--update-order', 'start-first', '--update-parallelism', '1', '--update-monitor', '3s',
                    '--health-cmd', "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1))\"",
                    '--health-interval', '2s', '--health-retries', '3', '--health-start-period', '1s',
                    '--mount', 'type=volume,source=' + name + ',target=/state',
                    'node:24.22.1-alpine', 'node', '-e', SERVER]
            self.docker(*argv, timeout=90)
            cfg['services'][key] = {'service': name, 'kind': 'worker' if key == 'worker' else 'web', 'replicas': 1}
        self.config_path.write_text(json.dumps(cfg))
        self.config_path.chmod(0o600)
        self.config = cfg

    def cleanup_services(self):
        for name in self.services:
            if re.fullmatch(r'nmv-recovery-live-[a-f0-9]{10}-(web|timeout|worker)', name):
                try:
                    self.docker('service', 'rm', name)
                except (subprocess.SubprocessError, OSError):
                    pass
        # Volumes live only in the disposable daemon and disappear with it.

    def test_real_cas_recovery_and_timeout_budget(self):
        started = time.monotonic()
        initial = self.gateway('probe')
        self.assertTrue(any(row['reason'] == 'warming_up' for row in initial['services']))
        self.assertFalse(any(row['recoverable'] for row in initial['services']))
        print(json.dumps({'event': 'recovery.live_age_gate_wait', 'seconds': 180}), flush=True)
        report = self.wait_for(lambda: self.gateway('probe'),
                               lambda value: all(row['settled'] and row['reason'] != 'warming_up' for row in value['services']),
                               timeout=230)
        by_key = {row['key']: row for row in report['services']}
        self.assertEqual(by_key['web']['reason'], 'web_page_failed')
        self.assertTrue(by_key['web']['recoverable'])
        self.assertTrue(by_key['worker']['ok'])
        before = self.inspect(self.config['services']['web']['service'])
        task_before = self.task(before['Spec']['Name'])
        worker_before = self.inspect(self.config['services']['worker']['service'])
        self.assertEqual(self.gateway('recover worker ' + str(by_key['worker']['version'])), {'result': 'refused'})
        self.assertEqual(self.inspect(worker_before['Spec']['Name'])['Spec'], worker_before['Spec'])

        stale = before['Version']['Index'] - 1
        self.assertEqual(self.gateway('recover web ' + str(stale)), {'result': 'refused'})
        self.assertEqual(self.inspect(before['Spec']['Name'])['Spec'], before['Spec'])
        target = urlsplit(self.env['DOCKER_HOST'])
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=10)
        stale_spec = copy.deepcopy(before['Spec'])
        stale_spec['TaskTemplate']['ForceUpdate'] = stale_spec['TaskTemplate'].get('ForceUpdate', 0) + 1
        try:
            connection.request('POST', '/v1.45/services/' + before['ID'] + '/update?version=' + str(stale) + '&registryAuthFrom=spec',
                               body=json.dumps(stale_spec), headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            cas = {'status': response.status, 'body': json.loads(response.read(65536))}
        finally:
            connection.close()
        self.assertIn(cas['status'], (409, 500))
        self.assertRegex(cas['body'].get('message', '').lower(), r'update out of sequence|version|conflict')
        self.assertEqual(self.inspect(before['Spec']['Name'])['Spec'], before['Spec'])

        state = {'targets': {}}
        oracle_config = {'state': str(Path(self.tmp.name) / 'oracle-state.json'), 'recover': True,
                         'hosts': {'fixture': {'services': list(self.config['services'])}}}
        requested = []

        def recover(_host, key, version):
            result = self.gateway(f'recover {key} {version}')
            requested.append((key, result))
            return result

        # Only web is actionable here; timeout fixture is handled below with an explicitly lost acknowledgement.
        web_report = {'services': [by_key['web'], by_key['worker']]}
        for _ in range(3):
            watchdog.cycle(oracle_config, state, {'fixture': web_report}, recover=recover)
        self.assertEqual(requested, [('web', {'result': 'requested'})])
        self.wait_for(lambda: self.task(before['Spec']['Name']), lambda value: value is not None and value != task_before)
        after = self.wait_for(lambda: self.inspect(before['Spec']['Name']),
                              lambda value: value.get('UpdateStatus', {}).get('State') == 'completed')
        expected_spec = copy.deepcopy(before['Spec'])
        expected_spec['TaskTemplate']['ForceUpdate'] = before['Spec']['TaskTemplate'].get('ForceUpdate', 0) + 1
        self.assertEqual(after['Spec'], expected_spec)
        self.assertNotEqual(after['Version']['Index'], before['Version']['Index'])
        container = self.task(before['Spec']['Name'])
        checks = json.loads(self.docker('exec', container, 'node', '-e',
                                       "Promise.all(['/api/health','/'].map(p=>fetch('http://127.0.0.1:3000'+p).then(r=>r.status))).then(s=>console.log(JSON.stringify(s)))"))
        self.assertEqual(checks, [200, 200])
        self.assertEqual(self.gateway('recover web ' + str(after['Version']['Index'])), {'result': 'limited'})

        timeout_before = self.inspect(self.config['services']['timeout']['service'])
        timeout_task = self.task(timeout_before['Spec']['Name'])
        lost_ack = """import json,sys;sys.path.insert(0,""" + repr(str(OPS)) + """);import recovery_gateway as g
c=json.load(open(sys.argv[1]))
def lost(cfg,version):
 r=g.force_update(cfg,version)
 assert r=={'result':'requested'},r
 raise TimeoutError('fixture acknowledgement lost after real Engine accepted')
print(json.dumps(g.recover(c,sys.argv[2],int(sys.argv[3]),force_fn=lost)))"""
        self.assertEqual(self.gateway('recover timeout ' + str(timeout_before['Version']['Index']), code=lost_ack), {'result': 'unknown'})
        self.assertEqual(self.gateway('recover timeout ' + str(timeout_before['Version']['Index'])), {'result': 'limited'})
        self.wait_for(lambda: self.task(timeout_before['Spec']['Name']), lambda value: value is not None and value != timeout_task)
        timeout_after = self.inspect(timeout_before['Spec']['Name'])
        self.assertEqual(timeout_after['Spec']['TaskTemplate']['ForceUpdate'], timeout_before['Spec']['TaskTemplate'].get('ForceUpdate', 0) + 1)
        persisted = json.loads(Path(self.config['state']).read_text())
        self.assertEqual({key: len(value) for key, value in persisted['attempts'].items()}, {'web': 1, 'timeout': 1})
        self.assertEqual(self.inspect(worker_before['Spec']['Name'])['Spec'], worker_before['Spec'])
        print(json.dumps({'event': 'recovery.live_engine_pass', 'engine': self.env['DOCKER_HOST'],
                          'api': 'v1.45', 'casStatus': cas['status'], 'specChanges': ['TaskTemplate.ForceUpdate'],
                          'taskReplaced': True, 'healthStatuses': checks, 'workerRecovery': 'refused',
                          'lostAck': 'injected after accepted real mutation; repeat limited',
                          'elapsedSeconds': round(time.monotonic() - started, 2)}), flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
