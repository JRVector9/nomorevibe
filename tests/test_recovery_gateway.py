import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'scripts/ops/recovery_gateway.py'


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PATH.exists(), 'constrained recovery gateway must exist')
        spec = importlib.util.spec_from_file_location('recovery_gateway', PATH)
        self.g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.g)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = {'services': {'web': {'service': 'fixed-web', 'kind': 'web', 'replicas': 2}},
                       'state': str(Path(self.tmp.name) / 'state.json')}
        self.calls = []
        self.row = {'key': 'web', 'version': 12, 'replicas': 2, 'settled': True,
                    'recoverable': True, 'reason': 'web_page_failed', 'ok': False}

    def recover(self, **kwargs):
        return self.g.recover(self.config, 'web', 12, now=1000,
                              probe_fn=lambda _: {'services': [self.row]},
                              force_fn=lambda cfg, version: self.calls.append((cfg['service'], version)) or {'result': 'requested'}, **kwargs)

    def test_rechecks_and_rolls_only_existing_fixed_service(self):
        self.assertEqual(self.recover()['result'], 'requested')
        self.assertEqual(self.calls, [('fixed-web', 12)])
        state = json.loads(Path(self.config['state']).read_text())
        self.assertEqual(state['attempts']['web'], [1000])
        self.assertEqual(Path(self.config['state']).stat().st_mode & 0o777, 0o600)

    def test_denies_changed_service_or_recovered_or_deploying(self):
        for field, value in [('version', 13), ('recoverable', False), ('settled', False), ('replicas', 0)]:
            original = self.row[field]
            self.row[field] = value
            self.assertEqual(self.recover()['result'], 'refused')
            self.row[field] = original
        self.assertEqual(self.calls, [])

    def test_cooldown_survives_process_restart(self):
        self.recover()
        self.assertEqual(self.recover()['result'], 'limited')
        self.assertEqual(len(self.calls), 1)

    def test_unknown_command_outcome_is_not_retried(self):
        def timeout(cfg, version):
            raise TimeoutError('secret in external exception')
        result = self.g.recover(self.config, 'web', 12, now=1000,
                                probe_fn=lambda _: {'services': [self.row]}, force_fn=timeout)
        self.assertEqual(result, {'result': 'unknown'})
        self.assertEqual(self.recover()['result'], 'limited')

    def test_never_restarts_model_workers_or_accepts_shell(self):
        self.config['services']['web']['kind'] = 'worker'
        self.assertEqual(self.recover()['result'], 'refused')
        for command in ['recover web 12; id', 'probe x', 'recover unknown 12', 'recover web -1', 'sh']:
            with self.assertRaises(ValueError):
                self.g.parse_command(command, self.config)
        self.assertEqual(self.calls, [])

    def test_force_uses_engine_cas_and_preserves_every_other_spec_field(self):
        service = {'ID': 'a' * 25, 'Version': {'Index': 12}, 'Spec': {
            'Name': 'fixed-web', 'TaskTemplate': {'ForceUpdate': 9, 'ContainerSpec': {'Image': 'fixed@sha256:abc', 'Env': ['SECRET=hidden']}},
            'Mode': {'Replicated': {'Replicas': 2}}, 'UpdateConfig': {'Parallelism': 1}}}
        exchanges = []
        result = self.g.force_update(self.config['services']['web'], 12,
                                    run=lambda _: json.dumps([service]),
                                    exchange=lambda path, body: exchanges.append((path, body)) or 200)
        self.assertEqual(result, {'result': 'requested'})
        self.assertIn('version=12&registryAuthFrom=spec', exchanges[0][0])
        expected = json.loads(json.dumps(service['Spec']))
        expected['TaskTemplate']['ForceUpdate'] = 10
        self.assertEqual(exchanges[0][1], expected)
        service['Version']['Index'] = 13
        self.assertEqual(self.g.force_update(self.config['services']['web'], 12,
                                            run=lambda _: json.dumps([service]),
                                            exchange=lambda *args: self.fail('must not mutate changed version')), {'result': 'refused'})

    def test_daily_budget_and_future_attempts_fail_closed(self):
        for attempts in [[1, 2], [2000]]:
            Path(self.config['state']).write_text(json.dumps({'attempts': {'web': attempts}}))
            self.assertEqual(self.recover()['result'], 'limited')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
