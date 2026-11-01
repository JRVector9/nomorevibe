"""Offline observation/Engine contracts using sanitized Docker 29 inspect shapes.

The fixture shape was checked against existing M3 web/monitor services with GET
and inspect only. No test contacts a Docker socket, SSH host, DB, or model.
"""
import copy
from datetime import datetime, timezone
import importlib.util
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
NOW = datetime(2026, 10, 25, 8, 0, tzinfo=timezone.utc).timestamp()
SERVICE_ID = '0123456789abcdefghijklmno'
IDS = ['a' * 12, 'b' * 12]


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, OPS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def timestamp(seconds_ago):
    return datetime.fromtimestamp(NOW - seconds_ago, timezone.utc).isoformat().replace('+00:00', 'Z')


class DockerFixture:
    def __init__(self, gateway, kind='web', replicas=2):
        self.gateway = gateway
        self.cfg = {'service': 'fixture-web' if kind == 'web' else 'fixture-monitor',
                    'kind': kind, 'replicas': replicas}
        self.service = {
            'ID': SERVICE_ID, 'Version': {'Index': 217070},
            # Docker's actual timestamps have 7-9 decimal places, not just the
            # microseconds accepted by many hand-written ISO parsers.
            'UpdatedAt': '2026-10-24T23:26:55.604419766Z',
            'UpdateStatus': {'State': 'completed',
                             'StartedAt': '2026-10-24T23:25:46.620988232Z',
                             'CompletedAt': '2026-10-24T23:26:55.604414975Z'},
            'Spec': {'Name': self.cfg['service'], 'Mode': {'Replicated': {'Replicas': replicas}},
                     'TaskTemplate': {'ForceUpdate': 4, 'ContainerSpec': {
                         'Image': 'fixture.invalid/pinned@sha256:' + '0' * 64,
                         'Labels': {'fixture': 'private-marker'},
                         'StopGracePeriod': 30000000000},
                         'RestartPolicy': {'Condition': 'any', 'Delay': 5000000000},
                         'Resources': {'Limits': {'MemoryBytes': 536870912}},
                         'Placement': {'Constraints': ['node.role==manager']},
                         'Networks': [{'Target': 'fixture-network'}], 'Runtime': 'container'},
                     'UpdateConfig': {'Parallelism': 1, 'Order': 'start-first', 'FailureAction': 'pause'},
                     'RollbackConfig': {'Parallelism': 1, 'FailureAction': 'pause'},
                     'EndpointSpec': {'Mode': 'vip', 'Ports': [{'Protocol': 'tcp', 'TargetPort': 3000}]}}}
        self.ids = IDS[:replicas]
        self.containers = [{'Id': cid + '0' * 52,
                            'State': {'Status': 'running', 'Running': True,
                                      'StartedAt': '2026-10-24T23:26:20.2137613Z',
                                      'Health': {'Status': 'healthy'}}} for cid in self.ids]
        self.web = {cid: {'ready': True, 'db': 'unknown', 'page': True} for cid in self.ids}
        self.monitor = {cid: {'fresh': True, 'overall': 'ok'} for cid in self.ids}
        self.calls = []

    def run(self, argv):
        self.calls.append(argv)
        if argv == ['docker', 'service', 'inspect', self.cfg['service']]:
            return json.dumps([self.service])
        if argv == ['docker', 'ps', '--filter', 'label=com.docker.swarm.service.id=' + SERVICE_ID,
                    '--filter', 'status=running', '--format', '{{.ID}}']:
            return '\n'.join(self.ids)
        if argv == ['docker', 'inspect', *self.ids]:
            return json.dumps(self.containers)
        if len(argv) == 6 and argv[:2] == ['docker', 'exec'] and argv[3:5] == ['node', '-e']:
            if argv[5] == self.gateway.WEB_PROBE:
                return json.dumps(self.web[argv[2]])
            if argv[5] == self.gateway.MONITOR_PROBE:
                return json.dumps(self.monitor[argv[2]])
        raise AssertionError('unexpected probe command')

    def observe(self):
        return self.gateway.observe(self.cfg['kind'], self.cfg, run=self.run, now=NOW)


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.g = load_module('recovery_gateway')
        self.f = DockerFixture(self.g)

    def test_real_inspect_shape_is_healthy_and_report_is_constrained(self):
        row = self.f.observe()
        self.assertEqual(row, {'key': 'web', 'version': 217070, 'replicas': 2, 'settled': True,
                               'ok': True, 'recoverable': False, 'reason': 'ok'})
        self.assertNotIn('private-marker', json.dumps(row))
        sys.path.insert(0, str(OPS))
        try:
            watchdog = load_module('oracle_watchdog')
        finally:
            sys.path.remove(str(OPS))
        self.assertEqual(watchdog.validate_report({'services': [row]}), {'services': [row]})
        self.assertEqual(len([call for call in self.f.calls if call[:2] == ['docker', 'exec']]), 2)

    def test_db_503_and_unknown_readiness_are_alarm_only(self):
        for check, reason in [({'ready': False, 'db': 'unavailable', 'page': False}, 'database_unavailable'),
                              ({'ready': False, 'db': 'unknown', 'page': False}, 'web_not_ready')]:
            with self.subTest(reason=reason):
                self.f.web[IDS[1]] = check
                row = self.f.observe()
                self.assertEqual(row['reason'], reason)
                self.assertFalse(row['ok'])
                self.assertFalse(row['recoverable'])

    def test_only_a_ready_old_settled_web_with_home_failure_can_recover(self):
        self.f.web[IDS[1]]['page'] = False
        self.assertEqual(self.f.observe()['reason'], 'web_page_failed')
        self.assertTrue(self.f.observe()['recoverable'])
        for field, value in [('UpdateStatus', {'State': 'updating'}),
                             ('UpdateStatus', {'State': 'paused'}),
                             ('UpdatedAt', timestamp(179))]:
            original = copy.deepcopy(self.f.service.get(field))
            with self.subTest(field=field, value=value):
                self.f.service[field] = value
                row = self.f.observe()
                self.assertFalse(row['settled'])
                self.assertFalse(row['recoverable'])
            self.f.service[field] = original

    def test_intent_zero_and_missing_replicas_never_dispatch_node_probe(self):
        self.f.service['Spec']['Mode']['Replicated']['Replicas'] = 0
        self.assertEqual(self.f.observe()['reason'], 'replica_intent_changed')
        self.assertFalse(self.f.observe()['recoverable'])
        self.f.service['Spec']['Mode']['Replicated']['Replicas'] = 2
        self.f.ids = [IDS[0]]
        self.assertEqual(self.f.observe()['reason'], 'replicas_missing')
        self.assertFalse(any(call[:2] == ['docker', 'exec'] for call in self.f.calls))

    def test_young_or_unparseable_container_start_never_recovers(self):
        self.f.web[IDS[1]]['page'] = False
        for started in [timestamp(179), timestamp(-5), 'not-a-date', None]:
            with self.subTest(started=started):
                self.f.containers[1]['State']['StartedAt'] = started
                row = self.f.observe()
                self.assertEqual(row['reason'], 'warming_up')
                self.assertFalse(row['recoverable'])

    def test_age_boundary_and_absent_docker_health_are_explicit(self):
        self.f.web[IDS[1]]['page'] = False
        self.f.service['UpdatedAt'] = timestamp(180)
        for row in self.f.containers:
            row['State']['StartedAt'] = timestamp(180)
        self.assertTrue(self.f.observe()['recoverable'])
        # Existing M3 web replicas have no State.Health. Current full readiness
        # plus a working home page is sufficient; missing Docker metadata must
        # not produce a permanent false alarm or a recovery request.
        self.f.web[IDS[1]]['page'] = True
        for row in self.f.containers:
            row['State'].pop('Health')
        row = self.f.observe()
        self.assertTrue(row['ok'])
        self.assertFalse(row['recoverable'])
        for row in self.f.containers:
            row['State']['Health'] = {'Status': 'unhealthy'}
        row = self.f.observe()
        self.assertTrue(row['ok'])
        self.assertFalse(row['recoverable'])

    def test_monitor_staleness_recovers_but_fresh_pipeline_alarm_does_not(self):
        self.f = DockerFixture(self.g, kind='monitor', replicas=1)
        for check, reason, ok, recoverable in [
                ({'fresh': False, 'overall': 'unknown'}, 'monitor_stale', False, True),
                ({'fresh': True, 'overall': 'alarm'}, 'pipeline_alarm', False, False),
                ({'fresh': True, 'overall': 'unknown'}, 'pipeline_alarm', False, False),
                ({'fresh': True, 'overall': 'ok'}, 'ok', True, False)]:
            with self.subTest(check=check):
                self.f.monitor[IDS[0]] = check
                row = self.f.observe()
                self.assertEqual((row['reason'], row['ok'], row['recoverable']), (reason, ok, recoverable))

    def test_worker_still_requires_docker_health_and_never_receives_web_probe(self):
        self.f.cfg['kind'] = 'worker'
        self.assertTrue(self.f.observe()['ok'])
        self.f.containers[1]['State'].pop('Health')
        row = self.f.observe()
        self.assertEqual(row['reason'], 'container_unhealthy')
        self.assertFalse(row['ok'])
        self.assertFalse(row['recoverable'])
        self.assertFalse(any(call[:2] == ['docker', 'exec'] for call in self.f.calls))

    def test_fresh_monitor_with_bad_container_health_is_an_explicit_alarm_only_fault(self):
        self.f = DockerFixture(self.g, kind='monitor', replicas=2)
        for health in [{'Status': 'unhealthy'}, {'Status': 'starting'}, None]:
            with self.subTest(health=health):
                if health is None:
                    self.f.containers[1]['State'].pop('Health', None)
                else:
                    self.f.containers[1]['State']['Health'] = health
                row = self.f.observe()
                self.assertEqual((row['reason'], row['ok'], row['recoverable']),
                                 ('container_unhealthy', False, False))
                self.f.monitor[IDS[1]]['overall'] = 'alarm'
                row = self.f.observe()
                self.assertEqual((row['reason'], row['ok'], row['recoverable']),
                                 ('pipeline_alarm', False, False))
                self.f.monitor[IDS[1]]['overall'] = 'ok'

    def test_partial_or_wrong_inspect_results_fail_closed(self):
        original = copy.deepcopy(self.f.containers)
        for rows in [[], original[:1], [original[0], original[0]],
                     [{**original[0], 'Id': 'f' * 64}, original[1]]]:
            with self.subTest(rows=len(rows)):
                self.f.containers = rows
                row = self.f.observe()
                self.assertFalse(row['ok'])
                self.assertFalse(row['recoverable'])

    def test_every_monitor_replica_is_observed(self):
        self.f = DockerFixture(self.g, kind='monitor', replicas=2)
        self.f.monitor[IDS[1]]['fresh'] = False
        row = self.f.observe()
        self.assertEqual(row['reason'], 'monitor_stale')
        self.assertTrue(row['recoverable'])
        self.f.monitor[IDS[1]] = {'fresh': True, 'overall': 'alarm'}
        row = self.f.observe()
        self.assertEqual(row['reason'], 'pipeline_alarm')
        self.assertFalse(row['ok'])
        self.assertFalse(row['recoverable'])


