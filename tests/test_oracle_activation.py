"""Local fixtures only: loopback fake IMDS, temporary release/unit roots. No SSH, OCI API, systemd or DB."""
import copy
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'deploy/oracle'
sys.path.insert(0, str(SOURCE))
import build_release as builder
import install_units as installer
import launch
import manage_release as manager
import oci_identity
import release_contract as contract


SHA = 'c' * 40
INSTANCE = 'oracle-news'
TENANCY = 'ocid1.tenancy.oc1..aaaafixturetenancy'
COMPARTMENT = 'ocid1.compartment.oc1..aaaafixturecompartment'
INSTANCE_OCID = 'ocid1.instance.oc1.ap-osaka-1.aaaafixtureinstance'
APPROVED = {'version': 1, 'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke',
            'tenancyOcid': TENANCY, 'compartmentOcid': COMPARTMENT, 'instanceOcid': INSTANCE_OCID,
            'shape': 'VM.Standard.A1.Flex'}
METADATA = {'id': INSTANCE_OCID, 'tenantId': TENANCY, 'compartmentId': COMPARTMENT, 'displayName': 'osaka-smoke',
            'canonicalRegionName': 'ap-osaka-1', 'regionInfo': {'regionIdentifier': 'ap-osaka-1', 'regionKey': 'KIX'},
            'shape': 'VM.Standard.A1.Flex', 'region': 'ap-osaka-1'}
RUNTIME = {'system': 'Linux', 'machine': 'aarch64', 'libc': 'glibc'}


class FakeImds:
    """Loopback-only stand-in for 169.254.169.254. Each test chooses one response behavior."""

    def __init__(self, behavior):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.requests.append((self.path, self.headers.get('Authorization')))
                behavior(self)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        # A client that stops reading (oversize/timeout cases) is expected; keep the fixture quiet.
        self.server.handle_error = lambda *args: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()

    def fetch(self, **options):
        return oci_identity.fetch_instance_metadata(host='127.0.0.1', port=self.server.server_address[1], **options)


def reply(status, body=b'', headers=()):
    def behavior(handler):
        handler.send_response(status)
        for name, value in headers:
            handler.send_header(name, value)
        if not any(name.lower() == 'content-length' for name, _ in headers):
            handler.send_header('Content-Length', str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    return behavior


def imds(handler):
    if handler.headers.get('Authorization') != 'Bearer Oracle' or handler.path != '/opc/v2/instance/':
        return reply(401, b'{}')(handler)
    return reply(200, json.dumps(METADATA).encode(), [('Content-Type', 'application/json')])(handler)


class OciIdentityTests(unittest.TestCase):
    def test_imdsv2_metadata_matches_the_exact_approved_record(self):
        with FakeImds(imds) as server:
            record = oci_identity.validate_identity(APPROVED, oci_identity.observed_identity(server.fetch()))
        self.assertEqual(server.requests, [('/opc/v2/instance/', 'Bearer Oracle')])
        self.assertEqual(record, {'version': 1, 'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke',
                                  'tenancyOcid': TENANCY, 'instanceOcid': INSTANCE_OCID})
        contract.validate_host(record, record)

    def test_root_compartment_reports_the_tenancy_ocid(self):
        approved = {**APPROVED, 'compartmentOcid': TENANCY}
        observed = oci_identity.observed_identity({**METADATA, 'compartmentId': TENANCY})
        self.assertEqual(oci_identity.validate_identity(approved, observed)['tenancyOcid'], TENANCY)

    def test_every_identity_field_and_placeholder_is_fail_closed(self):
        observed = oci_identity.observed_identity(METADATA)
        for key, value in [('tenancyOcid', 'ocid1.tenancy.oc1..aaaaothertenancy'), ('compartmentOcid', TENANCY),
                           ('instanceOcid', 'ocid1.instance.oc1.ap-osaka-1.aaaaotherinstance'), ('region', 'ap-tokyo-1'),
                           ('displayName', 'onetwoday'), ('shape', 'VM.Standard.E2.1.Micro')]:
            with self.subTest(observed=key), self.assertRaises(ValueError):
                oci_identity.validate_identity(APPROVED, {**observed, key: value})
        placeholder = json.loads((SOURCE / 'oracle-identity.json.example').read_text())
        for approved in (placeholder, {**APPROVED, 'instance': 'onetwoday'}, {**APPROVED, 'extra': True},
                         {**APPROVED, 'version': True}, {**APPROVED, 'shape': ''}):
            with self.subTest(approved=approved), self.assertRaises(ValueError):
                oci_identity.validate_identity(approved, observed)
        for metadata in ({**METADATA, 'tenantId': None}, {**METADATA, 'regionInfo': {'regionIdentifier': 'ap-tokyo-1'}}, []):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                oci_identity.observed_identity(metadata)

    def test_missing_header_redirect_and_error_statuses_are_rejected_without_following(self):
        redirect = reply(302, b'', [('Location', '/opc/v2/instance/redirected')])
        for behavior in (redirect, reply(401, b'{}'), reply(500, json.dumps(METADATA).encode())):
            with FakeImds(behavior) as server, self.subTest(behavior=behavior):
                with self.assertRaisesRegex(ValueError, 'oci_metadata_status_rejected'):
                    server.fetch()
                self.assertEqual(len(server.requests), 1)

    def test_declared_and_streamed_oversize_bodies_are_rejected(self):
        large = b'{"x":"' + b'a' * (70 * 1024) + b'"}'

        def chunked(handler):
            handler.send_response(200)
            handler.send_header('Transfer-Encoding', 'chunked')
            handler.end_headers()
            for start in range(0, len(large), 8192):
                part = large[start:start + 8192]
                handler.wfile.write(b'%x\r\n' % len(part) + part + b'\r\n')
            handler.wfile.write(b'0\r\n\r\n')
        for behavior in (reply(200, large), chunked):
            with FakeImds(behavior) as server, self.subTest(behavior=behavior):
                with self.assertRaisesRegex(ValueError, 'oci_metadata_too_large'):
                    server.fetch()

    def test_silent_and_dripping_servers_hit_the_bounded_timeout(self):
        release = threading.Event()

        def silent(handler):
            release.wait(5)

        def drip(handler):
            handler.send_response(200)
            handler.send_header('Content-Length', '4096')
            handler.end_headers()
            for _ in range(40):
                if release.is_set():
                    return
                handler.wfile.write(b' ')
                handler.wfile.flush()
                time.sleep(0.1)
        try:
            for behavior in (silent, drip):
                with FakeImds(behavior) as server, self.subTest(behavior=behavior.__name__):
                    started = time.monotonic()
                    with self.assertRaises(ValueError):
                        server.fetch(timeout=0.5)
                    self.assertLess(time.monotonic() - started, 2.0)
        finally:
            release.set()

    def test_proxy_environment_is_never_used(self):
        with FakeImds(imds) as server, patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:9', 'http_proxy': 'http://127.0.0.1:9'}):
            self.assertEqual(server.fetch()['id'], INSTANCE_OCID)

    def test_cli_reports_a_fixed_code_when_metadata_is_unreachable(self):
        with tempfile.TemporaryDirectory() as directory:
            approved = Path(directory) / 'approved.json'
            approved.write_text(json.dumps(APPROVED))
            with patch.object(oci_identity, 'fetch_instance_metadata', side_effect=ValueError('oci_metadata_unavailable')), \
                    patch.object(sys, 'argv', ['oci_identity.py', '--approved', str(approved)]), \
                    patch('sys.stderr') as stderr, self.assertRaises(SystemExit) as caught:
                oci_identity.main()
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(json.loads(''.join(call.args[0] for call in stderr.write.call_args_list if call.args[0].strip())),
                         {'code': 'oracle_identity_unverified', 'reason': 'oci_metadata_unavailable'})


def prepared_release(root):
    files = {
        'package.json': '{"name":"nomorevibe","private":true}', 'package-lock.json': '{"lockfileVersion":3}',
        'tsconfig.json': '{}', 'lib/jobs/catalog.ts': 'export {};\n', 'scripts/role-worker.ts': 'export {};\n',
        'scripts/worker-supervisor.ts': 'export {};\n', 'scripts/scheduler.ts': 'export {};\n',
        'scripts/worker-oracle-preflight.ts': 'export {};\n', 'node_modules/tsx/package.json': '{"name":"tsx"}',
        'runtime/bin/node': 'fixture-node', 'tools/bin/codex': 'fixture-codex', 'tools/bin/claude': 'fixture-claude',
        'tools/bin/grok': 'fixture-grok',
        **{name: (SOURCE / Path(name).name).read_text() for name in contract.LAUNCHER_FILES},
    }
    root.mkdir()
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o755 if name.startswith(('runtime/', 'tools/')) else 0o644)
    return root


