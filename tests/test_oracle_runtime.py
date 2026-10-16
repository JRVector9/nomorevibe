"""Offline fixtures only: no ARM, npm, systemd, DB or provider execution."""
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'deploy/oracle'
sys.path.insert(0, str(SOURCE))
import release_contract as contract
import build_release as builder
import manage_release as manager


SHA = 'a' * 40
OTHER = 'b' * 40
HOST = {'version': 1, 'tenancy': 'surfguide', 'region': 'ap-osaka-1',
        'instance': 'osaka-smoke', 'tenancyOcid': 'ocid1.tenancy.oc1..fixture',
        'instanceOcid': 'ocid1.instance.oc1.ap-osaka-1.fixture'}
RUNTIME = {'system': 'Linux', 'machine': 'aarch64', 'libc': 'glibc'}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def prepared(root, text='export {};\n'):
    files = {
        'package.json': '{"name":"nomorevibe","private":true}',
        'package-lock.json': '{"name":"nomorevibe","lockfileVersion":3}',
        'tsconfig.json': '{}', 'lib/jobs/catalog.ts': text,
        'scripts/role-worker.ts': text, 'scripts/worker-supervisor.ts': text,
        'scripts/scheduler.ts': text, 'node_modules/tsx/package.json': '{"name":"tsx"}',
        'deploy/oracle/launch.py': (SOURCE / 'launch.py').read_text(),
        'runtime/bin/node': 'fixture-node-not-executable-proof',
        'tools/bin/codex': 'fixture-codex', 'tools/bin/claude': 'fixture-claude',
        'tools/bin/grok': 'fixture-grok',
    }
    root.mkdir()
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o755 if name.startswith(('runtime/', 'tools/')) else 0o644)
    (root / 'node_modules/.bin').mkdir()
    (root / 'node_modules/.bin/tsx').symlink_to('../tsx/package.json')
    return root


def make_archive(path, entries, manifest=None):
    with tarfile.open(path, 'w:gz') as archive:
        if manifest is not None:
            entries = [('manifest.json', json.dumps(manifest).encode(), 'file', None), *entries]
        for name, data, kind, link in entries:
            info = tarfile.TarInfo(name)
            info.mode = 0o644
            if kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = link
            elif kind == 'hardlink':
                info.type = tarfile.LNKTYPE
                info.linkname = link
            elif kind == 'fifo':
                info.type = tarfile.FIFOTYPE
            else:
                info.size = len(data)
            archive.addfile(info, io.BytesIO(data) if kind == 'file' else None)
    return digest(path.read_bytes())


class OracleReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stage = prepared(self.root / 'prepared')
        self.archive = self.root / 'release.tar.gz'

    def tearDown(self):
        self.temp.cleanup()

    def build(self, sha=SHA, archive=None):
        with patch.object(builder, 'runtime_platform', return_value=RUNTIME):
            return builder.build_release(self.stage, archive or self.archive, sha, 'v24.19.0')

    def manifest(self):
        result = self.build()
        return manager.inspect_archive(self.archive, result['archiveSha256'])

    def test_prepared_fixture_has_declared_identity_control(self):
        value = self.manifest()
        self.assertEqual(value['releaseSha'], SHA)
        self.assertEqual(value['node']['version'], 'v24.19.0')
        self.assertEqual(value['clis']['codex']['version'], '0.153.4')

    def test_prepared_fixture_builds_full_manifest_without_changing_inputs(self):
        before = {str(p.relative_to(self.stage)): p.read_bytes() for p in self.stage.rglob('*') if p.is_file()}
        value = self.manifest()
        self.assertEqual(value['releaseSha'], SHA)
        self.assertEqual(value['platform'], {'os': 'linux', 'arch': 'arm64', 'libc': 'glibc'})
        self.assertEqual(value['lockfileSha256'], digest(before['package-lock.json']))
        self.assertEqual(value['clis']['grok']['version'], '1.0.46')
        self.assertEqual(value['node']['sha256'], digest(before['runtime/bin/node']))
        self.assertEqual({r['path'] for r in value['files']}, set(before))
        self.assertEqual(next(r for r in value['files'] if r['path'] == 'node_modules/.bin/tsx')['kind'], 'symlink')
        self.assertEqual(before, {str(p.relative_to(self.stage)): p.read_bytes() for p in self.stage.rglob('*') if p.is_file()})

    def test_manifest_rejects_unknown_fields_and_bad_pins(self):
        base = self.manifest()
        for field, value in [('extra', True), ('releaseSha', 'main'), ('batchContractVersion', True), ('version', 2)]:
            changed = copy.deepcopy(base)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                contract.validate_manifest(changed)
        for name in base['clis']:
            changed = copy.deepcopy(base)
            changed['clis'][name]['version'] = 'latest'
            with self.subTest(cli=name), self.assertRaises(ValueError):
                contract.validate_manifest(changed)

    def test_manifest_binds_node_cli_lockfile_and_all_files(self):
        base = self.manifest()
        variants = []
        for field in ('node', 'clis'):
            changed = copy.deepcopy(base)
            target = changed[field] if field == 'node' else changed[field]['codex']
            target['sha256'] = 'f' * 64
            variants.append(changed)
        changed = copy.deepcopy(base)
        changed['lockfileSha256'] = 'f' * 64
        variants.append(changed)
        changed = copy.deepcopy(base)
        changed['files'].append(copy.deepcopy(changed['files'][0]))
        variants.append(changed)
        for value in variants:
            with self.assertRaises(ValueError):
                contract.validate_manifest(value)

    def test_host_guard_compares_exact_configured_readback_without_mutation(self):
        original = copy.deepcopy(HOST)
        contract.validate_host(HOST, HOST)
        for key, value in [('tenancy', 'other'), ('region', 'ap-tokyo-1'), ('instance', 'onetwoday'),
                           ('instanceOcid', 'ocid1.instance.oc1.ap-osaka-1.other'), ('version', True)]:
            changed = {**HOST, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                contract.validate_host(HOST, changed)
        with self.assertRaises(ValueError):
            contract.validate_host(HOST, {**HOST, 'secret': 'must-not-be-rendered'})
        self.assertEqual(HOST, original)

    def test_builder_rejects_non_target_platform_before_output(self):
        for info in ({**RUNTIME, 'system': 'Darwin'}, {**RUNTIME, 'machine': 'x86_64'}, {**RUNTIME, 'libc': 'musl'}):
            with self.subTest(info=info), patch.object(builder, 'runtime_platform', return_value=info), self.assertRaises(ValueError):
                builder.build_release(self.stage, self.archive, SHA, 'v24.19.0')
            self.assertFalse(self.archive.exists())

    def test_builder_rejects_secrets_external_links_and_bad_source_sha(self):
        bad = self.stage / '.env.local'
        bad.write_text('TOP_SECRET=value')
        with self.assertRaisesRegex(ValueError, 'path'):
            self.build()
        bad.unlink()
        link = self.stage / 'node_modules/escape'
        link.symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'link'):
            self.build()
        link.unlink()
        with self.assertRaises(ValueError):
            self.build('main')
        self.assertFalse(self.archive.exists())

    def test_builder_is_deterministic_and_never_overwrites_output(self):
        one = self.build()
        second = self.root / 'second.tar.gz'
        two = self.build(archive=second)
        self.assertEqual(one, two)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        with self.assertRaises(FileExistsError):
            self.build()

    def test_archive_tamper_and_wrong_manifest_are_rejected_before_stage(self):
        result = self.build()
        self.archive.write_bytes(self.archive.read_bytes() + b'tamper')
        destination = self.root / 'offline'
        with self.assertRaises(ValueError):
            manager.stage_release(destination, self.archive, result['archiveSha256'], HOST, HOST)
        self.assertFalse(destination.exists())

    def test_archive_rejects_escape_duplicate_special_and_unlisted_entries(self):
        base = self.manifest()
        for number, entry in enumerate([
            ('../escaped', b'no', 'file', None), ('/tmp/escaped', b'no', 'file', None),
            ('payload/../escaped', b'no', 'file', None), ('payload/link', b'', 'symlink', '../../escaped'),
            ('payload/hard', b'', 'hardlink', 'payload/package.json'), ('payload/pipe', b'', 'fifo', None),
            ('manifest.json', b'{}', 'file', None), ('payload/unlisted', b'no', 'file', None),
        ]):
            path = self.root / f'bad-{number}.tar.gz'
            archive_hash = make_archive(path, [entry], base)
            with self.subTest(entry=entry[0]), self.assertRaises(ValueError):
                manager.inspect_archive(path, archive_hash)
        self.assertFalse((self.root / 'escaped').exists())

    def test_stage_and_pinned_switch_preserve_x_and_previous_release(self):
        destination = self.root / 'offline'
        x = destination / 'opt/nomorevibe-x/status'
        x.parent.mkdir(parents=True)
        x.write_bytes(b'X-ledger-preserved')
        result = self.build()
        manager.stage_release(destination, self.archive, result['archiveSha256'], HOST, HOST)
        release = destination / f'opt/nomorevibe-core/releases/{SHA}'
        self.assertTrue((release / 'runtime/bin/node').is_file())
        self.assertEqual((release / 'package.json').stat().st_mode & 0o777, 0o444)
        self.assertTrue((release / 'node_modules/.bin/tsx').is_symlink())
        self.assertFalse((destination / 'opt/nomorevibe-core/current').exists())
        self.assertEqual(manager.switch_release(destination, SHA, None, HOST, HOST), {'previous': None, 'current': SHA})
        second = self.root / 'other.tar.gz'
        result = self.build(OTHER, second)
        manager.stage_release(destination, second, result['archiveSha256'], HOST, HOST)
        manager.switch_release(destination, OTHER, SHA, HOST, HOST)
        manager.switch_release(destination, SHA, OTHER, HOST, HOST)
        self.assertEqual(os.readlink(destination / 'opt/nomorevibe-core/current'), 'releases/' + SHA)
        self.assertEqual(x.read_bytes(), b'X-ledger-preserved')

    def test_switch_cas_bad_host_and_existing_tamper_do_not_mutate_current(self):
        destination = self.root / 'offline'
        result = self.build()
        manager.stage_release(destination, self.archive, result['archiveSha256'], HOST, HOST)
        manager.switch_release(destination, SHA, None, HOST, HOST)
        for expected, observed in [(OTHER, HOST), (SHA, {**HOST, 'instance': 'onetwoday'})]:
            with self.assertRaises(ValueError):
                manager.switch_release(destination, SHA, expected, HOST, observed)
        path = destination / f'opt/nomorevibe-core/releases/{SHA}/package.json'
        path.chmod(0o644)
        path.write_text('tampered')
        with self.assertRaises(ValueError):
            manager.switch_release(destination, SHA, SHA, HOST, HOST)
        self.assertEqual(os.readlink(destination / 'opt/nomorevibe-core/current'), 'releases/' + SHA)

    def test_atomic_switch_failure_preserves_original_and_cleans_temp_link(self):
        destination = self.root / 'offline'
        result = self.build()
        manager.stage_release(destination, self.archive, result['archiveSha256'], HOST, HOST)
        error = OSError('fixture-replace-error')
        with patch.object(manager.os, 'replace', side_effect=error):
            with self.assertRaises(OSError) as caught:
                manager.switch_release(destination, SHA, None, HOST, HOST)
        self.assertIs(caught.exception, error)
        self.assertFalse((destination / 'opt/nomorevibe-core/current').exists())
        self.assertEqual(list((destination / 'opt/nomorevibe-core').glob('.current-*')), [])

    def test_manifest_invalid_symlink_path_is_a_validation_error(self):
        value = self.manifest()
        value['files'].append({'path': None, 'kind': 'symlink', 'target': 'x'})
        with self.assertRaises(Exception) as caught:
            contract.validate_manifest(value)
        self.assertIsInstance(caught.exception, ValueError)

    def test_builder_cleanup_failure_preserves_build_error(self):
        original, cleanup = OSError('fixture-publish-error'), OSError('fixture-unlink-error')
        real_unlink = Path.unlink
        def unlink(path, *args, **kwargs):
            if path.name.startswith('.oracle-artifact-'):
                raise cleanup
            return real_unlink(path, *args, **kwargs)
        with patch.object(builder.os, 'link', side_effect=original), patch.object(Path, 'unlink', unlink):
            with self.assertRaises(Exception) as caught:
                self.build()
        self.assertIsInstance(caught.exception, BaseExceptionGroup)
        self.assertEqual(caught.exception.exceptions, (original, cleanup))

    def test_stage_cleanup_failure_preserves_original_error(self):
        result = self.build()
        original, cleanup = OSError('fixture-extract-error'), OSError('fixture-rmtree-error')
        with patch.object(manager.shutil, 'copyfileobj', side_effect=original), patch.object(manager.shutil, 'rmtree', side_effect=cleanup):
            with self.assertRaises(BaseExceptionGroup) as caught:
                manager.stage_release(self.root / 'offline', self.archive, result['archiveSha256'], HOST, HOST)
        self.assertEqual(caught.exception.exceptions, (original, cleanup))
        self.assertFalse((self.root / f'offline/opt/nomorevibe-core/releases/{SHA}').exists())

    def test_symlinked_managed_directory_is_not_followed(self):
        result = self.build()
        root = self.root / 'offline'
        (root / 'opt').mkdir(parents=True)
        foreign = self.root / 'foreign'
        foreign.mkdir()
        (foreign / 'sentinel').write_text('unchanged')
        (root / 'opt/nomorevibe-core').symlink_to(foreign)
        with self.assertRaises(ValueError):
            manager.stage_release(root, self.archive, result['archiveSha256'], HOST, HOST)
        self.assertEqual(sorted(p.name for p in foreign.iterdir()), ['sentinel'])

    def test_offline_manager_refuses_live_root_and_x_namespace(self):
        for path in (Path('/'), self.root / 'nomorevibe-x'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                manager.switch_release(path, SHA, None, HOST, HOST)

    def test_launcher_cannot_be_enabled_by_environment(self):
        result = subprocess.run([sys.executable, str(SOURCE / 'launch.py'), '--role', 'translation'],
                                env={**os.environ, 'JOB_BATCH_VERSION': '1', 'ORACLE_RUNTIME_ENABLED': '1'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 78)
        self.assertEqual(json.loads(result.stderr), {'code': 'oracle_runtime_preflight_unavailable'})

    def test_templates_render_only_explicit_host_budgets_and_never_start_services(self):
        with self.assertRaises(ValueError):
            manager.render_units(True, 1024 ** 3, 128)
        with self.assertRaises(ValueError):
            manager.render_units(0, 1024 ** 3, 128)
        files = manager.render_units(50, 1024 ** 3, 128)
        self.assertEqual(set(files), {'nomorevibe-core.slice', 'nomorevibe-core-role@.service', 'nomorevibe-core-scheduler.service'})
        self.assertIn('CPUQuota=50%', files['nomorevibe-core.slice'])
        self.assertIn('MemoryMax=1073741824', files['nomorevibe-core.slice'])
        for name, content in files.items():
            self.assertNotIn('@MEASURED_', content)
            self.assertNotIn('nomorevibe-x', content)
            if name.endswith('.service'):
                self.assertIn('User=nomorevibe-core', content)
                self.assertIn('launch.py', content)
                self.assertNotIn('ExecStart=/usr/bin/node', content)
                self.assertNotIn('migrate', content)

    def test_valid_archive_with_changed_inner_content_still_rejects_new_outer_hash(self):
        self.build()
        changed = self.root / 'inner-tamper.tar.gz'
        with tarfile.open(self.archive) as original, tarfile.open(changed, 'w:gz') as output:
            for item in original:
                content = original.extractfile(item).read() if item.isfile() else None
                if item.name == 'payload/lib/jobs/catalog.ts':
                    content = b'tampered but outer hash recomputed'
                    item.size = len(content)
                output.addfile(item, io.BytesIO(content) if content is not None else None)
        with self.assertRaisesRegex(ValueError, 'content_mismatch'):
            manager.inspect_archive(changed, digest(changed.read_bytes()))

    def test_two_actual_offline_managers_use_one_current_cas_winner(self):
        destination = self.root / 'offline'
        first = self.build()
        second_path = self.root / 'second.tar.gz'
        second = self.build(OTHER, second_path)
        manager.stage_release(destination, self.archive, first['archiveSha256'], HOST, HOST)
        manager.stage_release(destination, second_path, second['archiveSha256'], HOST, HOST)
        def switch(sha_value):
            try:
                return manager.switch_release(destination, sha_value, None, HOST, HOST)
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(switch, (SHA, OTHER)))
        self.assertEqual(sum(type(result) is dict for result in results), 1)
        self.assertEqual(results.count('current_release_changed'), 1)
        current = os.readlink(destination / 'opt/nomorevibe-core/current')
        self.assertIn(current, ('releases/' + SHA, 'releases/' + OTHER))

    def test_archive_hash_binds_private_bytes_despite_same_inode_replacement(self):
        approved = self.build()
        other = self.root / 'other.tar.gz'
        self.build(OTHER, other)
        replacement = other.read_bytes()
        inode = self.archive.stat().st_ino
        open_archive = manager.tarfile.open
        swaps = []

        def swap_before_tar_open(*args, **kwargs):
            if kwargs.get('mode') == 'r:gz' and kwargs.get('fileobj') is not None:
                with self.archive.open('r+b') as stream:
                    stream.write(replacement)
                    stream.truncate()
                swaps.append(self.archive.stat().st_ino)
            return open_archive(*args, **kwargs)

        destination = self.root / 'offline'
        with patch.object(manager.tarfile, 'open', side_effect=swap_before_tar_open):
            result = manager.stage_release(destination, self.archive, approved['archiveSha256'], HOST, HOST)
        self.assertEqual(swaps, [inode])
        self.assertEqual(self.archive.read_bytes(), replacement)
        self.assertEqual(result, {'releaseSha': SHA, 'staged': True})
        releases = destination / 'opt/nomorevibe-core/releases'
        self.assertTrue((releases / SHA).is_dir())
        self.assertFalse((releases / OTHER).exists())

    def test_ancestor_alias_cannot_stage_inside_x_or_mautic_namespace(self):
        approved = self.build()
        for number, namespace in enumerate(('nomorevibe-x', 'mautic', 'mautic-retired-20261015T050901Z')):
            with self.subTest(namespace=namespace):
                excluded = self.root / namespace
                excluded.mkdir()
                child = excluded / 'child'
                child.mkdir()
                (excluded / 'sentinel').write_bytes(b'foreign-state')
                alias = self.root / f'alias-{number}'
                alias.symlink_to(excluded, target_is_directory=True)
                destination = alias / 'child'
                self.assertFalse(destination.is_symlink())
                before = sorted(str(path.relative_to(excluded)) for path in excluded.rglob('*'))
                with self.assertRaisesRegex(ValueError, 'offline_staging_root_required'):
                    manager.stage_release(destination, self.archive, approved['archiveSha256'], HOST, HOST)
                self.assertEqual(sorted(str(path.relative_to(excluded)) for path in excluded.rglob('*')), before)
                self.assertEqual((excluded / 'sentinel').read_bytes(), b'foreign-state')

    def test_switch_rejects_staged_setuid_and_setgid_modes_before_current_write(self):
        approved = self.build()
        for mode in (0o4555, 0o2555):
            with self.subTest(mode=oct(mode)):
                destination = self.root / f'offline-{mode}'
                manager.stage_release(destination, self.archive, approved['archiveSha256'], HOST, HOST)
                base = destination / 'opt/nomorevibe-core'
                node = base / f'releases/{SHA}/runtime/bin/node'
                node.chmod(mode)
                try:
                    self.assertEqual(node.stat().st_mode & 0o7777, mode)
                    with self.assertRaisesRegex(ValueError, 'staged_content_mismatch'):
                        manager.switch_release(destination, SHA, None, HOST, HOST)
                    self.assertFalse((base / 'current').is_symlink())
                finally:
                    node.chmod(0o555)

    def test_private_archive_snapshot_bounds_and_failure_cleanup(self):
        approved = self.build()
        original_bytes = self.archive.read_bytes()
        open_path = Path.open
        limit = 1024 * 1024 + len(original_bytes)

        class Snapshot:
            def __init__(self, close_error=None):
                self.stream = tempfile.TemporaryFile()
                self.close_error = close_error
                self.written = 0

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def write(self, block):
                self.written += len(block)
                return self.stream.write(block)

            def close(self):
                self.stream.close()
                if self.close_error is not None:
                    raise self.close_error

        with self.subTest(bound='growth_after_stat'):
            snapshot = Snapshot()

            def grow_before_read(path, mode='r', *args, **kwargs):
                if path == self.archive and mode == 'rb':
                    with open_path(path, 'r+b') as output:
                        output.truncate(limit + 1)
                return open_path(path, mode, *args, **kwargs)

            with patch.object(Path, 'open', grow_before_read), patch.object(manager, 'MAX_ARCHIVE_BYTES', limit), \
                    patch.object(manager.tempfile, 'TemporaryFile', return_value=snapshot), \
                    patch.object(manager.tarfile, 'open') as archive_open:
                with self.assertRaisesRegex(ValueError, 'invalid_artifact_file'):
                    manager.stage_release(self.root / 'overflow', self.archive, approved['archiveSha256'], HOST, HOST)
                archive_open.assert_not_called()
            self.assertTrue(snapshot.stream.closed)
            self.assertGreater(snapshot.written, 0)
            self.assertLessEqual(snapshot.written, limit)
            self.assertFalse((self.root / 'overflow').exists())

        self.archive.write_bytes(original_bytes)
        original, cleanup = OSError('fixture-read-error'), OSError('fixture-snapshot-close-error')

        class ReadError:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _):
                raise original

        def fail_read(path, mode='r', *args, **kwargs):
            return ReadError() if path == self.archive and mode == 'rb' else open_path(path, mode, *args, **kwargs)

        for close_error in (None, cleanup):
            with self.subTest(close_error=close_error is not None):
                snapshot = Snapshot(close_error)
                with patch.object(Path, 'open', fail_read), \
                        patch.object(manager.tempfile, 'TemporaryFile', return_value=snapshot), \
                        patch.object(manager.tarfile, 'open') as archive_open:
                    with self.assertRaises(Exception) as caught:
                        manager.stage_release(self.root / 'read-error', self.archive, approved['archiveSha256'], HOST, HOST)
                    archive_open.assert_not_called()
                if close_error is None:
                    self.assertIs(caught.exception, original)
                else:
                    self.assertIsInstance(caught.exception, BaseExceptionGroup)
                    self.assertEqual(caught.exception.exceptions, (original, cleanup))
                self.assertTrue(snapshot.stream.closed)
                self.assertEqual(snapshot.written, 0)
                self.assertFalse((self.root / 'read-error').exists())

    def test_cli_inspection_is_local_and_reports_no_readiness(self):
        result = self.build()
        command = [sys.executable, str(SOURCE / 'manage_release.py'), 'inspect', '--archive', str(self.archive),
                   '--archive-sha256', result['archiveSha256']]
        inspected = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertEqual(json.loads(inspected.stdout), {'releaseSha': SHA, 'files': 14, 'readiness': 'unverified'})
        rejected = subprocess.run(command[:-1] + ['f' * 64], capture_output=True, text=True, timeout=5)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stdout), {'error': 'ValueError', 'code': 'oracle_offline_release_failed'})


if __name__ == '__main__':
    unittest.main()