class NodeProbeTests(unittest.TestCase):
    def setUp(self):
        self.g = load_module('recovery_gateway')

    def web_probe(self, *, hostname='fixture-container', health=200, page=200,
                  db='ok', throw_health=False):
        # fetch is replaced before the exact production script executes. The
        # fake performs no HTTP but checks the actual generated request URLs.
        prelude = ('const calls=[];const log=console.log;'
                   'console.log=value=>log(JSON.stringify({probe:JSON.parse(value),calls}));'
                   'globalThis.fetch=async(url,options)=>{calls.push({url,redirect:options.redirect,signal:!!options.signal});'
                   'if(new URL(url).pathname===\'/api/health\'){'
                   + ('throw new Error("connection refused");' if throw_health else
                      'return {ok:' + json.dumps(health == 200) + ',json:async()=>({status:"ok",db:' + json.dumps(db) + '})};')
                   + '}return {ok:' + json.dumps(page == 200) + ',body:{cancel:async()=>{}}};};')
        env = {'PATH': os.environ.get('PATH', '')}
        if hostname is not None:
            env['HOSTNAME'] = hostname
        result = subprocess.run(['node', '-e', prelude + self.g.WEB_PROBE], capture_output=True,
                                text=True, timeout=10, env=env, check=True)
        return json.loads(result.stdout)

    def test_web_uses_actual_container_bind_host_and_disables_redirects(self):
        for hostname, host in [('fixture-container', 'fixture-container'), (None, '127.0.0.1')]:
            with self.subTest(host=host):
                result = self.web_probe(hostname=hostname)
                self.assertEqual(result['probe'], {'ready': True, 'db': 'unknown', 'page': True})
                self.assertEqual({row['url'] for row in result['calls']},
                                 {'http://' + host + ':3000/api/health', 'http://' + host + ':3000/'})
                self.assertTrue(all(row['redirect'] == 'error' and row['signal'] for row in result['calls']))

    def test_actual_web_script_distinguishes_db_failure_home_500_and_connection_failure(self):
        self.assertEqual(self.web_probe(health=503, db='unavailable')['probe'],
                         {'ready': False, 'db': 'unavailable', 'page': True})
        self.assertEqual(self.web_probe(page=500)['probe'],
                         {'ready': True, 'db': 'unknown', 'page': False})
        self.assertEqual(self.web_probe(throw_health=True)['probe'],
                         {'ready': False, 'db': 'unknown', 'page': True})

    def test_actual_monitor_script_checks_age_and_safe_integer_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'heartbeat.json'
            for checked_at, fresh in [(1_000_000, True), (910_001, True), (910_000, False),
                                       (1_001_001, False), ('1000000', False)]:
                with self.subTest(checked_at=checked_at):
                    path.write_text(json.dumps({'checkedAt': checked_at, 'overall': 'alarm'}))
                    result = subprocess.run(['node', '-e', 'Date.now=()=>1000000;' + self.g.MONITOR_PROBE],
                                            capture_output=True, text=True, timeout=10, check=True,
                                            env={'PATH': os.environ.get('PATH', ''), 'MONITOR_HEALTH_PATH': str(path)})
                    self.assertEqual(json.loads(result.stdout), {'fresh': fresh, 'overall': 'alarm'})


