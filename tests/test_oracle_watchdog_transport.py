import contextlib
import importlib.util
import io
import json
import inspect
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'scripts/ops/oracle_watchdog.py'


class FakeSocket:
    def __init__(self):
        self.stopped = threading.Event()

    def shutdown(self, _how):
        self.stopped.set()


class FakeResponse:
    def __init__(self, connection):
        self.connection = connection
        self.status = connection.status

    def read(self, limit):
        self.connection.read_limits.append(limit)
        if self.connection.stall == 'body':
            if not self.connection.sock.stopped.wait(1):
                raise RuntimeError('response_never_interrupted')
            raise TimeoutError('private-token receiver-secret')
        return self.connection.body[:limit]


class FakeConnection:
    status = 200
    body = b'{"ok":true}'
    stall = None
    instances = []

    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock = FakeSocket()
        self.requests = []
        self.read_limits = []
        self.closed = False
        self.instances.append(self)

    def connect(self):
        pass

    def request(self, method, path, body):
        self.requests.append((method, path, body))

    def getresponse(self):
        if self.stall == 'headers':
            if not self.sock.stopped.wait(1):
                raise RuntimeError('headers_never_interrupted')
            raise TimeoutError('private-token receiver-secret')
        return FakeResponse(self)

    def close(self):
        self.closed = True


class WatchdogTransportTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(PATH.parent))
        self.addCleanup(lambda: sys.path.remove(str(PATH.parent)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog_transport', PATH)
        self.w = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.w)
        FakeConnection.status = 200
        FakeConnection.body = b'{"ok":true}'
        FakeConnection.stall = None
        FakeConnection.instances = []
        self.factory = patch.object(self.w.http.client, 'HTTPSConnection', FakeConnection)
        self.factory.start()
        self.addCleanup(self.factory.stop)
        self.url = 'https://receiver.test/api/push/private-token'

    def push(self, ok=True):
        return self.w.push(self.url, ok, deadline_seconds=0.025)

    def test_pipeline_alarm_does_not_mark_live_observer_dead_and_each_receiver_is_attempted(self):
        calls = []
        def send(url, ok):
            calls.append((url, ok))
            return url != 'broken'
        with patch.object(self.w, 'safe_push', send):
            result = self.w.deliver({'pushUrls': ['broken', 'pipeline'], 'heartbeatUrls': ['heartbeat-a', 'heartbeat-b']}, False)
        self.assertCountEqual(calls, [('broken', False), ('pipeline', False), ('heartbeat-a', True), ('heartbeat-b', True)])
        self.assertEqual(result, {'receipts': [False, True], 'heartbeatReceipts': [True, True]})

    def test_success_cancels_deadline_and_limits_response_body(self):
        self.push()
        connection, = FakeConnection.instances
        self.assertEqual(connection.requests, [('POST', '/api/push/private-token?status=up&msg=Oracle+watchdog+healthy', b'')])
        self.assertEqual(connection.read_limits, [8193])
        self.assertTrue(connection.closed)
        self.assertFalse(connection.sock.stopped.wait(0.06), 'completed request retained a shutdown timer')

    def test_redirect_and_non200_responses_are_never_followed(self):
        for status in (301, 302, 307, 308, 403, 500):
            with self.subTest(status=status):
                FakeConnection.status = status
                with self.assertRaises(ValueError):
                    self.push()
                connection = FakeConnection.instances[-1]
                self.assertEqual(connection.host, 'receiver.test')
                self.assertEqual(len(connection.requests), 1)
                self.assertTrue(connection.closed)
        self.assertEqual(len(FakeConnection.instances), 6)

    def test_oversized_and_malformed_acknowledgements_are_rejected(self):
        for body in (json.dumps({'ok': True, 'padding': 'x' * 8192}).encode(), b'{"ok":false}', b'{"ok":1}', b'invalid'):
            with self.subTest(size=len(body)):
                FakeConnection.body = body
                with self.assertRaises((ValueError, TypeError)):
                    self.push()
                self.assertTrue(FakeConnection.instances[-1].closed)

    def test_header_and_body_stalls_are_interrupted_by_absolute_deadline(self):
        for stall in ('headers', 'body'):
            with self.subTest(stall=stall):
                FakeConnection.stall = stall
                started = time.monotonic()
                with self.assertRaises(Exception):
                    self.push()
                elapsed = time.monotonic() - started
                connection = FakeConnection.instances[-1]
                self.assertTrue(connection.sock.stopped.is_set(), 'deadline did not interrupt the socket')
                self.assertTrue(connection.closed)
                self.assertLess(elapsed, 0.5)

    def test_direct_delivery_failure_never_logs_endpoint_or_receiver_error(self):
        FakeConnection.stall = 'body'
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(TimeoutError):
                self.push(False)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
        self.assertTrue(FakeConnection.instances[-1].sock.stopped.is_set())


class WatchdogIsolatedPushTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(PATH.parent))
        self.addCleanup(lambda: sys.path.remove(str(PATH.parent)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog_isolated_push', PATH)
        self.w = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.w)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.source = self.directory / 'oracle_watchdog.py'
        for name in ('recovery_gateway.py', 'incident_notifications.py'):
            shutil.copyfile(PATH.with_name(name), self.directory / name)
        self.url = 'https://receiver.test/api/push/private-token?private-query=receiver-secret'
        self.processes = []
        self.original_popen = subprocess.Popen

    def fixture(self, appended):
        self.source.write_text(PATH.read_text() + '\n' + appended)

    def popen(self, argv, **kwargs):
        process = self.original_popen(argv, **kwargs)
        self.processes.append((process, argv, kwargs))
        return process

    def invoke(self, **kwargs):
        with patch.object(self.w, '__file__', str(self.source)), patch.object(self.w, 'push', return_value=None), \
                patch.object(subprocess, 'Popen', self.popen):
            return self.w.safe_push(self.url, False, **kwargs)

    def assert_reaped(self):
        self.assertTrue(self.processes)
        for process, _, _ in self.processes:
            self.assertIsNotNone(process.returncode)
            with self.assertRaises(ProcessLookupError):
                os.kill(process.pid, 0)

    def test_dns_and_connect_hangs_obey_parent_deadline_and_are_reaped(self):
        self.assertIn('deadline_seconds', inspect.signature(self.w.safe_push).parameters,
                      'safe_push needs a whole-child deadline, including DNS/connect')
        for target in ('socket.getaddrinfo', 'http.client.HTTPSConnection.connect'):
            with self.subTest(target=target):
                marker = self.directory / ('dns' if target.startswith('socket') else 'connect')
                self.fixture('def _hang(*args, **kwargs):\n'
                             '    Path(' + repr(str(marker)) + ').touch()\n'
                             '    time.sleep(60)\n' + target + ' = _hang\n')
                started = time.monotonic()
                self.assertFalse(self.invoke(deadline_seconds=1))
                self.assertTrue(marker.exists(), 'child did not reach the wedged DNS/connect operation')
                self.assertLess(time.monotonic() - started, 2)
                self.assert_reaped()

    def test_url_is_stdin_only_with_empty_env_and_isolated_exact_source_import(self):
        self.fixture('def push(url, ok):\n'
                     '    assert url == ' + repr(self.url) + '\n'
                     '    assert ok is False\n'
                     "    assert 'PRIVATE_ENV_MARKER' not in os.environ\n")
        with patch.dict(os.environ, {'PRIVATE_ENV_MARKER': 'private-token'}):
            self.assertTrue(self.invoke())
        self.assertTrue(self.processes, 'Push must execute in an isolated child')
        process, argv, kwargs = self.processes[0]
        self.assertEqual(argv[:3], [sys.executable, '-I', '-c'])
        self.assertNotIn('private-token', repr(argv))
        self.assertNotIn('receiver-secret', repr(argv))
        self.assertEqual(kwargs['env'], {})
        self.assertIs(kwargs['stderr'], subprocess.DEVNULL)
        self.assertTrue(kwargs['start_new_session'])
        self.assertEqual(process.returncode, 0)

    def test_oversized_child_output_is_stopped_before_its_five_second_deadline(self):
        self.fixture('def push(url, ok):\n'
                     "    print('x' * 262144, flush=True)\n"
                     '    time.sleep(60)\n')
        started = time.monotonic()
        self.assertFalse(self.invoke())
        self.assertLess(time.monotonic() - started, 2)
        self.assert_reaped()

    def test_child_exception_and_stderr_never_expose_url_or_error(self):
        self.fixture('def push(url, ok):\n'
                     '    print(url, file=sys.stderr, flush=True)\n'
                     "    raise RuntimeError('receiver-secret private-token')\n")
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertFalse(self.invoke())
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
        self.assert_reaped()

    def test_invalid_or_oversized_input_never_starts_a_child(self):
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as spawn:
            for deadline in (0, -1, True, float('nan'), float('inf'), 'private-token'):
                self.assertFalse(self.w.safe_push(self.url, True, deadline_seconds=deadline))
            self.assertFalse(self.w.safe_push('https://receiver.test/' + 'x' * 32768, True))
            self.assertFalse(self.w.safe_push(self.url, 'private-token'))
            spawn.assert_not_called()

    def test_descendant_pipe_cannot_outlive_its_finished_leader(self):
        self.fixture('def push(url, ok):\n'
                     "    subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(60)'])\n")
        started = time.monotonic()
        self.assertFalse(self.invoke(deadline_seconds=0.5))
        self.assertLess(time.monotonic() - started, 1.5)
        self.assert_reaped()

    def test_four_stalled_targets_finish_concurrently_within_one_five_second_budget(self):
        self.fixture('def _hang(*args, **kwargs):\n'
                     '    (Path(' + repr(str(self.directory)) + ") / ('pid-' + str(os.getpid()))).touch()\n"
                     '    time.sleep(60)\nsocket.getaddrinfo = _hang\n')
        with patch.object(self.w, '__file__', str(self.source)), patch.object(self.w, 'push', return_value=None), \
                patch.object(subprocess, 'Popen', self.popen):
            started = time.monotonic()
            result = self.w.deliver({'pushUrls': [self.url, self.url], 'heartbeatUrls': [self.url, self.url]}, True)
        self.assertEqual(result, {'receipts': [False, False], 'heartbeatReceipts': [False, False]})
        self.assertEqual(len(list(self.directory.glob('pid-*'))), 4)
        self.assertLess(time.monotonic() - started, 8)
        self.assert_reaped()


if __name__ == '__main__':
    unittest.main()
