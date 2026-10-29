"""Replaced-path hop readback: decisions only, with every host command faked. No SSH, docker, launchctl or systemd call."""
import hashlib
import importlib.util
import io
import json
import pathlib
import time
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'ops' / 'replaced-path' / 'collect_hop.py'
spec = importlib.util.spec_from_file_location('collect_hop', PATH)
hop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hop)


def fake_run(table):
    def run(args):
        for prefix, out in table.items():
            if ' '.join(args).startswith(prefix):
                if isinstance(out, Exception):
                    raise out
                return out
        raise AssertionError('unexpected command: ' + ' '.join(args))
    return run


def lstart(epoch):
    return time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(epoch))


class ContainerTest(unittest.TestCase):
    def table(self, running, tasks):
        return {
            'docker ps -q --no-trunc --filter label=com.docker.swarm.service.name=svc': '\n'.join(running) + '\n',
            'docker service ps svc': '\n'.join(json.dumps(t) for t in tasks) + '\n',
            'docker inspect --format {{json .State}}': json.dumps({'Running': True, 'Pid': 42, 'StartedAt': '2026-10-29T13:47:07.231090194Z'}),
        }

    def test_floors_start_to_milliseconds_and_reads_no_env(self):
        tasks = [{'ID': 't1', 'DesiredState': 'Running', 'CurrentState': 'Running 1 minute ago'}, {'ID': 't0', 'DesiredState': 'Shutdown', 'CurrentState': 'Shutdown'}]
        with mock.patch.object(hop, 'run', fake_run(self.table(['a' * 64], tasks))):
            value = hop.collect({'role': 'owner', 'host': 'm3ultra', 'kind': 'container', 'service': 'svc'})
        self.assertEqual(value['hop']['startedAt'], '2026-10-29T13:47:07.231Z')
        self.assertEqual(value['hop']['incarnationId'], 'a' * 64)
        self.assertEqual(value['hop']['artifactHash'], hashlib.sha256(value['artifact'].encode()).hexdigest())
        self.assertNotIn('Env', value['artifact'])

    def test_second_container_or_task_is_refused(self):
        live = {'ID': 't1', 'DesiredState': 'Running', 'CurrentState': 'Running'}
        for running, tasks, code in ((['a' * 64, 'b' * 64], [live], 'container_count_2'), (['a' * 64], [live, {**live, 'ID': 't2'}], 'running_task_count_2')):
            with mock.patch.object(hop, 'run', fake_run(self.table(running, tasks))):
                with self.assertRaisesRegex(hop.HopError, code):
                    hop.collect({'role': 'owner', 'host': 'm3ultra', 'kind': 'container', 'service': 'svc'})