class EngineProtocolTests(unittest.TestCase):
    def setUp(self):
        self.g = load_module('recovery_gateway')
        # Fail before any process can start even if the command implementation
        # changes. Protocol tests must never contact the developer's Docker.
        guard = patch.object(self.g.subprocess, 'Popen', side_effect=AssertionError('real process forbidden in Engine protocol tests'))
        guard.start()
        self.addCleanup(guard.stop)

    def test_dial_stdio_posts_content_length_delimited_json_and_parses_http_response(self):
        path = '/v1.45/services/' + SERVICE_ID + '/update?version=217070&registryAuthFrom=spec'
        body = {'Name': 'fixture-web', 'Labels': {'label': '\ud55c\uae00'}}
        raw = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"Warnings":[]}'
        with patch.object(self.g, 'bounded_output', return_value=raw) as run:
            self.assertEqual(self.g.docker_http(path, body), 200)
        self.assertEqual(run.call_args.args[0], ['docker', 'system', 'dial-stdio'])
        self.assertEqual(run.call_args.kwargs['limit'], 65536)
        request = run.call_args.kwargs['payload']
        head, payload = request.split(b'\r\n\r\n', 1)
        self.assertEqual(head.split(b'\r\n', 1)[0], ('POST ' + path + ' HTTP/1.1').encode())
        headers = dict(line.split(b': ', 1) for line in head.split(b'\r\n')[1:])
        self.assertEqual(int(headers[b'Content-Length']), len(payload))
        self.assertEqual(headers[b'Connection'], b'close')
        self.assertEqual(json.loads(payload), body)
        self.assertNotIn(b'X-Registry-Auth', head)

    def test_engine_cas_conflict_and_ambiguous_server_failures_never_report_requested(self):
        fixture = DockerFixture(self.g)
        original = copy.deepcopy(fixture.service['Spec'])
        for status, outcome in [(200, 'requested'), (409, 'refused'), (500, 'unknown'), (503, 'unknown')]:
            with self.subTest(status=status):
                sent = []
                result = self.g.force_update(fixture.cfg, 217070, run=fixture.run,
                                            exchange=lambda path, body: sent.append((path, body)) or status)
                self.assertEqual(result, {'result': outcome})
                self.assertEqual(sent[0][0], '/v1.45/services/' + SERVICE_ID + '/update?version=217070&registryAuthFrom=spec')
                expected = copy.deepcopy(original)
                expected['TaskTemplate']['ForceUpdate'] += 1
                self.assertEqual(sent[0][1], expected)

    def test_command_failures_and_invalid_stdio_response_are_not_success(self):
        for error in ['bounded_command_failed', 'command_output_exceeded']:
            with self.subTest(error=error):
                with patch.object(self.g, 'bounded_output', side_effect=ValueError(error)):
                    with self.assertRaises(ValueError):
                        self.g.docker_http('/v1.45/services/fixture/update?version=1', {})
        with patch.object(self.g, 'bounded_output', return_value=b'not HTTP\r\n'):
            with self.assertRaises(http.client.HTTPException):
                self.g.docker_http('/v1.45/services/fixture/update?version=1', {})


if __name__ == '__main__':
    unittest.main()
