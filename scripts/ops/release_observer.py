#!/usr/bin/env python3
"""Detached, bounded, read-only observations of a pinned final fleet snapshot.

Scheduling is not success. Every future sample starts as pending/passed=false;
only an actual due-time fleet proof and five-role/scheduler gate can pass it.
Private snapshots, stdout, stderr and receipts never appear in public output.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO = Path(__file__).absolute().parents[2]
SOURCE = Path(__file__).absolute()
DEFAULT_OFFSETS = (300, 600, 900, 21600)
ROLES = ('crawler', 'reviewer', 'publisher', 'text', 'maintenance')
SOURCE_FILES = ('scripts/ops/release_observer.py', 'scripts/ops/release_runtime.py',
                'scripts/ops/deploy_git_apps.py', 'scripts/ops/deploy_shared_images.py',
                'scripts/ops/deployment_scope.py')
SHA = re.compile(r'[a-f0-9]{40}')
HASH = re.compile(r'[a-f0-9]{64}')
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
SAMPLE_TIMEOUT_SECONDS = 300
STARTUP_TIMEOUT_SECONDS = 2


class ObserverError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _iso(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ObserverError('observer_clock_invalid')
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def _parse_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if not value.endswith('Z') or parsed.tzinfo is None:
            raise ValueError('not_utc')
        return parsed.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        raise ObserverError('observer_time_invalid') from None


def _now():
    return datetime.now(timezone.utc)


def _positive_int(value):
    return type(value) is int and value > 0


def _path(path, *, missing=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ObserverError('observer_path_invalid')
    for candidate in reversed((path, *path.parents)):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if missing and candidate == path:
                continue
            raise ObserverError('observer_path_missing') from None
        if stat.S_ISLNK(info.st_mode):
            raise ObserverError('observer_symlink_forbidden')
    return path


def _private_directory(path):
    path = _path(path)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ObserverError('observer_directory_not_private')
    return path


def _private_bytes(path, *, limit=MAX_SNAPSHOT_BYTES):
    path = _path(path)
    _private_directory(path.parent)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > limit):
            raise ObserverError('observer_file_not_private')
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) != info.st_size or len(data) > limit:
            raise ObserverError('observer_file_size_invalid')
        return data
    finally:
        os.close(descriptor)


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_key')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise ObserverError('observer_json_invalid') from None
    if not isinstance(value, dict):
        raise ObserverError('observer_json_invalid')
    return value


def _snapshot(path, digest):
    if not isinstance(digest, str) or not HASH.fullmatch(digest):
        raise ObserverError('observer_snapshot_hash_invalid')
    path = _path(path)
    if path.is_relative_to(REPO):
        raise ObserverError('observer_snapshot_must_be_external')
    data = _private_bytes(path)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ObserverError('observer_snapshot_hash_mismatch')
    snapshot = _json(data)
    target = snapshot.get('target')
    if (type(snapshot.get('schemaVersion')) is not int or snapshot['schemaVersion'] != 1
            or not isinstance(target, dict) or set(target) != {'sha', 'worker', 'web'}
            or not isinstance(target.get('sha'), str) or not SHA.fullmatch(target['sha'])):
        raise ObserverError('observer_snapshot_contract_invalid')
    for kind, prefix in (('worker', 'nomorevibe-worker'), ('web', 'nomorevibe-runtime-web')):
        if (not isinstance(target.get(kind), str) or not re.fullmatch(
                'ghcr.io/jrvector9/' + prefix + r'@sha256:[a-f0-9]{64}', target[kind])):
            raise ObserverError('observer_snapshot_contract_invalid')
    apps = snapshot.get('apps')
    if (not isinstance(apps, dict) or not apps or any(not isinstance(app, str) for app in apps)
            or any(not isinstance(snapshot.get(field), dict) or set(snapshot[field]) != set(apps)
                   for field in ('runtime', 'baseline', 'latest'))):
        raise ObserverError('observer_snapshot_contract_invalid')
    for state in snapshot['baseline'].values():
        if (not isinstance(state, dict) or not isinstance(state.get('release'), str)
                or not SHA.fullmatch(state['release']) or not isinstance(state.get('specHash'), str)
                or not HASH.fullmatch(state['specHash']) or not isinstance(state.get('image'), str)
                or not re.fullmatch(r'(?:[^\s@]+@)?sha256:[a-f0-9]{64}', state['image'])):
            raise ObserverError('observer_snapshot_contract_invalid')
    return snapshot


def _source_hashes():
    result = {}
    for relative in SOURCE_FILES:
        path = _path(REPO / relative)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ObserverError('observer_source_not_owned')
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _verify_sources(plan):
    if plan.get('repo') != str(REPO) or plan.get('sourceHashes') != _source_hashes():
        raise ObserverError('observer_source_changed')


def _open_log(path, *, exclusive=False):
    path = _path(path, missing=True)
    _private_directory(path.parent)
    if path.exists():
        _private_bytes(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
    if exclusive:
        flags |= os.O_EXCL
    try:
        return os.fdopen(os.open(path, flags, 0o600), 'ab')
    except FileExistsError:
        raise ObserverError('observer_receipt_exists') from None


def _write_private(path, record):
    path = _path(path, missing=True)
    _private_directory(path.parent)
    if path.exists():
        raise ObserverError('observer_receipt_exists')
    descriptor, temporary = tempfile.mkstemp(prefix='.observer-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write((json.dumps(record, sort_keys=True, indent=2) + '\n').encode())
            output.flush()
            os.fsync(output.fileno())
        # Publish complete bytes atomically, with no replacement of an existing
        # receipt. A launcher can never observe a partially written JSON file.
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            raise ObserverError('observer_receipt_exists') from None
    finally:
        os.unlink(temporary)


def _replace_private(path, record):
    path = _path(path, missing=True)
    if path.exists():
        _private_bytes(path)
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    _write_private(temporary, record)
    os.replace(temporary, path)


def _traceback(path):
    with _open_log(path) as output:
        output.write(traceback.format_exc().encode())
        output.flush()
        os.fsync(output.fileno())


def _offsets(offsets):
    if (not isinstance(offsets, (tuple, list)) or not offsets or not all(_positive_int(value) for value in offsets)
            or list(offsets) != sorted(set(offsets))):
        raise ObserverError('observer_offsets_invalid')
    return list(offsets)


def _prepare_launch(snapshot_path, sha256, out_dir, *, offsets=DEFAULT_OFFSETS, now=None):
    offsets = _offsets(offsets)
    snapshot = _snapshot(snapshot_path, sha256)
    source_hashes = _source_hashes()
    out_dir = _path(out_dir, missing=True)
    if out_dir.is_relative_to(REPO):
        raise ObserverError('observer_directory_must_be_external')
    _private_directory(out_dir.parent)
    if out_dir.exists():
        raise ObserverError('observer_directory_exists')
    start = (now or _now)()
    plan = {'schemaVersion': 1, 'snapshotPath': str(snapshot_path), 'snapshotSha256': sha256,
            'targetRelease': snapshot['target']['sha'], 'repo': str(REPO), 'sourceHashes': source_hashes,
            'startAt': _iso(start), 'offsets': offsets, 'sampleTimeoutSeconds': SAMPLE_TIMEOUT_SECONDS,
            'productionMutations': 0, 'futurePassed': False,
            'samples': [{'offset': value, 'dueAt': _iso(start + timedelta(seconds=value)),
                         'actualAt': None, 'status': 'pending', 'passed': False} for value in offsets]}
    try:
        out_dir.mkdir(mode=0o700)
    except FileExistsError:
        raise ObserverError('observer_directory_exists') from None
    _private_directory(out_dir)
    _write_private(out_dir / 'launch.private.json', plan)
    return plan


def _load_plan(out_dir, expected_hash=None):
    out_dir = _private_directory(out_dir)
    data = _private_bytes(out_dir / 'launch.private.json')
    digest = hashlib.sha256(data).hexdigest()
    if expected_hash is not None and digest != expected_hash:
        raise ObserverError('observer_launch_hash_mismatch')
    plan = _json(data)
    offsets = _offsets(plan.get('offsets'))
    start = _parse_time(plan.get('startAt'))
    expected_samples = [{'offset': value, 'dueAt': _iso(start + timedelta(seconds=value)),
                         'actualAt': None, 'status': 'pending', 'passed': False} for value in offsets]
    if (plan.get('schemaVersion') != 1 or plan.get('samples') != expected_samples
            or not _positive_int(plan.get('sampleTimeoutSeconds')) or plan.get('productionMutations') != 0
            or plan.get('futurePassed') is not False):
        raise ObserverError('observer_launch_contract_invalid')
    return plan, digest


def _verify_inputs(plan):
    _verify_sources(plan)
    snapshot = _snapshot(plan.get('snapshotPath'), plan.get('snapshotSha256'))
    if snapshot['target']['sha'] != plan.get('targetRelease'):
        raise ObserverError('observer_target_mismatch')
    return snapshot


def _load_runtime():
    spec = importlib.util.spec_from_file_location('pinned_observer_runtime', REPO / 'scripts/ops/release_runtime.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    return runtime


def _read_only_sample(snapshot, target, repo):
    runtime = _load_runtime()
    shared = runtime.shared
    key = shared.dokploy_api_key()
    client = shared.Dokploy(key)
    observed = runtime.verify_fleet(client, snapshot, target, selected=[], receipts={}, repo=repo)
    gate = shared.monitor_gate(client, 'crawler', roles=ROLES, strict=())
    if gate.get('readiness') != 'ready' or gate.get('progress') != 'ok':
        raise ObserverError('observer_monitor_not_ready')
    return {'fleetMatched': True, 'monitorMatched': True, 'productionMutations': 0,
            'fleet': observed, 'monitor': gate}


def _stop_process(process, *, group=False):
    if process.poll() is not None:
        return
    try:
        if group:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if group:
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=1)
    except ProcessLookupError:
        pass


def _subprocess_sample(out_dir, plan, launch_hash, offset, *, popen=None):
    stdout_path = out_dir / f'sample-{offset}.stdout.private.log'
    stderr_path = out_dir / f'sample-{offset}.stderr.private.log'
    argv = [sys.executable, '-I', '-u', str(SOURCE), '--snapshot', plan['snapshotPath'],
            '--snapshot-sha', plan['snapshotSha256'], '--outdir', str(out_dir), '--launch-sha', launch_hash,
            '--sample-offset', str(offset)]
    environment = {**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'}
    with _open_log(stdout_path, exclusive=True) as stdout, _open_log(stderr_path, exclusive=True) as stderr:
        process = (popen or subprocess.Popen)(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            start_new_session=True, close_fds=True, cwd=str(REPO), env=environment)
        try:
            code = process.wait(timeout=plan['sampleTimeoutSeconds'])
        except subprocess.TimeoutExpired:
            _stop_process(process, group=True)
            raise TimeoutError('observer_sample_timeout') from None
        if code != 0:
            raise ObserverError('observer_sample_child_failed')
    return _json(_private_bytes(out_dir / f'sample-{offset}.payload.private.json'))


def run_observer(out_dir, *, now=None, sleep=None, sample=None, pid=None, launch_sha=None):
    """Driver. Inject clock/sleep/sample in tests; production samples are children."""
    now, sleep = now or _now, sleep or time.sleep
    out_dir = _private_directory(out_dir)
    plan, launch_hash = _load_plan(out_dir, launch_sha)
    snapshot = _verify_inputs(plan)
    if (out_dir / 'started.private.json').exists():
        raise ObserverError('observer_already_started')
    current_pid = os.getpid() if pid is None else pid
    if not _positive_int(current_pid):
        raise ObserverError('observer_pid_invalid')
    _write_private(out_dir / 'started.private.json',
        {'schemaVersion': 1, 'pid': current_pid, 'launchSha256': launch_hash,
         'startAt': plan['startAt'], 'actualAt': _iso(now()), 'productionMutations': 0, 'futurePassed': False})
    summary = {'schemaVersion': 1, 'targetRelease': plan['targetRelease'], 'startAt': plan['startAt'],
               'completed': False, 'productionMutations': 0, 'samples': copy.deepcopy(plan['samples'])}
    _replace_private(out_dir / 'summary.private.json', summary)
    for index, scheduled in enumerate(plan['samples']):
        offset, due = scheduled['offset'], _parse_time(scheduled['dueAt'])
        while now() < due:
            sleep(min(30, max(0.001, (due - now()).total_seconds())))
        started_path = out_dir / f'sample-{offset}.started.private.json'
        result_path = out_dir / f'sample-{offset}.result.private.json'
        if started_path.exists() or result_path.exists():
            raise ObserverError('observer_sample_exists')
        started_at = now()
        _write_private(started_path, {'schemaVersion': 1, 'offset': offset, 'dueAt': scheduled['dueAt'],
            'actualAt': _iso(started_at), 'passed': False, 'productionMutations': 0})
        record = {'schemaVersion': 1, 'offset': offset, 'dueAt': scheduled['dueAt'],
                  'startedAt': _iso(started_at), 'passed': False, 'productionMutations': 0}
        try:
            snapshot = _verify_inputs(plan)
            proof = sample(snapshot, snapshot['target'], Path(plan['repo'])) if sample else _subprocess_sample(
                out_dir, plan, launch_hash, offset)
            if (not isinstance(proof, dict) or proof.get('fleetMatched') is not True
                    or proof.get('monitorMatched') is not True or type(proof.get('productionMutations')) is not int
                    or proof['productionMutations'] != 0):
                raise ObserverError('observer_sample_proof_invalid')
            if now() < due or now() < started_at:
                raise ObserverError('observer_clock_moved_backwards')
            _verify_inputs(plan)
            record.update(passed=True, proof=proof)
        except Exception as error:
            _traceback(out_dir / f'sample-{offset}.stderr.private.log')
            record.update(error=type(error).__name__)
            if isinstance(error, ObserverError):
                record['errorCode'] = error.code
            record['actualAt'] = _iso(now())
            _write_private(result_path, record)
            summary['samples'][index].update(actualAt=record['actualAt'], status='failed', passed=False)
            summary.update(stopped=True, actualAt=record['actualAt'])
            _replace_private(out_dir / 'summary.private.json', summary)
            raise ObserverError('observer_sample_failed') from None
        record['actualAt'] = _iso(now())
        _write_private(result_path, record)
        summary['samples'][index].update(actualAt=record['actualAt'], status='completed', passed=True)
        summary['actualAt'] = record['actualAt']
        _replace_private(out_dir / 'summary.private.json', summary)
    summary.update(completed=True, actualAt=_iso(now()))
    _replace_private(out_dir / 'summary.private.json', summary)
    return {'completed': True, 'sampleCount': len(plan['samples']), 'productionMutations': 0}


def launch_observer(snapshot_path, sha256, out_dir, *, offsets=DEFAULT_OFFSETS,
                    popen=None, now=None, monotonic=None, sleep=None):
    """Launch once and require a matching started receipt plus a live PID ≤2s."""
    now, monotonic, sleep = now or _now, monotonic or time.monotonic, sleep or time.sleep
    plan = _prepare_launch(snapshot_path, sha256, out_dir, offsets=offsets, now=now)
    out_dir = Path(out_dir)
    launch_hash = hashlib.sha256(_private_bytes(out_dir / 'launch.private.json')).hexdigest()
    argv = [sys.executable, '-I', '-u', str(SOURCE), '--snapshot', str(snapshot_path), '--snapshot-sha', sha256,
            '--outdir', str(out_dir), '--launch-sha', launch_hash]
    environment = {**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'}
    with _open_log(out_dir / 'driver.stdout.private.log', exclusive=True) as stdout, \
            _open_log(out_dir / 'driver.stderr.private.log', exclusive=True) as stderr:
        try:
            process = (popen or subprocess.Popen)(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                start_new_session=True, close_fds=True, cwd=str(REPO), env=environment)
        except Exception:
            _traceback(out_dir / 'driver.stderr.private.log')
            raise ObserverError('observer_spawn_failed') from None
    deadline = monotonic() + STARTUP_TIMEOUT_SECONDS
    while monotonic() < deadline:
        if process.poll() is not None:
            raise ObserverError('observer_start_failed')
        started_path = out_dir / 'started.private.json'
        if started_path.exists():
            try:
                receipt = _json(_private_bytes(started_path))
                if (type(receipt.get('schemaVersion')) is not int or receipt['schemaVersion'] != 1
                        or not _positive_int(receipt.get('pid')) or receipt['pid'] != process.pid
                        or receipt.get('launchSha256') != launch_hash or receipt.get('startAt') != plan['startAt']
                        or type(receipt.get('productionMutations')) is not int or receipt['productionMutations'] != 0
                        or receipt.get('futurePassed') is not False):
                    raise ObserverError('observer_start_receipt_invalid')
                actual = _parse_time(receipt.get('actualAt'))
                if actual < _parse_time(plan['startAt']) or actual > now() + timedelta(seconds=5):
                    raise ObserverError('observer_start_receipt_invalid')
                _verify_sources(plan)
            except Exception:
                _stop_process(process)
                raise ObserverError('observer_start_receipt_invalid') from None
            if process.poll() is not None:
                raise ObserverError('observer_start_failed')
            return {'started': True, 'pid': process.pid, 'startAt': plan['startAt'], 'startedAt': receipt['actualAt'],
                    'outDir': str(out_dir), 'offsets': list(offsets), 'futurePassed': False,
                    'productionMutations': 0,
                    'startedReceiptSha256': hashlib.sha256(_private_bytes(started_path)).hexdigest()}
        sleep(min(0.05, max(0, deadline - monotonic())))
    _stop_process(process)
    raise ObserverError('observer_start_not_confirmed')


def _sample_main(out_dir, offset, launch_hash):
    plan, _ = _load_plan(out_dir, launch_hash)
    snapshot = _verify_inputs(plan)
    if offset not in plan['offsets']:
        raise ObserverError('observer_sample_offset_invalid')
    due = _parse_time(plan['samples'][plan['offsets'].index(offset)]['dueAt'])
    if _now() < due:
        raise ObserverError('observer_sample_not_due')
    started = _json(_private_bytes(out_dir / f'sample-{offset}.started.private.json'))
    if started.get('offset') != offset or started.get('dueAt') != _iso(due):
        raise ObserverError('observer_sample_start_invalid')
    payload_path = out_dir / f'sample-{offset}.payload.private.json'
    if payload_path.exists() or (out_dir / f'sample-{offset}.result.private.json').exists():
        raise ObserverError('observer_sample_exists')
    try:
        _write_private(out_dir / f'sample-{offset}.executing.private.json',
            {'schemaVersion': 1, 'pid': os.getpid(), 'actualAt': _iso(_now()),
             'offset': offset, 'passed': False, 'productionMutations': 0})
    except ObserverError as error:
        if error.code == 'observer_receipt_exists':
            raise ObserverError('observer_sample_exists') from None
        raise
    proof = _read_only_sample(snapshot, snapshot['target'], Path(plan['repo']))
    _verify_inputs(plan)
    _write_private(payload_path, proof)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--snapshot-sha', required=True)
    parser.add_argument('--outdir', required=True)
    parser.add_argument('--launch-sha')
    parser.add_argument('--sample-offset', type=int)
    args = parser.parse_args(argv)
    out_dir = Path(args.outdir)
    try:
        if not out_dir.exists() and args.sample_offset is None and args.launch_sha is None:
            _prepare_launch(args.snapshot, args.snapshot_sha, out_dir)
        plan, _ = _load_plan(out_dir, args.launch_sha)
        if plan['snapshotPath'] != args.snapshot or plan['snapshotSha256'] != args.snapshot_sha:
            raise ObserverError('observer_launch_arguments_mismatch')
        if args.sample_offset is None:
            result = run_observer(out_dir, launch_sha=args.launch_sha)
            print(json.dumps(result), flush=True)
        else:
            _sample_main(out_dir, args.sample_offset, args.launch_sha)
        return 0
    except Exception as error:
        try:
            _traceback(out_dir / ('driver.stderr.private.log' if args.sample_offset is None else
                                  f'sample-{args.sample_offset}.stderr.private.log'))
        except Exception:
            pass
        print(json.dumps({'error': error.code if isinstance(error, ObserverError) else 'observer_failed',
                          'productionMutations': 0}), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
