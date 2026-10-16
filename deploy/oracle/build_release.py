"""Package an already prepared native tree. Never installs, builds or runs its code."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile

from release_contract import CLI_VERSIONS, MAX_BYTES, PLATFORM, file_hash, json_bytes, payload_path, sha, validate_manifest


def runtime_platform():
    return {'system': platform.system(), 'machine': platform.machine(), 'libc': platform.libc_ver()[0]}


def build_release(source, output, release_sha, node_version):
    if runtime_platform() != {'system': 'Linux', 'machine': 'aarch64', 'libc': 'glibc'}:
        raise ValueError('native_builder_requires_linux_arm64_glibc')
    sha(release_sha, 40)
    source, output = Path(source), Path(output)
    if source.is_symlink() or not source.is_dir() or output.exists() or output.is_symlink():
        if output.exists() or output.is_symlink():
            raise FileExistsError('artifact_already_exists')
        raise ValueError('invalid_prepared_directory')
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError('output_inside_prepared_directory')
    files, total = [], 0
    for path in sorted(source.rglob('*')):
        name = payload_path(path.relative_to(source).as_posix())
        if path.is_symlink():
            files.append({'path': name, 'kind': 'symlink', 'target': os.readlink(path)})
        elif path.is_file():
            if path.stat().st_nlink != 1:
                raise ValueError('prepared_hardlink_not_supported')
            total += path.stat().st_size
            if total > MAX_BYTES:
                raise ValueError('artifact_too_large')
            files.append({'path': name, 'kind': 'file', 'sha256': file_hash(path),
                          'mode': 0o755 if path.stat().st_mode & 0o111 else 0o644})
        elif not path.is_dir():
            raise ValueError('unsupported_prepared_entry')
    by_path = {row['path']: row for row in files}

    def binary(path, version):
        from release_contract import link_target
        row = by_path.get(path, {})
        if row.get('kind') == 'symlink':
            row = by_path.get(link_target(path, row['target']), {})
        return {'path': path, 'version': version, 'sha256': row.get('sha256')}

    value = validate_manifest({'version': 1, 'kind': 'nomorevibe-oracle-native-release',
        'releaseSha': release_sha, 'platform': PLATFORM.copy(), 'batchContractVersion': 1,
        'lockfileSha256': by_path.get('package-lock.json', {}).get('sha256'),
        'node': binary('runtime/bin/node', node_version),
        'clis': {name: binary(f'tools/bin/{name}', version) for name, version in CLI_VERSIONS.items()},
        'files': files})
    raw = json_bytes(value)
    descriptor, temporary = tempfile.mkstemp(prefix='.oracle-artifact-', dir=output.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            with gzip.GzipFile(fileobj=stream, mode='wb', filename='', mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    item = tarfile.TarInfo('manifest.json')
                    item.size, item.mode = len(raw), 0o644
                    archive.addfile(item, io.BytesIO(raw))
                    for row in files:
                        item = tarfile.TarInfo('payload/' + row['path'])
                        if row['kind'] == 'symlink':
                            item.type, item.linkname, item.mode = tarfile.SYMTYPE, row['target'], 0o777
                            archive.addfile(item)
                        else:
                            path = source / row['path']
                            if path.is_symlink() or file_hash(path) != row['sha256']:
                                raise ValueError('prepared_file_changed')
                            item.size, item.mode = path.stat().st_size, row['mode']
                            with path.open('rb') as content:
                                archive.addfile(item, content)
            stream.flush()
            os.fsync(stream.fileno())
        # Exclusive link publishes the artifact without overwriting another builder's output.
        os.link(temporary, output)
        result = {'archiveSha256': file_hash(output), 'manifestSha256': hashlib.sha256(raw).hexdigest(), 'releaseSha': release_sha}
    except BaseException as original:
        try:
            temporary.unlink(missing_ok=True)
        except BaseException as cleanup:
            raise BaseExceptionGroup('build_and_cleanup_failed', [original, cleanup]) from None
        raise
    else:
        temporary.unlink(missing_ok=True)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--node-version', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(build_release(args.prepared, args.output, args.sha, args.node_version)))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'code': 'oracle_artifact_build_failed'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
