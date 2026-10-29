"""Detached observations use actual due times; tests inject clock and processes."""

import hashlib
import importlib.util
import io
import json
import os
import signal
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/release_observer.py'
SPEC = importlib.util.spec_from_file_location('release_observer', SOURCE)
observer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(observer)
SHA, OLD = 'a' * 40, 'b' * 40
TARGET = {'sha': SHA, 'worker': 'ghcr.io/jrvector9/nomorevibe-worker@sha256:' + 'c' * 64,
          'web': 'ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:' + 'd' * 64}


class Clock:
    def __init__(self):
        self.current = datetime(2026, 10, 25, 0, 0, tzinfo=timezone.utc)
        self.seconds, self.sleeps = 0.0, []

    def now(self): return self.current
    def monotonic(self): return self.seconds

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.seconds += seconds
        self.current += timedelta(seconds=seconds)


class Process:
    def __init__(self, pid=12345, code=None):
        self.pid, self.code, self.stopped = pid, code, False

    def poll(self): return self.code
    def terminate(self): self.stopped, self.code = True, -15
    def kill(self): self.stopped, self.code = True, -9
    def wait(self, timeout=None): return self.code


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.private = Path(self.directory.name).resolve()
        self.private.chmod(0o700)
        self.snapshot = {'schemaVersion': 1, 'target': dict(TARGET),
                         'apps': {'web-mini': {'env': 'SECRET=private'}},
                         'runtime': {'web-mini': {'private': 'docker-details'}},
                         'baseline': {'web-mini': {'release': OLD,
                             'image': TARGET['web'], 'specHash': 'e' * 64}},
                         'latest': {'web-mini': {'deploymentId': 'original-deployment'}}}
        self.snapshot_path = self.private / 'final.private.json'
        self.snapshot_path.write_text(json.dumps(self.snapshot))
        self.snapshot_path.chmod(0o600)
        self.digest = hashlib.sha256(self.snapshot_path.read_bytes()).hexdigest()
        self.out = self.private / 'observations'
        self.clock = Clock()
        self.calls = []

    def prepare(self, offsets=(300, 600, 900, 21600)):
        return observer._prepare_launch(self.snapshot_path, self.digest, self.out,
                                         offsets=offsets, now=self.clock.now)

    def successful_sample(self, snapshot, target, repo):
        self.calls.append({'snapshot': snapshot, 'target': target, 'repo': repo, 'at': self.clock.now()})
        return {'fleetMatched': True, 'monitorMatched': True, 'productionMutations': 0}

    def run_driver(self, sample=None):
        return observer.run_observer(self.out, now=self.clock.now, sleep=self.clock.sleep,
                                     sample=sample or self.successful_sample, pid=999)

    def read(self, name): return json.loads((self.out / name).read_text())

    def test_plan_pins_snapshot_source_due_times_and_never_claims_future_success(self):
        plan = self.prepare()
        self.assertEqual(plan['snapshotSha256'], self.digest)
        self.assertEqual(plan['targetRelease'], SHA)
        self.assertEqual(plan['offsets'], [300, 600, 900, 21600])
        self.assertTrue(plan['sourceHashes'])
        self.assertIn('scripts/ops/release_observer.py', plan['sourceHashes'])
        self.assertEqual((self.out.stat().st_mode & 0o777), 0o700)
        self.assertEqual(((self.out / 'launch.private.json').stat().st_mode & 0o777), 0o600)
        for sample in plan['samples']:
            self.assertFalse(sample['passed'])
            self.assertIsNone(sample['actualAt'])
            self.assertEqual(sample['status'], 'pending')

    def test_snapshot_exact_hash_owner_permissions_and_symlink_are_checked_before_launch(self):
        cases = ('hash', 'mode', 'directory_mode', 'symlink', 'owner')
        for case in cases:
            with self.subTest(case=case):
                path, digest = self.snapshot_path, self.digest
                self.snapshot_path.chmod(0o600); self.private.chmod(0o700)
                if case == 'hash': digest = 'f' * 64
                if case == 'mode': self.snapshot_path.chmod(0o644)
                if case == 'directory_mode': self.private.chmod(0o755)
                if case == 'symlink':
                    path = self.private / 'linked.json'
                    path.symlink_to(self.snapshot_path)
                if case == 'owner':
                    with patch.object(observer.os, 'getuid', return_value=os.getuid() + 1), self.assertRaises(observer.ObserverError):
                        observer._prepare_launch(path, digest, self.out, offsets=(300,), now=self.clock.now)
                else:
                    with self.assertRaises(observer.ObserverError):
                        observer._prepare_launch(path, digest, self.out, offsets=(300,), now=self.clock.now)
                self.assertFalse(self.out.exists())
        self.private.chmod(0o700)

    def test_new_directory_and_positive_distinct_sorted_offsets_are_required(self):
        for offsets in ((0, 300), (300, 300), (600, 300), (-1,), (True,), ()):
            with self.subTest(offsets=offsets), self.assertRaises(observer.ObserverError):
                self.prepare(offsets)
        self.prepare((300,))
        with self.assertRaisesRegex(observer.ObserverError, 'observer_directory_exists'):
            self.prepare((300,))

    def test_driver_observes_only_at_actual_due_times_using_pinned_per_app_releases(self):
        self.prepare()
        result = self.run_driver()
        self.assertTrue(result['completed'])
        self.assertEqual(result['sampleCount'], 4)
        self.assertEqual([int((row['at'] - datetime(2026, 10, 25, tzinfo=timezone.utc)).total_seconds())
                          for row in self.calls], [300, 600, 900, 21600])
        self.assertTrue(self.clock.sleeps)
        self.assertLessEqual(max(self.clock.sleeps), 30)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.calls[0]['snapshot']['baseline']['web-mini']['release'], OLD)
        self.assertEqual(self.calls[0]['target'], TARGET)
        self.assertEqual(self.read('summary.private.json')['productionMutations'], 0)
        for offset in (300, 600, 900, 21600):
            record = self.read(f'sample-{offset}.result.private.json')
            self.assertTrue(record['passed'])
            self.assertEqual(record['productionMutations'], 0)
            self.assertIsNotNone(record['actualAt'])

    def test_failed_sample_stops_once_without_future_passes_or_retry(self):
        self.prepare((300, 600, 900))

        def failing(snapshot, target, repo):
            self.calls.append(self.clock.now())
            raise RuntimeError('SECRET=synthetic-private-error')

        with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_failed'):
            self.run_driver(failing)
        self.assertEqual(len(self.calls), 1)
        record = self.read('sample-300.result.private.json')
        self.assertFalse(record['passed'])
        summary = self.read('summary.private.json')
        self.assertFalse(summary['completed'])
        self.assertFalse(any(row['passed'] for row in summary['samples']))
        self.assertFalse((self.out / 'sample-600.started.private.json').exists())
        self.assertIn('synthetic-private-error', (self.out / 'sample-300.stderr.private.log').read_text())

    def test_timeout_is_recorded_and_following_samples_are_not_executed(self):
        self.prepare((300, 600))

        def timeout(*args): raise TimeoutError('observation timed out')

        with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_failed'):
            self.run_driver(timeout)
        self.assertEqual(self.read('sample-300.result.private.json')['error'], 'TimeoutError')
        self.assertFalse((self.out / 'sample-600.started.private.json').exists())

    def test_changed_snapshot_or_source_bytes_stops_before_the_next_sample(self):
        self.prepare((300, 600))
        with patch.object(observer, '_verify_sources', side_effect=observer.ObserverError('observer_source_changed')):
            with self.assertRaisesRegex(observer.ObserverError, 'observer_source_changed'):
                self.run_driver()
        self.assertEqual(self.calls, [])
        self.snapshot_path.write_text(json.dumps({**self.snapshot, 'extra': 'changed'}))
        with self.assertRaisesRegex(observer.ObserverError, 'observer_snapshot_hash_mismatch'):
            self.run_driver()
        self.assertEqual(self.calls, [])

    def test_duplicate_started_or_completed_sample_is_refused_without_running_it(self):
        self.prepare((300,))
        observer._write_private(self.out / 'sample-300.started.private.json', {'already': True})
        with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_exists'):
            self.run_driver()
        self.assertEqual(self.calls, [])

    def test_second_driver_cannot_replay_a_completed_run(self):
        self.prepare((300,))
        self.run_driver()
        with self.assertRaisesRegex(observer.ObserverError, 'observer_already_started'):
            self.run_driver()
        self.assertEqual(len(self.calls), 1)

    def test_late_samples_record_the_actual_time_without_inventing_an_on_time_result(self):
        self.prepare((300,))
        self.clock.sleep(420)
        self.run_driver()
        record = self.read('sample-300.result.private.json')
        self.assertEqual(observer._parse_time(record['actualAt']), self.clock.now())
        self.assertEqual(observer._parse_time(record['dueAt']) + timedelta(seconds=120), self.clock.now())

    def test_launcher_requires_started_receipt_and_a_live_detached_process(self):
        captured = {}

        def launch(argv, **kwargs):
            captured.update(argv=argv, kwargs=kwargs)
            plan = self.read('launch.private.json')
            launch_hash = hashlib.sha256((self.out / 'launch.private.json').read_bytes()).hexdigest()
            observer._write_private(self.out / 'started.private.json',
                {'schemaVersion': 1, 'pid': 12345, 'launchSha256': launch_hash,
                 'startAt': plan['startAt'], 'actualAt': observer._iso(self.clock.now()),
                 'productionMutations': 0, 'futurePassed': False})
            return Process()

        result = observer.launch_observer(self.snapshot_path, self.digest, self.out, offsets=(300,),
            popen=launch, now=self.clock.now, monotonic=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertTrue(result['started'])
        self.assertEqual(result['pid'], 12345)
        self.assertFalse(result['futurePassed'])
        self.assertTrue(captured['kwargs']['start_new_session'])
        self.assertTrue(captured['kwargs']['close_fds'])
        self.assertIn('-I', captured['argv'])
        self.assertEqual(captured['kwargs']['env']['GIT_NO_REPLACE_OBJECTS'], '1')
        self.assertNotIn('private-error', json.dumps(result))

    def test_spawn_alone_or_dead_driver_never_counts_as_started(self):
        process = Process()
        with self.assertRaisesRegex(observer.ObserverError, 'observer_start_not_confirmed'):
            observer.launch_observer(self.snapshot_path, self.digest, self.out, offsets=(300,),
                popen=lambda *args, **kwargs: process, now=self.clock.now,
                monotonic=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertTrue(process.stopped)
        self.assertLessEqual(self.clock.seconds, 3)

    def test_readonly_sample_calls_exact_retained_proof_and_all_five_role_gate(self):
        class Shared:
            def dokploy_api_key(self):
                self.credentials_read = True
                return 'private-key'
            def Dokploy(self, key):
                self.key = key
                return 'client'
            def monitor_gate(self, client, role, **kwargs):
                self.gate = (client, role, kwargs)
                return {'readiness': 'ready', 'progress': 'ok'}
        class Runtime:
            def __init__(self): self.shared = Shared()
            def verify_fleet(self, client, snapshot, target, selected, receipts, repo):
                self.proof = (client, snapshot, target, selected, receipts, repo)
                return {'web-mini': {'release': OLD}}
        runtime = Runtime()
        with patch.object(observer, '_load_runtime', return_value=runtime):
            result = observer._read_only_sample(self.snapshot, TARGET, self.private)
        self.assertTrue(result['fleetMatched'])
        self.assertTrue(result['monitorMatched'])
        self.assertEqual(result['productionMutations'], 0)
        self.assertEqual(runtime.proof[3:5], ([], {}))
        self.assertEqual(set(runtime.shared.gate[2]['roles']), {'crawler', 'reviewer', 'publisher', 'text', 'maintenance'})
        self.assertEqual(runtime.shared.gate[2]['strict'], ())
        self.assertEqual(runtime.shared.key, 'private-key')
        self.assertTrue(runtime.shared.credentials_read)

    def test_integrity_failure_at_due_time_gets_a_failed_receipt_and_stops(self):
        self.prepare((300, 600))
        original_sleep = self.clock.sleep

        def change_snapshot_at_due(seconds):
            original_sleep(seconds)
            if self.clock.seconds >= 300:
                self.snapshot_path.write_text(json.dumps({**self.snapshot, 'changed': True}))

        with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_failed'):
            observer.run_observer(self.out, now=self.clock.now, sleep=change_snapshot_at_due,
                                   sample=self.successful_sample)
        self.assertFalse(self.read('sample-300.result.private.json')['passed'])
        self.assertEqual(self.read('sample-300.result.private.json')['errorCode'], 'observer_snapshot_hash_mismatch')
        self.assertTrue(self.read('summary.private.json')['stopped'])
        self.assertEqual(self.calls, [])

    def test_snapshot_change_during_a_sample_cannot_be_recorded_as_passed(self):
        self.prepare((300, 600))

        def changed(snapshot, target, repo):
            self.snapshot_path.write_text(json.dumps({**self.snapshot, 'changed': True}))
            return self.successful_sample(snapshot, target, repo)

        with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_failed'):
            self.run_driver(changed)
        self.assertFalse(self.read('sample-300.result.private.json')['passed'])
        self.assertEqual(len(self.calls), 1)

    def test_bad_started_receipt_stops_the_child_without_leaving_an_untracked_driver(self):
        process = Process()

        def malformed(*args, **kwargs):
            path = self.out / 'started.private.json'
            path.write_text('{')
            path.chmod(0o600)
            return process

        with self.assertRaisesRegex(observer.ObserverError, 'observer_start_receipt_invalid'):
            observer.launch_observer(self.snapshot_path, self.digest, self.out, offsets=(300,),
                popen=malformed, now=self.clock.now, monotonic=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertTrue(process.stopped)

    def test_launcher_failure_message_is_private_and_the_public_exception_is_sanitized(self):
        def fail(*args, **kwargs): raise RuntimeError('SECRET=launcher-private-error')

        with self.assertRaisesRegex(observer.ObserverError, '^observer_spawn_failed$'):
            observer.launch_observer(self.snapshot_path, self.digest, self.out, offsets=(300,),
                popen=fail, now=self.clock.now, monotonic=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertIn('launcher-private-error', (self.out / 'driver.stderr.private.log').read_text())

    def test_direct_cli_can_prepare_a_new_private_driver_directory(self):
        with redirect_stdout(io.StringIO()), \
                patch.object(observer, 'run_observer', return_value={'completed': True, 'productionMutations': 0}) as driver:
            code = observer.main(['--snapshot', str(self.snapshot_path), '--snapshot-sha', self.digest,
                                   '--outdir', str(self.out)])
        self.assertEqual(code, 0)
        self.assertTrue((self.out / 'launch.private.json').exists())
        driver.assert_called_once()

    def test_summary_symlinks_are_rejected(self):
        self.prepare((300,))
        (self.out / 'summary.private.json').symlink_to(self.private / 'missing.json')
        with self.assertRaises(observer.ObserverError):
            self.run_driver()
        self.assertEqual(self.calls, [])

    def test_sample_worker_refuses_an_existing_execution_lock_before_credentials(self):
        plan = self.prepare((300,))
        self.clock.sleep(300)
        observer._write_private(self.out / 'sample-300.started.private.json',
            {'offset': 300, 'dueAt': plan['samples'][0]['dueAt']})
        observer._write_private(self.out / 'sample-300.executing.private.json', {'pid': 111})
        launch_hash = hashlib.sha256((self.out / 'launch.private.json').read_bytes()).hexdigest()
        with patch.object(observer, '_now', side_effect=self.clock.now), \
                patch.object(observer, '_read_only_sample', return_value={'fleetMatched': True}) as sample:
            with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_exists'):
                observer._sample_main(self.out, 300, launch_hash)
        sample.assert_not_called()

    def test_sample_worker_cannot_run_before_the_due_time(self):
        self.prepare((300,))
        launch_hash = hashlib.sha256((self.out / 'launch.private.json').read_bytes()).hexdigest()
        with patch.object(observer, '_now', side_effect=self.clock.now), patch.object(observer, '_read_only_sample') as sample:
            with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_not_due'):
                observer._sample_main(self.out, 300, launch_hash)
        sample.assert_not_called()

    def test_sample_timeout_terminates_only_the_spawned_child_process_group(self):
        plan = self.prepare((300,))
        launch_hash = hashlib.sha256((self.out / 'launch.private.json').read_bytes()).hexdigest()
        process = Process()
        waits = []

        def wait(timeout=None):
            waits.append(timeout)
            if len(waits) == 1:
                raise subprocess.TimeoutExpired('observer-sample', timeout)
            return -15

        process.wait = wait
        with patch.object(observer.os, 'killpg') as kill:
            with self.assertRaises(TimeoutError):
                observer._subprocess_sample(self.out, plan, launch_hash, 300,
                                             popen=lambda *args, **kwargs: process)
        kill.assert_called_once_with(process.pid, signal.SIGTERM)
        self.assertEqual(waits, [observer.SAMPLE_TIMEOUT_SECONDS, 1])
        self.assertEqual((self.out / 'sample-300.stderr.private.log').stat().st_mode & 0o777, 0o600)

    def test_source_pin_change_during_a_sample_stops_without_a_success_claim(self):
        plan = self.prepare((300, 600))
        changed = dict(plan['sourceHashes'])
        changed['scripts/ops/release_runtime.py'] = 'f' * 64
        with patch.object(observer, '_source_hashes', side_effect=[plan['sourceHashes'], plan['sourceHashes'], changed]):
            with self.assertRaisesRegex(observer.ObserverError, 'observer_sample_failed'):
                self.run_driver()
        record = self.read('sample-300.result.private.json')
        self.assertFalse(record['passed'])
        self.assertEqual(record['errorCode'], 'observer_source_changed')
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
