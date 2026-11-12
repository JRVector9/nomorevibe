"""Separate observer heartbeat targets cannot overwrite pipeline alarms."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'


class WatchdogConfigurationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog_config', OPS / 'oracle_watchdog.py')
        self.watchdog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.watchdog)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'config.json'
        material = Path(temporary.name) / 'ssh-material'
        material.touch(mode=0o600)
        self.config = {'recover': False, 'state': str(Path(temporary.name) / 'state.json'),
                       'hosts': {'m3': {'target': 'jr@100.64.0.1', 'key': str(material), 'knownHosts': str(material),
                                        'services': ['monitor']}},
                       'pushUrls': ['https://receiver.test/api/push/pipeline-token']}

    def read(self):
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)
        return self.watchdog.read_config(self.path)

    def test_legacy_configuration_and_separate_heartbeat_targets_are_supported(self):
        self.assertNotIn('heartbeatUrls', self.read())
        self.config['heartbeatUrls'] = ['https://receiver.test/api/push/heartbeat-token']
        self.assertEqual(self.read(), self.config)

    def test_bounded_three_host_inventory_includes_independent_osaka_consumer(self):
        primary = self.config['hosts']['m3']
        self.config['hosts']['mini'] = {**primary, 'target': 'jr@100.64.0.2', 'services': ['web']}
        self.config['hosts']['osaka'] = {**primary, 'target': 'root@100.64.0.3', 'services': ['agent-scan']}
        self.assertEqual(self.read(), self.config)
        self.config['hosts']['extra'] = {**primary, 'target': 'jr@100.64.0.4'}
        with self.assertRaisesRegex(ValueError, 'invalid_configuration'):
            self.read()

    def test_pipeline_and_heartbeat_cannot_share_the_same_receiver_endpoint(self):
        for heartbeat in ['https://receiver.test/api/push/pipeline-token',
                          'https://RECEIVER.TEST.:443/api/push/pipeline-token?status=up&msg=private']:
            with self.subTest(heartbeat=heartbeat):
                self.config['heartbeatUrls'] = [heartbeat]
                with self.assertRaisesRegex(ValueError, 'overlapping_push_targets'):
                    self.read()

    def test_invalid_heartbeat_targets_are_rejected_without_exposing_their_values(self):
        for targets in [None, 'https://receiver.test/token', ['http://receiver.test/private-token'],
                        ['https://user:private-token@receiver.test/push'], ['https://receiver.test/push#private-token']]:
            with self.subTest(targets=targets):
                self.config['heartbeatUrls'] = targets
                with self.assertRaises((ValueError, TypeError)) as failure:
                    self.read()
                self.assertNotIn('private-token', str(failure.exception))


if __name__ == '__main__':
    unittest.main()


class AdminOriginConfigurationTests(unittest.TestCase):
    """2026-11-12 운영 콘솔 조각 4b: 휴대폰 알림 링크 앞에 붙이는 관리자 사이트 주소(선택). 설정 틀은 위 시험과 같다."""
    setUp = WatchdogConfigurationTests.setUp
    read = WatchdogConfigurationTests.read

    def test_admin_origin_is_optional_and_only_a_plain_https_origin(self):
        self.assertNotIn('adminOrigin', self.read())
        for origin in ['https://nomorevibe.example', 'https://nomorevibe.example/']:
            with self.subTest(origin=origin):
                self.config['adminOrigin'] = origin
                self.assertEqual(self.read()['adminOrigin'], origin)
        for origin in ['http://nomorevibe.example', 'https://nomorevibe.example/admin', 'https://user:pw@nomorevibe.example',
                       'https://nomorevibe.example/?x=1', 'nomorevibe.example', 7]:
            with self.subTest(origin=origin):
                self.config['adminOrigin'] = origin
                with self.assertRaisesRegex(ValueError, 'invalid_admin_origin'):
                    self.read()
