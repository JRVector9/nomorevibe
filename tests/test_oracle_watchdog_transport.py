import contextlib
import importlib.util
import io
import json
import sys
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
            if url == 'broken':
                raise TimeoutError('private')
        with patch.object(self.w, 'push', send):
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

    def test_safe_delivery_failure_never_logs_endpoint_or_receiver_error(self):
        original = self.w.push
        FakeConnection.stall = 'body'
        with patch.object(self.w, 'push', lambda url, ok: original(url, ok, deadline_seconds=0.025)):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertFalse(self.w.safe_push(self.url, False))
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
        self.assertTrue(FakeConnection.instances[-1].sock.stopped.is_set())


if __name__ == '__main__':
    unittest.main()