class MacProcessTest(unittest.TestCase):
    def ps(self, rows):
        return '\n'.join('%d %d %s %s' % (pid, ppid, lstart(start), comm) for pid, ppid, start, comm in rows) + '\n'

    def launchctl(self, out, code=0):
        return mock.patch.object(hop.subprocess, 'run', return_value=mock.Mock(returncode=code, stdout=out))

    def test_oldest_descendant_defines_start(self):
        rows = [(1, 0, 100, '/sbin/launchd'), (500, 1, 1_790_000_100, 'omlx-server'), (501, 500, 1_790_000_050, 'helper'), (9, 1, 1_700_000_000, 'other')]
        with mock.patch.object(hop, 'run', fake_run({'/bin/ps': self.ps(rows)})), self.launchctl('\tstate = running\n\tpid = 500\n'):
            value = hop.collect({'role': 'provider', 'host': 'm3ultra', 'kind': 'launchd', 'service': 'gui/501/com.jr.deepseek'})
        self.assertEqual(value['hop']['startedAt'], hop.iso(1_790_000_050 * 1000))
        self.assertEqual(value['hop']['incarnationId'], 'pid:500:1790000100')

    def test_old_copy_outside_the_job_is_refused(self):
        rows = [(500, 1, 1_790_000_100, 'omlx-server'), (77, 1, 1_700_000_000, 'omlx-server')]
        with mock.patch.object(hop, 'run', fake_run({'/bin/ps': self.ps(rows)})), self.launchctl('state = running\npid = 500\n'):
            with self.assertRaisesRegex(hop.HopError, 'second_instance_present'):
                hop.collect({'role': 'provider', 'host': 'm3ultra', 'kind': 'launchd', 'service': 'gui/501/com.jr.deepseek'})

    def test_unloaded_relay_is_absent_only_when_allowed(self):
        request = {'role': 'relay', 'host': 'm1studio', 'kind': 'launchd', 'service': 'system/bot.brut.nmv-llm-relay'}
        with self.launchctl('', code=113):
            with self.assertRaisesRegex(hop.HopError, 'service_absent'):
                hop.collect(request)
            value = hop.collect({**request, 'allowAbsent': True})
        self.assertEqual((value['hop']['incarnationId'], value['hop']['startedAt'], value['hop']['idle']), ('absent', None, None))
        self.assertEqual(value['hop']['artifactHash'], hashlib.sha256(value['artifact'].encode()).hexdigest())

    def test_loaded_job_without_a_process_is_absent(self):
        with self.launchctl('\tstate = not running\n'):
            value = hop.collect({'role': 'relay', 'host': 'm1studio', 'kind': 'launchd', 'service': 'system/bot.brut.nmv-llm-relay', 'allowAbsent': True})
        self.assertIsNone(value['hop']['startedAt'])

    def test_omlx_idle_counters_never_leave_the_token(self):
        rows = [(500, 1, 1_790_000_100, 'omlx-server')]
        settings = io.StringIO(json.dumps({'auth': {'api_key': 'secret-token'}, 'server': {'port': 8010}}))
        status = {'active_requests': 0, 'waiting_requests': 0, 'status': 'ok'}
        with mock.patch.object(hop, 'run', fake_run({'/bin/ps': self.ps(rows)})), self.launchctl('state = running\npid = 500\n'), \
                mock.patch('builtins.open', return_value=settings), mock.patch.object(hop, 'get_json', return_value=status) as get:
            value = hop.collect({'role': 'provider', 'host': 'm3ultra', 'kind': 'launchd', 'service': 'gui/501/com.jr.deepseek',
                                 'idle': {'type': 'omlx-status', 'settings': '/x/settings.json'}})
        self.assertIs(value['hop']['idle'], True)
        self.assertEqual(get.call_args.args, ('http://127.0.0.1:8010/api/status', 'secret-token'))
        self.assertNotIn('secret-token', value['artifact'])

    def test_listener_needs_exactly_one_owner(self):
        result = mock.Mock(stdout='p10\np11\n')
        with mock.patch.object(hop.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(hop.HopError, 'listener_count_2'):
                hop.collect({'role': 'provider', 'host': 'm1studio', 'kind': 'listener', 'service': 'tcp:127.0.0.1:8000'})


class SystemdTest(unittest.TestCase):
    def test_oldest_cgroup_process_defines_start(self):
        props = 'ActiveState=active\nSubState=running\nMainPID=20\nInvocationID=abc123\nControlGroup=/system.slice/vllm.service\n'
        files = {'/sys/fs/cgroup/system.slice/vllm.service/cgroup.procs': '20\n21\n', '/proc/stat': 'cpu 1\nbtime 1790000000\n',
                 '/proc/20/stat': '20 (vllm) S ' + ' '.join(['0'] * 18) + ' 50000 0', '/proc/21/stat': '21 (worker x) S ' + ' '.join(['0'] * 18) + ' 30000 0'}
        with mock.patch.object(hop, 'run', fake_run({'systemctl show vllm.service': props})), \
                mock.patch('builtins.open', lambda path, *a, **k: io.StringIO(files[path])), mock.patch.object(hop.os, 'sysconf', return_value=100):
            value = hop.collect({'role': 'provider', 'host': 'supa', 'kind': 'systemd', 'service': 'vllm.service'})
        self.assertEqual(value['hop']['startedAt'], hop.iso((1_790_000_000 + 300) * 1000))
        self.assertEqual(value['hop']['incarnationId'], 'abc123')


class IdleTest(unittest.TestCase):
    METRICS = ('# HELP vllm:num_requests_running x\nvllm:num_requests_running{engine="0",model_name="m"} %s\n'
               'vllm:num_requests_waiting{engine="0",model_name="m"} %s\nvllm:num_requests_waiting_by_reason{reason="capacity"} 5.0\n')

    def test_vllm_counts_ignore_by_reason_series(self):
        with mock.patch.object(hop, 'get_json', return_value=self.METRICS % ('0.0', '0.0')):
            self.assertEqual(hop.idle_counts({'type': 'vllm-metrics', 'port': 8000}), {'type': 'vllm-metrics', 'running': 0.0, 'waiting': 0.0})
        with mock.patch.object(hop, 'get_json', return_value=self.METRICS % ('1.0', '0.0')):
            self.assertEqual(hop.idle_counts({'type': 'vllm-metrics', 'port': 8000})['running'], 1.0)

    def test_unknown_probe_is_refused(self):
        with self.assertRaisesRegex(hop.HopError, 'idle_probe_denied'):
            hop.idle_counts({'type': 'shell'})


class RequestTest(unittest.TestCase):
    def test_request_shape_and_service_are_strict(self):
        for request, code in (({'role': 'owner', 'host': 'h', 'kind': 'container', 'service': 's', 'extra': 1}, 'request_shape'),
                              ({'role': 'owner', 'host': 'h', 'kind': 'shell', 'service': 's'}, 'request_denied'),
                              ({'role': 'owner', 'host': 'h', 'kind': 'container', 'service': 's; rm -rf /'}, 'request_denied')):
            with self.assertRaisesRegex(hop.HopError, code):
                hop.collect(request)


if __name__ == '__main__':
    unittest.main()
