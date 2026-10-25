import importlib.util
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'scripts/ops/recovery_gateway.py'


class BoundedOutputTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('bounded_gateway', PATH)
        self.g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.g)

    def child(self, script, **kwargs):
        return self.g.bounded_output([sys.executable, '-c', script], **kwargs)

    def test_stops_oversized_output_while_the_child_is_still_running(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, '^command_output_exceeded$'):
            self.child("import sys,time;sys.stdout.buffer.write(b'x'*262144);sys.stdout.flush();time.sleep(5)",
                       limit=1024, timeout=2)
        self.assertLess(time.monotonic() - started, 1)

    def test_kills_sleeping_child_at_deadline(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, '^bounded_command_failed$'):
            self.child('import time;time.sleep(5)', timeout=0.05)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_deadline_kills_descendants_after_the_immediate_child_exits(self):
        script = 'import subprocess,sys;subprocess.Popen([sys.executable,"-c","import time;time.sleep(1)"])'
        real_popen = self.g.subprocess.Popen

        def exited_leader(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            process.wait(timeout=2)
            return process

        # Schedule deterministically: the leader exits before the deadline starts,
        # while its real descendant still holds the inherited output pipe open.
        started = time.monotonic()
        with patch.object(self.g.subprocess, 'Popen', side_effect=exited_leader):
            with self.assertRaisesRegex(ValueError, '^bounded_command_failed$'):
                self.child(script, timeout=0.05)
        self.assertLess(time.monotonic() - started, 0.5,
                        'an exited group leader left descendant output holding the reader open')

    def test_transmits_payload_and_preserves_binary_stdout(self):
        payload = b'\x00payload\n\xffend'
        self.assertEqual(self.child('import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())',
                                    payload=payload, limit=len(payload), timeout=2), payload)

    def test_accepts_output_exactly_at_the_byte_limit(self):
        self.assertEqual(self.child("import sys;sys.stdout.buffer.write(b'x'*1024)", limit=1024, timeout=2), b'x' * 1024)

    def test_nonzero_exit_is_rejected_even_with_valid_output(self):
        with self.assertRaisesRegex(ValueError, '^bounded_command_failed$'):
            self.child('import sys;sys.stdout.write("valid");sys.exit(7)', timeout=2)

    def test_command_discards_stderr_and_never_exposes_command_secrets(self):
        # The outer process captures real OS descriptors, including a mistakenly inherited child stderr.
        script = '\n'.join([
            'import importlib.util,sys',
            'spec=importlib.util.spec_from_file_location("gateway",' + json.dumps(str(PATH)) + ')',
            'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
            'try:',
            ' module.command([sys.executable,"-c","import sys;sys.stderr.write(\\"receiver-secret private-token\\");sys.exit(1)"])',
            'except ValueError as error:',
            ' print(str(error))',
        ])
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'bounded_command_failed\n')
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