def report(role='official-news', **changes):
    value = {'kind': 'nomorevibe-oracle-runtime-preflight', 'version': 1, 'role': role,
             'configuredHost': {'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke'},
             'instanceId': INSTANCE, 'releaseSha': SHA, 'ready': False, 'activationAllowed': False,
             'workload': {'ready': True, 'reason': 'ready', 'job': 'news-refresh', 'evidenceHash': 'd' * 64},
             'checks': {name: {'status': 'unknown', 'reason': 'x'} for name in launch.PREFLIGHT_CHECKS}}
    for name in ('identity', 'batch', 'database', 'timeouts'):
        value['checks'][name] = {'status': 'verified', 'reason': 'fixture'}
    for path, item in changes.items():
        target = value
        keys = path.split('__')
        for key in keys[:-1]:
            target = target[key]
        target[keys[-1]] = item
    return value


class LauncherGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        stage = prepared_release(self.root / 'prepared')
        archive = self.root / 'release.tar.gz'
        with patch.object(builder, 'runtime_platform', return_value=RUNTIME):
            built = builder.build_release(stage, archive, SHA, 'v24.19.0')
        host = oci_identity.validate_identity(APPROVED, oci_identity.observed_identity(METADATA))
        manager.stage_release(self.root / 'offline', archive, built['archiveSha256'], host, host)
        manager.switch_release(self.root / 'offline', SHA, None, host, host)
        self.base = self.root / 'offline/opt/nomorevibe-core'
        self.release = self.base / 'releases' / SHA
        self.approved = self.root / 'oracle-identity.json'
        self.approved.write_text(json.dumps(APPROVED))
        self.cgroup = self.root / 'cgroup'
        (self.cgroup / launch.SLICE).mkdir(parents=True)
        for name, value in (('cpu.max', '50000 100000\n'), ('memory.max', '2147483648\n'), ('pids.max', '256\n')):
            (self.cgroup / launch.SLICE / name).write_text(value)
        self.proc = self.root / 'proc-cgroup'
        self.proc.write_text('0::/nomorevibe-core.slice/nomorevibe-core-role@official-news.service\n')
        self.env = {'RELEASE_TAG': SHA, 'SERVICE_INSTANCE_ID': INSTANCE, 'WORKER_ROLE': 'official-news',
                    'PHYSICAL_HOST': 'oracle-osaka-smoke', 'HOST_DB_BUDGET': self.budget()}
        self.fetches, self.runs = [], []
        self.metadata, self.preflight = copy.deepcopy(METADATA), (78, json.dumps(report()).encode())

    def tearDown(self):
        self.temp.cleanup()

    def budget(self, role='official-news', **changes):
        kind = 'scheduler-parent' if role == 'scheduler' else 'role-parent'
        value = {'mode': 'enabled', 'policy': {'version': 1, 'host': 'oracle-osaka-smoke', 'release': SHA,
                 'roles': [] if role == 'scheduler' else [role], 'schedulerReplicas': 1 if role == 'scheduler' else 0,
                 'webReplicas': 0, 'webReadReplica': False, 'monitor': False, 'connectAgent': False,
                 'preflightProcesses': 1, 'migrationProcesses': 0, 'rolloutCopies': 1},
                 'process': {'host': 'oracle-osaka-smoke', 'release': SHA, 'replica': 1, 'copy': 1, 'kind': kind, 'role': role}}
        value.update(changes)
        return json.dumps(value)

    def fetch(self):
        self.fetches.append(True)
        return self.metadata

    def runner(self, argv, cwd, env):
        self.runs.append((argv, cwd))
        return self.preflight

    def gate(self, role='official-news', **overrides):
        options = dict(base=self.base, launcher=self.release / 'deploy/oracle/launch.py', owner_uid=os.getuid(),
                       platform_info=RUNTIME, user=('nomorevibe-core', False), proc_cgroup=self.proc,
                       cgroup_root=self.cgroup, approved_identity=self.approved, fetch=self.fetch, runner=self.runner)
        options.update(overrides)
        return launch.gate(role, overrides.pop('env', self.env), **{k: v for k, v in options.items() if k != 'env'})

    def assert_closed(self, check, reason, **overrides):
        with self.assertRaises(launch.Unverified) as caught:
            self.gate(**overrides)
        self.assertEqual((caught.exception.check, caught.exception.reason), (check, reason))

    def test_all_verified_checks_select_only_the_fixed_role_process(self):
        (node, argv), release = self.gate()
        self.assertEqual(release, self.release)
        self.assertEqual(node, str(self.release / 'runtime/bin/node'))
        self.assertEqual(argv, [node, '--import', 'tsx', 'scripts/role-worker.ts', '--role=official-news', '--kind=primary'])
        self.assertEqual(self.runs, [([node, '--import', 'tsx', 'scripts/worker-oracle-preflight.ts', '--role=official-news'], self.release)])
        self.assertEqual(len(self.fetches), 1)
        self.assertEqual(self.release.stat().st_mode & 0o777, 0o755)

    def test_release_location_tag_tree_and_owner_fail_before_network_or_database(self):
        self.assert_closed('release', 'release_tag_invalid', env={**self.env, 'RELEASE_TAG': 'main'})
        self.assert_closed('release', 'current_release_mismatch', env={**self.env, 'RELEASE_TAG': 'd' * 40})
        self.assert_closed('release', 'launcher_outside_release', launcher=SOURCE / 'launch.py')
        self.assert_closed('release', 'release_not_root_owned', owner_uid=os.getuid() + 1)
        target = self.release / 'scripts/role-worker.ts'
        target.chmod(0o644)
        target.write_text('tampered')
        self.assert_closed('release', 'release_tree_unverified')
        self.assertEqual((self.fetches, self.runs), ([], []))

    def test_runtime_account_and_platform_are_exact(self):
        self.assert_closed('runtime', 'runtime_platform_mismatch', platform_info={**RUNTIME, 'machine': 'x86_64'})
        self.assert_closed('runtime', 'service_account_mismatch', user=('root', True))
        self.assert_closed('runtime', 'service_account_mismatch', user=('nomorevibe-x', False))
        self.assertEqual((self.fetches, self.runs), ([], []))

    def test_budget_requires_matching_declaration_and_kernel_enforced_slice(self):
        for env in ({k: v for k, v in self.env.items() if k != 'HOST_DB_BUDGET'}, {**self.env, 'HOST_DB_BUDGET': self.budget(mode='disabled')},
                    {**self.env, 'HOST_DB_BUDGET': self.budget('product-health')}, {**self.env, 'WORKER_ROLE': 'translation'},
                    {**self.env, 'HOST_DB_BUDGET': '{"mode":"enabled"}'}, {**self.env, 'HOST_DB_BUDGET': 'not-json'}):
            with self.subTest(env=env.get('HOST_DB_BUDGET')):
                self.assert_closed('budget', 'host_db_budget_undeclared', env=env)
        self.proc.write_text('0::/system.slice/nomorevibe-core-role@official-news.service\n')
        self.assert_closed('budget', 'core_slice_not_applied')
        self.proc.write_text('0::/nomorevibe-core.slice/nomorevibe-core-role@official-news.service\n')
        for name, value in (('cpu.max', 'max 100000\n'), ('memory.max', 'max\n'), ('pids.max', 'max\n')):
            original = (self.cgroup / launch.SLICE / name).read_text()
            (self.cgroup / launch.SLICE / name).write_text(value)
            with self.subTest(limit=name):
                self.assert_closed('budget', 'core_slice_unbounded')
            (self.cgroup / launch.SLICE / name).write_text(original)
        self.assertEqual((self.fetches, self.runs), ([], []))

    def test_oci_identity_must_match_before_any_database_preflight(self):
        self.approved.unlink()
        self.assert_closed('identity', 'approved_identity_unavailable')
        self.approved.write_text(json.dumps(APPROVED))
        self.metadata = {**METADATA, 'displayName': 'onetwoday'}
        self.assert_closed('identity', 'oci_identity_unverified')

        def unreachable():
            raise ValueError('oci_metadata_unavailable')
        self.assert_closed('identity', 'oci_identity_unverified', fetch=unreachable)
        self.assertEqual(self.runs, [])

    def test_preflight_unknown_rejected_or_malformed_reports_never_start(self):
        cases = [
            ((0, json.dumps(report()).encode()), 'preflight_failed'),
            ((78, b'x' * (launch.MAX_PREFLIGHT_BYTES + 1)), 'preflight_failed'),
            ((78, b'not json'), 'preflight_unavailable'),
            ((78, json.dumps(report(role='translation')).encode()), 'preflight_report_mismatch'),
            ((78, json.dumps(report(releaseSha='d' * 40)).encode()), 'preflight_report_mismatch'),
            ((78, json.dumps(report(activationAllowed=True)).encode()), 'preflight_report_mismatch'),
            ((78, json.dumps(report(checks__runtime={'status': 'rejected', 'reason': 'runtime_platform_mismatch'})).encode()), 'preflight_rejected'),
            ((78, json.dumps(report(checks__database={'status': 'unknown', 'reason': 'approved_privilege_profile_unavailable'})).encode()), 'database_unverified'),
            ((78, json.dumps(report(checks__timeouts={'status': 'unknown', 'reason': 'pooler_server_settings_unverified'})).encode()), 'timeouts_unverified'),
            ((78, json.dumps(report(workload={'ready': False, 'reason': 'canary_unknown'})).encode()), 'workload_unverified'),
        ]
        for result, reason in cases:
            self.preflight = result
            with self.subTest(reason=reason):
                self.assert_closed('preflight', reason)

        def hung(argv, cwd, env):
            raise subprocess.TimeoutExpired(argv, 90)
        self.assert_closed('preflight', 'preflight_unavailable', runner=hung)

    def test_model_role_and_scheduler_stay_closed_without_their_evidence(self):
        self.env.update(WORKER_ROLE='translation', HOST_DB_BUDGET=self.budget('translation'))
        self.preflight = (78, json.dumps(report('translation')).encode())
        self.assert_closed('preflight', 'model_unverified', role='translation')
        self.env.update(WORKER_ROLE='scheduler', HOST_DB_BUDGET=self.budget('scheduler'))
        self.preflight = (78, json.dumps(report('scheduler', workload={'ready': False, 'reason': 'scheduler_canary_unavailable'})).encode())
        self.assert_closed('preflight', 'workload_unverified', role='scheduler')
        self.assertEqual(launch.role_command('scheduler', self.release)[1][-2:], ['scripts/worker-supervisor.ts', '--role=scheduler'])

    def test_scheduler_starts_only_with_the_canary_of_its_current_boot(self):
        self.proc.write_text('0::/nomorevibe-core.slice/nomorevibe-core-scheduler.service\n')
        self.env.update(WORKER_ROLE='scheduler', HOST_DB_BUDGET=self.budget('scheduler'))
        # PR11g preflight reasons: a restart (new boot), another batch epoch, stale evidence or no attested tick stay closed.
        for reason in ('result_boot_mismatch', 'result_epoch_mismatch', 'result_stale', 'capability_stale', 'result_unknown', 'candidate_unknown'):
            self.preflight = (78, json.dumps(report('scheduler', workload={'ready': False, 'reason': reason})).encode())
            with self.subTest(reason=reason):
                self.assert_closed('preflight', 'workload_unverified', role='scheduler')
        self.preflight = (78, json.dumps(report('scheduler', checks__database={'status': 'unknown', 'reason': 'approved_privilege_profile_unavailable'},
                                                workload={'ready': True, 'reason': 'ready', 'evidenceHash': 'd' * 64})).encode())
        self.assert_closed('preflight', 'database_unverified', role='scheduler')
        self.preflight = (78, json.dumps(report('scheduler', workload={'ready': True, 'reason': 'ready', 'evidenceHash': 'd' * 64})).encode())
        (node, argv), _ = self.gate(role='scheduler')
        self.assertEqual(argv, [node, '--import', 'tsx', 'scripts/worker-supervisor.ts', '--role=scheduler'])
        self.assertEqual(self.runs[-1][0][-1], '--role=scheduler')

    def test_cli_has_no_bypass_and_keeps_the_fixed_failure_contract(self):
        env = {**os.environ, **self.env, 'ORACLE_RUNTIME_ENABLED': '1', 'ORACLE_LAUNCH_FORCE': '1'}
        result = subprocess.run([sys.executable, str(SOURCE / 'launch.py'), '--role', 'official-news'],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 78)
        self.assertEqual(json.loads(result.stderr), launch.FAILURE)
        self.assertEqual(json.loads(result.stdout), {'check': 'release', 'reason': 'current_release_mismatch'})


