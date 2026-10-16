"""Offline release staging only. Live root, activation and service control are unavailable."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
from uuid import uuid4

from release_contract import (MAX_ARCHIVE_BYTES, MAX_BYTES, MAX_FILES, file_hash,
                              json_bytes, load_json, sha, validate_host, validate_manifest)


def render_units(cpu_quota_percent, memory_bytes, tasks):
    for value, maximum in ((cpu_quota_percent, 100), (memory_bytes, 2 ** 63 - 1), (tasks, 65536)):
        if type(value) is not int or not 1 <= value <= maximum:
            raise ValueError('explicit_measured_budget_required')
    result = {}
    for name in ('nomorevibe-core.slice', 'nomorevibe-core-role@.service', 'nomorevibe-core-scheduler.service'):
        text = (Path(__file__).parent / name).read_text()
        for token, value in (('CPU_QUOTA_PERCENT', cpu_quota_percent), ('MEMORY_BYTES', memory_bytes), ('TASKS', tasks)):
            text = text.replace('@MEASURED_' + token + '@', str(value))
        result[name] = text
    return result


@contextmanager
def _archive(path, expected_hash):
    sha(expected_hash)
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('invalid_artifact_file')
    snapshot = tempfile.TemporaryFile()
    try:
        digest, copied = hashlib.sha256(), 0
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                copied += len(block)
                if copied > MAX_ARCHIVE_BYTES:
                    raise ValueError('invalid_artifact_file')
                snapshot.write(block)
                digest.update(block)
        if digest.hexdigest() != expected_hash:
            raise ValueError('artifact_hash_mismatch')
        snapshot.seek(0)
        with tarfile.open(fileobj=snapshot, mode='r:gz') as archive:
            members, total = {}, 0
            for item in archive:
                if len(members) >= MAX_FILES + 1 or item.name in members:
                    raise ValueError('duplicate_or_excess_archive_entries')
                if not item.isfile() and not item.issym():
                    raise ValueError('unsupported_archive_entry')
                if item.isfile():
                    total += item.size
                    if item.size < 0 or total > MAX_BYTES or item.name == 'manifest.json' and item.size > 32 * 1024 ** 2:
                        raise ValueError('archive_too_large')
                members[item.name] = item
            item = members.get('manifest.json')
            if item is None or not item.isfile():
                raise ValueError('missing_archive_manifest')
            with archive.extractfile(item) as content:
                manifest = validate_manifest(load_json(content.read()))
            rows = {row['path']: row for row in manifest['files']}
            if set(members) != {'manifest.json', *(f'payload/{path}' for path in rows)}:
                raise ValueError('archive_catalog_mismatch')
            for name, row in rows.items():
                item = members['payload/' + name]
                if row['kind'] == 'symlink':
                    if not item.issym() or item.linkname != row['target']:
                        raise ValueError('archive_link_mismatch')
                else:
                    if not item.isfile() or item.mode != row['mode']:
                        raise ValueError('archive_mode_mismatch')
                    with archive.extractfile(item) as content:
                        if hashlib.file_digest(content, 'sha256').hexdigest() != row['sha256']:
                            raise ValueError('archive_content_mismatch')
            yield archive, manifest, members
    except BaseException as original:
        try:
            snapshot.close()
        except BaseException as cleanup:
            raise BaseExceptionGroup('archive_and_cleanup_failed', [original, cleanup]) from None
        raise
    else:
        snapshot.close()


def inspect_archive(path, expected_hash):
    with _archive(path, expected_hash) as (_, manifest, _):
        return manifest


def _base(root):
    root = Path(root)
    resolved = root.resolve()
    if (not root.is_absolute() or root.is_symlink() or resolved == Path('/')
            or any(part in ('nomorevibe-x', 'mautic', 'mautic-retired-20261015T050901Z')
                   for part in (*root.parts, *resolved.parts))):
        raise ValueError('offline_staging_root_required')
    current = root
    # Resolve only the caller-owned offline root; every managed descendant must stay a real directory.
    for name in ('opt', 'nomorevibe-core', 'releases'):
        current /= name
        if current.is_symlink() or current.exists() and not current.is_dir():
            raise ValueError('unsafe_staging_directory')
    return root / 'opt/nomorevibe-core'


@contextmanager
def _locked(root):
    base = _base(root)
    (base / 'releases').mkdir(parents=True, exist_ok=True)
    descriptor = os.open(base / '.manager.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Recheck descendants after taking the single local manager lock.
        _base(root)
        yield base


def _sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _verify_release(path):
    if path.is_symlink() or not path.is_dir() or (path / 'release.json').is_symlink():
        raise ValueError('invalid_staged_release')
    manifest = validate_manifest(load_json((path / 'release.json').read_bytes()))
    if path.name != manifest['releaseSha']:
        raise ValueError('staged_release_identity_mismatch')
    rows = {row['path']: row for row in manifest['files']}
    actual = {entry.relative_to(path).as_posix() for entry in path.rglob('*')
              if entry.is_symlink() or not entry.is_dir()}
    if actual != {*rows, 'release.json'}:
        raise ValueError('staged_catalog_mismatch')
    for name, row in rows.items():
        target = path / name
        if row['kind'] == 'symlink':
            if not target.is_symlink() or os.readlink(target) != row['target']:
                raise ValueError('staged_link_mismatch')
        elif (target.is_symlink() or not target.is_file() or file_hash(target) != row['sha256']
              or target.stat().st_mode & 0o7777 != (0o555 if row['mode'] == 0o755 else 0o444)):
            raise ValueError('staged_content_mismatch')
    return manifest


def stage_release(root, path, expected_hash, expected_host, observed_host):
    validate_host(expected_host, observed_host)
    _base(root)
    with _archive(path, expected_hash) as (archive, manifest, members):
        with _locked(root) as base:
            destination = base / 'releases' / manifest['releaseSha']
            if destination.exists() or destination.is_symlink():
                if _verify_release(destination) != manifest:
                    raise ValueError('staged_release_conflict')
                return {'releaseSha': manifest['releaseSha'], 'staged': True}
            temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=base / 'releases'))
            try:
                # All paths/catalog/links were checked before any payload write. Links go last.
                for row in manifest['files']:
                    if row['kind'] != 'file':
                        continue
                    target = temporary / row['path']
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(members['payload/' + row['path']]) as content, target.open('xb') as output:
                        shutil.copyfileobj(content, output)
                        output.flush()
                        os.fsync(output.fileno())
                    if file_hash(target) != row['sha256']:
                        raise ValueError('artifact_changed_during_stage')
                    target.chmod(0o555 if row['mode'] == 0o755 else 0o444)
                for row in manifest['files']:
                    if row['kind'] == 'symlink':
                        target = temporary / row['path']
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.symlink_to(row['target'])
                (temporary / 'release.json').write_bytes(json_bytes(manifest))
                (temporary / 'release.json').chmod(0o444)
                _sync_directory(temporary)
                os.rename(temporary, destination)
                _sync_directory(destination.parent)
                return {'releaseSha': manifest['releaseSha'], 'staged': True}
            except BaseException as original:
                try:
                    if temporary.exists():
                        shutil.rmtree(temporary)
                except BaseException as cleanup:
                    raise BaseExceptionGroup('stage_and_cleanup_failed', [original, cleanup]) from None
                raise


def switch_release(root, sha_value, expected_current, expected_host, observed_host):
    validate_host(expected_host, observed_host)
    sha(sha_value, 40)
    if expected_current is not None:
        sha(expected_current, 40)
    with _locked(root) as base:
        _verify_release(base / 'releases' / sha_value)
        current = base / 'current'
        old = None
        if current.is_symlink():
            link = PurePosixPath(os.readlink(current))
            if len(link.parts) != 2 or link.parts[0] != 'releases':
                raise ValueError('invalid_current_link')
            old = sha(link.parts[1], 40)
        elif current.exists():
            raise ValueError('invalid_current_link')
        if old != expected_current:
            raise ValueError('current_release_changed')
        temporary = base / ('.current-' + uuid4().hex)
        temporary.symlink_to('releases/' + sha_value)
        try:
            os.replace(temporary, current)
            _sync_directory(base)
        except BaseException as original:
            try:
                temporary.unlink(missing_ok=True)
            except BaseException as cleanup:
                raise BaseExceptionGroup('switch_and_cleanup_failed', [original, cleanup]) from None
            raise
        return {'previous': old, 'current': sha_value}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    inspect = sub.add_parser('inspect')
    stage = sub.add_parser('stage')
    switch = sub.add_parser('switch')
    for command in (inspect, stage):
        command.add_argument('--archive', required=True, type=Path)
        command.add_argument('--archive-sha256', required=True)
    for command in (stage, switch):
        command.add_argument('--staging-root', required=True, type=Path)
        command.add_argument('--expected-host', required=True, type=Path)
        command.add_argument('--observed-host', required=True, type=Path)
    switch.add_argument('--sha', required=True)
    switch.add_argument('--expected-current')
    args = parser.parse_args()
    try:
        if args.action == 'inspect':
            value = inspect_archive(args.archive, args.archive_sha256)
            result = {'releaseSha': value['releaseSha'], 'files': len(value['files']), 'readiness': 'unverified'}
        else:
            hosts = (load_json(args.expected_host.read_bytes()), load_json(args.observed_host.read_bytes()))
            if args.action == 'stage':
                result = stage_release(args.staging_root, args.archive, args.archive_sha256, *hosts)
            else:
                result = switch_release(args.staging_root, args.sha, args.expected_current, *hosts)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'code': 'oracle_offline_release_failed'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