CONSUMER = 'fixture-scan'
CONSUMER_INSTANCE = 'fixture-scan-consumer-oracle'


def consumer_report(consumer=CONSUMER, role='crawler', **changes):
    value = {'kind': 'nomorevibe-oracle-consumer-preflight', 'version': 1, 'consumer': consumer, 'role': role,
             'configuredHost': {'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke'},
             'instanceId': CONSUMER_INSTANCE, 'releaseSha': SHA, 'ready': False, 'activationAllowed': False,
             'workload': {'ready': True, 'reason': 'ready'},
             'checks': {name: {'status': 'unknown', 'reason': 'x'} for name in launch.CONSUMER_PREFLIGHT_CHECKS}}
    for name in launch.CONSUMER_REQUIRED_PREFLIGHT:
        value['checks'][name] = {'status': 'verified', 'reason': 'fixture'}
    for name in launch.CONSUMER_NOT_APPLICABLE:
        value['checks'][name] = {'status': 'not_applicable', 'reason': 'fixture'}
    for path, item in changes.items():
        target = value
        keys = path.split('__')
        for key in keys[:-1]:
            target = target[key]
        target[keys[-1]] = item
    return value


class ConsumerLauncherGateTests(unittest.TestCase):
    """B0: --consumer=<name> keeps release/runtime/budget/identity and replaces batch/canary with the consumer preflight."""
    setUp, tearDown, budget, fetch, runner, gate = (LauncherGateTests.setUp, LauncherGateTests.tearDown, LauncherGateTests.budget,
                                                    LauncherGateTests.fetch, LauncherGateTests.runner, LauncherGateTests.gate)

    def run(self, result=None):
        # A fixture consumer is registered only inside each test, next to the shipped CONSUMERS (agent-scan since E5).
        with patch.dict(launch.CONSUMERS, {CONSUMER: 'crawler'}):
            return super().run(result)

    def consumer_budget(self, policy_changes=None, **process_changes):
        value = json.loads(self.budget('crawler'))
        value['policy'].update({'roles': [], 'consumers': [CONSUMER], **(policy_changes or {})})
        value['process'].update({'consumer': CONSUMER, **process_changes})
        return json.dumps(value)

    def use_consumer(self):
        self.proc.write_text(f'0::/nomorevibe-core.slice/nomorevibe-core-consumer@{CONSUMER}.service\n')
        self.env = {'RELEASE_TAG': SHA, 'SERVICE_INSTANCE_ID': CONSUMER_INSTANCE, 'WORKER_ROLE': 'crawler', 'TZ': 'UTC',
                    'PHYSICAL_HOST': 'oracle-osaka-smoke', 'HOST_DB_BUDGET': self.consumer_budget()}
        self.preflight = (78, json.dumps(consumer_report()).encode())

    def consumer_gate(self, consumer=CONSUMER, **overrides):
        options = dict(base=self.base, launcher=self.release / 'deploy/oracle/launch.py', owner_uid=os.getuid(),
                       platform_info=RUNTIME, user=('nomorevibe-core', False), proc_cgroup=self.proc,
                       cgroup_root=self.cgroup, approved_identity=self.approved, fetch=self.fetch, runner=self.runner)
        options.update(overrides)
        return launch.consumer_gate(consumer, overrides.pop('env', self.env), **{k: v for k, v in options.items() if k != 'env'})

    def assert_consumer_closed(self, check, reason, **overrides):
        with self.assertRaises(launch.Unverified) as caught:
            self.consumer_gate(**overrides)
        self.assertEqual((caught.exception.check, caught.exception.reason), (check, reason))

    def test_consumer_starts_its_parent_supervisor_without_batch_or_canary(self):
        self.use_consumer()
        (node, argv), release = self.consumer_gate()
        self.assertEqual(release, self.release)
        self.assertEqual(argv, [node, '--import', 'tsx', 'scripts/worker-supervisor.ts', '--role=crawler', f'--consumer={CONSUMER}'])
        self.assertEqual(self.runs, [([node, '--import', 'tsx', 'scripts/worker-oracle-preflight.ts', f'--consumer={CONSUMER}'], self.release)])
        self.assertEqual(len(self.fetches), 1)
        # A name absent from the fixed shipped list never starts: each consumer PR registers its own name everywhere.
        with patch.dict(launch.CONSUMERS, {}, clear=True):
            self.assert_consumer_closed('consumer', 'consumer_invalid')
        self.assert_consumer_closed('consumer', 'consumer_invalid', consumer='crawler')

    def test_consumer_budget_requires_its_own_declared_slot(self):
        self.use_consumer()
        disabled = {**json.loads(self.consumer_budget()), 'mode': 'disabled'}
        cases = [self.consumer_budget(kind='worker'), self.consumer_budget(consumer=None), self.consumer_budget(consumer='ai1'),
                 self.consumer_budget(role='reviewer'), self.consumer_budget({'consumers': []}),
                 # A string roster must not match by substring.
                 self.consumer_budget({'consumers': CONSUMER}), self.consumer_budget({'consumers': None}),
                 self.budget('crawler'), json.dumps(disabled)]
        for budget in cases:
            with self.subTest(budget=budget):
                self.assert_consumer_closed('budget', 'host_db_budget_undeclared', env={**self.env, 'HOST_DB_BUDGET': budget})
        self.assert_consumer_closed('budget', 'host_db_budget_undeclared', env={**self.env, 'WORKER_ROLE': 'reviewer'})
        self.assertEqual((self.fetches, self.runs), ([], []))
        # A role process can never borrow a consumer slot either.
        role_env = {**self.env, 'HOST_DB_BUDGET': self.consumer_budget({'roles': ['crawler']})}
        with self.assertRaises(launch.Unverified) as caught:
            self.gate('crawler', env=role_env)
        self.assertEqual((caught.exception.check, caught.exception.reason), ('budget', 'host_db_budget_undeclared'))

    def test_consumer_process_timezone_must_be_utc_before_network_or_database(self):
        self.use_consumer()
        for value in (None, '', 'Asia/Tokyo', 'Etc/UTC', ':UTC', 'utc'):
            env = {key: item for key, item in self.env.items() if key != 'TZ'}
            if value is not None:
                env['TZ'] = value
            with self.subTest(tz=value):
                self.assert_consumer_closed('runtime', 'process_timezone_not_utc', env=env)
        self.assertEqual((self.fetches, self.runs), ([], []))

    def test_consumer_preflight_report_is_exact_and_never_claims_batch(self):
        self.use_consumer()
        cases = [
            (consumer_report(checks__batch={'status': 'verified', 'reason': 'x'}), 'batch_unexpected'),
            (consumer_report(checks__admission={'status': 'unknown', 'reason': 'x'}), 'admission_unexpected'),
            (consumer_report(checks__timezone={'status': 'unknown', 'reason': 'role_timezone_unverified'}), 'timezone_unverified'),
            (consumer_report(checks__consumer={'status': 'unknown', 'reason': 'consumer_readiness_unknown'}), 'consumer_unverified'),
            (consumer_report(checks__database={'status': 'unknown', 'reason': 'approved_privilege_profile_unavailable'}), 'database_unverified'),
            (consumer_report(checks__timezone={'status': 'rejected', 'reason': 'session_timezone_not_utc'}), 'preflight_rejected'),
            (consumer_report(workload={'ready': False, 'reason': 'consumer_unknown'}), 'workload_unverified'),
            (consumer_report(consumer='other-scan'), 'preflight_report_mismatch'),
            (consumer_report(role='reviewer'), 'preflight_report_mismatch'),
            (consumer_report(kind='nomorevibe-oracle-runtime-preflight'), 'preflight_report_mismatch'),
            ({**consumer_report(), 'checks': {k: v for k, v in consumer_report()['checks'].items() if k != 'timezone'}}, 'preflight_report_mismatch'),
            (report('crawler'), 'preflight_unavailable'),
        ]
        for value, reason in cases:
            self.preflight = (78, json.dumps(value).encode())
            with self.subTest(reason=reason, value=value.get('kind')):
                self.assert_consumer_closed('preflight', reason)

    def test_only_consumers_start_from_a_consumer_profile_release(self):
        stage = prepared_release(self.root / 'prepared-consumer')
        for name in ('codex', 'claude', 'grok'):
            (stage / 'tools/bin' / name).unlink()
        (stage / 'tools/bin').rmdir()
        (stage / 'tools').rmdir()
        archive = self.root / 'consumer.tar.gz'
        other = 'e' * 40
        with patch.object(builder, 'runtime_platform', return_value=RUNTIME):
            built = builder.build_release(stage, archive, other, 'v24.19.0', 'consumer')
        host = oci_identity.validate_identity(APPROVED, oci_identity.observed_identity(METADATA))
        manager.stage_release(self.root / 'offline', archive, built['archiveSha256'], host, host)
        manager.switch_release(self.root / 'offline', other, SHA, host, host)
        release = self.base / 'releases' / other
        self.use_consumer()
        budget = json.loads(self.consumer_budget())
        for part in ('policy', 'process'):
            budget[part]['release'] = other
        self.env.update(RELEASE_TAG=other, HOST_DB_BUDGET=json.dumps(budget))
        self.preflight = (78, json.dumps(consumer_report(releaseSha=other)).encode())
        (node, argv), _ = self.consumer_gate(launcher=release / 'deploy/oracle/launch.py')
        self.assertEqual(argv[-1], f'--consumer={CONSUMER}')
        role_env = {'RELEASE_TAG': other, 'SERVICE_INSTANCE_ID': INSTANCE, 'WORKER_ROLE': 'official-news', 'PHYSICAL_HOST': 'oracle-osaka-smoke'}
        with self.assertRaises(launch.Unverified) as caught:
            launch.gate('official-news', role_env, base=self.base, launcher=release / 'deploy/oracle/launch.py', owner_uid=os.getuid(),
                        platform_info=RUNTIME, user=('nomorevibe-core', False), proc_cgroup=self.proc, cgroup_root=self.cgroup,
                        approved_identity=self.approved, fetch=self.fetch, runner=self.runner)
        self.assertEqual((caught.exception.check, caught.exception.reason), ('release', 'release_profile_mismatch'))

    def test_cli_refuses_an_unregistered_consumer_without_starting_anything(self):
        result = subprocess.run([sys.executable, str(SOURCE / 'launch.py'), '--consumer', 'unregistered-scan'],
                                env={**os.environ, 'TZ': 'UTC'}, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        both = subprocess.run([sys.executable, str(SOURCE / 'launch.py'), '--role', 'official-news', '--consumer', 'agent-scan'],
                              env=os.environ, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(both.returncode, 0)

    def test_shipped_agent_scan_consumer_runs_under_crawler_and_stays_closed_outside_a_verified_release(self):
        # E5: the same name and parent role as lib/runtime/consumer-registry.ts. Outside an installed Oracle release it exits 78 closed.
        self.assertEqual(launch.CONSUMERS['agent-scan'], 'crawler')
        result = subprocess.run([sys.executable, str(SOURCE / 'launch.py'), '--consumer', 'agent-scan'],
                                env={**os.environ, 'TZ': 'UTC', 'RELEASE_TAG': 'a' * 40}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 78)
        self.assertEqual(json.loads(result.stdout)['check'], 'release')


class ReleaseContractLauncherFilesTests(unittest.TestCase):
    def test_only_fixed_launcher_modules_are_release_payload(self):
        for name in contract.LAUNCHER_FILES:
            self.assertEqual(contract.payload_path(name), name)
        for name in ('deploy/oracle/install_units.py', 'deploy/oracle/README.md', 'deploy/oracle/role.env.example',
                     'deploy/x-collector/run.py'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                contract.payload_path(name)


class InstallUnitsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'staging'
        self.root.mkdir()
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def runner(self, lookup):
        def run(command, **options):
            self.commands.append(command)
            return subprocess.CompletedProcess(command, lookup if command[0] == 'getent' else 0)
        return run

    def test_staging_install_writes_units_and_private_placeholders_only(self):
        result = installer.install_units(self.root, 50, 2 * 1024 ** 3, 256, ['official-news', 'scheduler'], runner=self.runner(0))
        self.assertEqual(self.commands, [])
        self.assertEqual(result['commands'], [])
        self.assertEqual((result['enabled'], result['started'], result['activationAllowed']), ([], [], False))
        units = self.root / 'etc/systemd/system'
        self.assertEqual(sorted(p.name for p in units.iterdir()),
                         ['nomorevibe-core-role@.service', 'nomorevibe-core-scheduler.service', 'nomorevibe-core.slice'])
        self.assertIn('CPUQuota=50%', (units / 'nomorevibe-core.slice').read_text())
        for path in units.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
            self.assertNotIn('@MEASURED_', path.read_text())
        news = self.root / 'etc/nomorevibe-core/official-news.env'
        scheduler = self.root / 'etc/nomorevibe-core/scheduler.env'
        for path in (news, scheduler):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertIn('WORKER_ROLE=official-news\n', news.read_text())
        self.assertIn('DATABASE_URL=\n', news.read_text())
        self.assertIn('HOST_DB_BUDGET=\n', scheduler.read_text())
        self.assertFalse(any(p.name.startswith('.') for p in self.root.rglob('*')))

    def test_existing_env_is_preserved_and_units_are_replaced(self):
        installer.install_units(self.root, 50, 1024 ** 3, 128, ['official-news'])
        env = self.root / 'etc/nomorevibe-core/official-news.env'
        env.write_text('DATABASE_URL=operator-secret\n')
        result = installer.install_units(self.root, 40, 1024 ** 3, 128, ['official-news'])
        self.assertEqual(env.read_text(), 'DATABASE_URL=operator-secret\n')
        self.assertEqual(result['preserved'], ['etc/nomorevibe-core/official-news.env'])
        self.assertIn('CPUQuota=40%', (self.root / 'etc/systemd/system/nomorevibe-core.slice').read_text())

    def test_apply_targets_only_the_live_root_and_never_enables_or_starts(self):
        for lookup, expected in ((2, [['getent', 'passwd', 'nomorevibe-core'],
                                      ['useradd', '--system', '--user-group', '--no-create-home', '--home-dir',
                                       '/var/lib/nomorevibe-core', '--shell', '/usr/sbin/nologin', 'nomorevibe-core'],
                                      ['systemctl', 'daemon-reload']]),
                                 (0, [['getent', 'passwd', 'nomorevibe-core'], ['systemctl', 'daemon-reload']])):
            self.commands = []
            with self.subTest(lookup=lookup):
                result = installer.install_units(self.root, 50, 1024 ** 3, 128, ['product-health'], apply=True,
                                                 live_root=self.root, runner=self.runner(lookup))
                self.assertEqual(self.commands, expected)
                self.assertFalse(any(word in command for command in self.commands for word in ('enable', 'start', '--now')))
                self.assertEqual(result['activationAllowed'], False)
        with self.assertRaises(RuntimeError):
            installer.install_units(self.root, 50, 1024 ** 3, 128, ['product-health'], apply=True,
                                    live_root=self.root, runner=self.runner(1))

    def test_live_root_without_apply_and_unsafe_roots_are_refused_before_writing(self):
        cases = [(Path('/'), False, '/'), (self.root, True, '/'), (Path('relative'), False, '/'),
                 (Path(self.temp.name) / 'nomorevibe-x', False, '/')]
        for root, apply, live in cases:
            with self.subTest(root=root, apply=apply), self.assertRaises(ValueError):
                installer.install_units(root, 50, 1024 ** 3, 128, ['official-news'], apply=apply, live_root=live,
                                        runner=self.runner(0))
        (self.root / 'etc').symlink_to(Path(self.temp.name))
        with self.assertRaises(ValueError):
            installer.install_units(self.root, 50, 1024 ** 3, 128, ['official-news'])
        for roles in ([], ['crawler'], ['official-news', 'official-news']):
            with self.subTest(roles=roles), self.assertRaises(ValueError):
                installer.install_units(Path(self.temp.name) / 'other', 50, 1024 ** 3, 128, roles)
        with self.assertRaises(ValueError):
            installer.install_units(Path(self.temp.name) / 'other', 0, 1024 ** 3, 128, ['official-news'])
        self.assertEqual(self.commands, [])
        self.assertFalse((Path(self.temp.name) / 'other').exists())



class ConsumerInstallUnitsTests(unittest.TestCase):
    """B0: the consumer unit fixes TZ=UTC, its env placeholder holds no secret and nothing is enabled or started."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'staging'
        self.root.mkdir()
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def run(self, result=None):
        with patch.dict(launch.CONSUMERS, {CONSUMER: 'crawler'}):
            return super().run(result)

    def runner(self, lookup):
        def run(command, **options):
            self.commands.append(command)
            return subprocess.CompletedProcess(command, lookup if command[0] == 'getent' else 0)
        return run

    def test_consumer_only_install_writes_the_utc_unit_and_a_private_placeholder(self):
        result = installer.install_units(self.root, 50, 1024 ** 3, 128, [], consumers=[CONSUMER], runner=self.runner(0))
        self.assertEqual((self.commands, result['commands'], result['enabled'], result['started'], result['activationAllowed']),
                         ([], [], [], [], False))
        units = self.root / 'etc/systemd/system'
        self.assertEqual(sorted(path.name for path in units.iterdir()),
                         ['nomorevibe-core-consumer@.service', 'nomorevibe-core-role@.service', 'nomorevibe-core-scheduler.service',
                          'nomorevibe-core.slice'])
        unit = (units / 'nomorevibe-core-consumer@.service').read_text()
        lines = unit.splitlines()
        for line in ('User=nomorevibe-core', 'Slice=nomorevibe-core.slice', 'Environment=TZ=UTC', 'NoNewPrivileges=yes',
                     'EnvironmentFile=/etc/nomorevibe-core/consumer-%i.env', 'KillMode=mixed', 'PrivateTmp=yes',
                     'ExecStart=/usr/bin/python3 /opt/nomorevibe-core/current/deploy/oracle/launch.py --consumer=%i'):
            self.assertIn(line, lines)
        self.assertEqual([line for line in lines if line.startswith('Environment=TZ')], ['Environment=TZ=UTC'])
        env = self.root / f'etc/nomorevibe-core/consumer-{CONSUMER}.env'
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        text = env.read_text()
        self.assertIn('WORKER_ROLE=crawler\n', text)
        self.assertIn('DATABASE_URL=\n', text)
        self.assertIn('HOST_DB_BUDGET=\n', text)
        # The unit owns TZ; the placeholder never carries batch, TZ or credential values.
        values = [line for line in text.splitlines() if line and not line.startswith('#')]
        self.assertFalse(any(line.startswith(('TZ=', 'JOB_BATCH_VERSION=')) for line in values))
        self.assertEqual({line.split('=', 1)[0]: line.split('=', 1)[1] for line in values if not line.endswith('=')},
                         {'PHYSICAL_HOST': 'oracle-osaka-smoke', 'WORKER_ROLE': 'crawler', 'DB_POOLER_MODE': 'pgbouncer', 'HTTP_ORIGIN_PERMITS': '0'})
        env.write_text('DATABASE_URL=operator-secret\n')
        again = installer.install_units(self.root, 50, 1024 ** 3, 128, ['official-news'], consumers=[CONSUMER])
        self.assertEqual(env.read_text(), 'DATABASE_URL=operator-secret\n')
        self.assertEqual(again['preserved'], [f'etc/nomorevibe-core/consumer-{CONSUMER}.env'])
        self.assertIn('etc/nomorevibe-core/official-news.env', again['written'])

    def test_shipped_agent_scan_consumer_installs_a_crawler_placeholder_without_secrets(self):
        installer.install_units(self.root, 50, 1024 ** 3, 128, [], consumers=['agent-scan'], runner=self.runner(0))
        text = (self.root / 'etc/nomorevibe-core/consumer-agent-scan.env').read_text()
        self.assertIn('WORKER_ROLE=crawler\n', text)
        values = [line for line in text.splitlines() if line and not line.startswith('#')]
        self.assertFalse(any(line.startswith(('GITHUB_', 'AGENT_SCAN_', 'TZ=')) for line in values))

    def test_role_only_install_is_unchanged_and_unregistered_consumers_write_nothing(self):
        installer.install_units(self.root, 50, 1024 ** 3, 128, ['official-news'])
        self.assertNotIn('nomorevibe-core-consumer@.service', [path.name for path in (self.root / 'etc/systemd/system').iterdir()])
        other = Path(self.temp.name) / 'other'
        for roles, consumers in (([], []), ([], ['unregistered-scan']), ([], [CONSUMER, CONSUMER]), (['official-news'], ['crawler'])):
            with self.subTest(roles=roles, consumers=consumers), self.assertRaises(ValueError):
                installer.install_units(other, 50, 1024 ** 3, 128, roles, consumers=consumers, runner=self.runner(0))
        self.assertEqual(self.commands, [])
        self.assertFalse(other.exists())

    def test_apply_creates_only_the_service_account_and_reloads(self):
        result = installer.install_units(self.root, 50, 1024 ** 3, 128, [], consumers=[CONSUMER], apply=True,
                                         live_root=self.root, runner=self.runner(0))
        self.assertEqual(self.commands, [['getent', 'passwd', 'nomorevibe-core'], ['systemctl', 'daemon-reload']])
        self.assertEqual((result['enabled'], result['started']), ([], []))


class SchedulerTemplateTests(unittest.TestCase):
    """PR11g: scheduler env template and the operator documentation of its canary."""

    def test_scheduler_env_declares_the_batch_contract_and_keeps_the_host_ledger_inactive(self):
        lines = (SOURCE / 'scheduler.env.example').read_text().splitlines()
        self.assertIn('JOB_BATCH_VERSION=1', lines)
        self.assertIn('HTTP_ORIGIN_PERMITS=0', lines)
        # An empty HOST_BUDGET_ENFORCEMENT is invalid JSON (host_budget_invalid); the template never assigns it.
        self.assertFalse(any(line.startswith('HOST_BUDGET_ENFORCEMENT=') for line in lines))

    def test_readme_documents_the_scheduler_canary_and_its_restart_rule(self):
        text = (SOURCE / 'README.md').read_text()
        self.assertNotIn('the scheduler preflight has no canary', text)
        self.assertIn('`canary --role=scheduler`', text)
        self.assertIn('every restart needs a new `canary`', text)


class RefreshTimerTemplateTests(unittest.TestCase):
    """PR11d: inactive capability refresh templates; nothing is enabled and the default install is unchanged."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'staging'
        self.root.mkdir()
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def runner(self, lookup):
        def run(command, **options):
            self.commands.append(command)
            return subprocess.CompletedProcess(command, lookup if command[0] == 'getent' else 0)
        return run

    def test_templates_run_only_capability_refresh_as_a_separate_account_inside_the_expiry_window(self):
        service = (SOURCE / 'nomorevibe-core-refresh@.service').read_text()
        timer = (SOURCE / 'nomorevibe-core-refresh@.timer').read_text()
        self.assertIn('\nType=oneshot\n', service)
        self.assertIn('\nUser=nomorevibe-attest\n', service)
        self.assertNotIn('User=nomorevibe-core', service)
        self.assertIn('EnvironmentFile=/etc/nomorevibe-core/refresh.env\n', service)
        exec_line = next(line for line in service.splitlines() if line.startswith('ExecStart='))
        self.assertEqual(exec_line.split(' lib/runtime/oracle-canary-cli.ts ', 1)[1], 'refresh --role=%i')
        self.assertIn('\nUnit=nomorevibe-core-refresh@%i.service\n', timer)
        cadence = next(line for line in timer.splitlines() if line.startswith('OnUnitInactiveSec='))
        self.assertEqual(cadence, 'OnUnitInactiveSec=5min')  # two retries inside the 15-minute capability expiry
        self.assertIn('ORACLE_ATTEST_DATABASE_URL=\n', (SOURCE / 'refresh.env.example').read_text())

    def test_staging_writes_inactive_refresh_templates_only_on_request_and_preserves_operator_env(self):
        result = installer.install_units(self.root, 50, 1024 ** 3, 128, ['product-health', 'official-news'],
                                         refresh_roles=['product-health'], runner=self.runner(0))
        self.assertEqual((self.commands, result['commands'], result['enabled'], result['started'], result['timersEnabled']), ([], [], [], [], []))
        self.assertFalse(result['activationAllowed'])
        units = self.root / 'etc/systemd/system'
        self.assertEqual(sorted(path.name for path in units.iterdir()),
                         ['nomorevibe-core-refresh@.service', 'nomorevibe-core-refresh@.timer', 'nomorevibe-core-role@.service',
                          'nomorevibe-core-scheduler.service', 'nomorevibe-core.slice'])
        for path in units.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        refresh = self.root / 'etc/nomorevibe-core/refresh.env'
        self.assertEqual(refresh.stat().st_mode & 0o777, 0o600)
        self.assertIn('ORACLE_ATTEST_DATABASE_URL=\n', refresh.read_text())
        self.assertNotIn('WORKER_ROLE', refresh.read_text())
        refresh.write_text('ORACLE_ATTEST_DATABASE_URL=operator-secret\n')
        again = installer.install_units(self.root, 50, 1024 ** 3, 128, ['product-health'], refresh_roles=['product-health'])
        self.assertEqual(refresh.read_text(), 'ORACLE_ATTEST_DATABASE_URL=operator-secret\n')
        self.assertIn('etc/nomorevibe-core/refresh.env', again['preserved'])

    def test_apply_creates_the_separate_account_and_never_enables_a_timer(self):
        result = installer.install_units(self.root, 50, 1024 ** 3, 128, ['site-evidence'], refresh_roles=['site-evidence'],
                                         apply=True, live_root=self.root, runner=self.runner(2))
        self.assertEqual(self.commands, [
            ['getent', 'passwd', 'nomorevibe-core'],
            ['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/var/lib/nomorevibe-core',
             '--shell', '/usr/sbin/nologin', 'nomorevibe-core'],
            ['getent', 'passwd', 'nomorevibe-attest'],
            ['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/var/lib/nomorevibe-attest',
             '--shell', '/usr/sbin/nologin', 'nomorevibe-attest'],
            ['systemctl', 'daemon-reload']])
        self.assertFalse(any(word in command for command in self.commands for word in ('enable', 'start', '--now')))
        self.assertEqual(result['timersEnabled'], [])

    def test_refresh_roles_must_be_installed_split_roles_before_any_write(self):
        other = Path(self.temp.name) / 'other'
        for roles, refresh in ((['scheduler'], ['scheduler']), (['official-news'], ['product-health']),
                               (['official-news'], ['official-news', 'official-news'])):
            with self.subTest(refresh=refresh), self.assertRaises(ValueError):
                installer.install_units(other, 50, 1024 ** 3, 128, roles, refresh_roles=refresh, runner=self.runner(0))
        self.assertEqual(self.commands, [])
        self.assertFalse(other.exists())


if __name__ == '__main__':
    unittest.main()
