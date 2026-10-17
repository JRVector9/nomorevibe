"""Strict offline artifact/config validation; none of these values grants readiness."""
import hashlib
import json
from pathlib import PurePosixPath
import posixpath
import re


CLI_VERSIONS = {'codex': '0.153.4', 'claude': '2.1.263', 'grok': '1.0.46'}
PLATFORM = {'os': 'linux', 'arch': 'arm64', 'libc': 'glibc'}
ROOTS = {'lib', 'scripts', 'drizzle', 'node_modules', 'runtime', 'tools', 'deploy'}
ROOT_FILES = {'package.json', 'package-lock.json', 'tsconfig.json'}
REQUIRED = ROOT_FILES | {'lib/jobs/catalog.ts', 'scripts/role-worker.ts',
                        'scripts/worker-supervisor.ts', 'scripts/scheduler.ts',
                        'node_modules/tsx/package.json', 'runtime/bin/node',
                        'deploy/oracle/launch.py',
                        *(f'tools/bin/{name}' for name in CLI_VERSIONS)}
# The launcher imports only these release-local stdlib modules.
LAUNCHER_FILES = ('deploy/oracle/launch.py', 'deploy/oracle/release_contract.py',
                  'deploy/oracle/manage_release.py', 'deploy/oracle/oci_identity.py')
MAX_FILES = 200_000
MAX_BYTES = 2 * 1024 ** 3
MAX_ARCHIVE_BYTES = 512 * 1024 ** 2


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('invalid_object_shape')


def sha(value, width=64):
    if type(value) is not str or not re.fullmatch(r'[0-9a-f]{' + str(width) + '}', value):
        raise ValueError('invalid_sha')
    return value


def payload_path(value):
    if (type(value) is not str or not value or len(value) > 1024 or '\\' in value
            or any(ord(char) < 32 for char in value)):
        raise ValueError('invalid_payload_path')
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in ('.', '..') for part in path.parts):
        raise ValueError('invalid_payload_path')
    if (len(path.parts) == 1 and value not in ROOT_FILES | ROOTS
            or len(path.parts) > 1 and path.parts[0] not in ROOTS):
        raise ValueError('invalid_payload_path')
    if any(part.startswith('.env') or part in ('.git', '.npmrc', 'credentials.json', 'auth.json') for part in path.parts):
        raise ValueError('forbidden_payload_path')
    if path.parts[0] == 'deploy' and value not in ('deploy', 'deploy/oracle', *LAUNCHER_FILES):
        raise ValueError('forbidden_payload_path')
    return value


def link_target(path, target):
    if type(target) is not str or not target or target.startswith('/') or '\\' in target:
        raise ValueError('invalid_payload_link')
    try:
        return payload_path(posixpath.normpath(posixpath.join(posixpath.dirname(path), target)))
    except ValueError as error:
        raise ValueError('invalid_payload_link') from error


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate_json_key')
        value[key] = item
    return value


def load_json(raw):
    def invalid(_):
        raise ValueError('invalid_json_constant')
    return json.loads(raw, object_pairs_hook=_unique_pairs, parse_constant=invalid)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def validate_manifest(value):
    exact(value, ('kind', 'version', 'releaseSha', 'platform', 'batchContractVersion',
                  'lockfileSha256', 'node', 'clis', 'files'))
    if (value['kind'] != 'nomorevibe-oracle-native-release'
            or type(value['version']) is not int or value['version'] != 1
            or type(value['batchContractVersion']) is not int or value['batchContractVersion'] != 1):
        raise ValueError('invalid_release_contract')
    sha(value['releaseSha'], 40)
    exact(value['platform'], PLATFORM)
    if value['platform'] != PLATFORM:
        raise ValueError('invalid_release_platform')
    sha(value['lockfileSha256'])
    rows = value['files']
    if type(rows) is not list or not 1 <= len(rows) <= MAX_FILES:
        raise ValueError('invalid_release_files')
    files = {}
    for row in rows:
        if type(row) is not dict:
            raise ValueError('invalid_release_file')
        path = payload_path(row.get('path'))
        if row.get('kind') == 'file':
            exact(row, ('path', 'kind', 'sha256', 'mode'))
            sha(row['sha256'])
            if type(row['mode']) is not int or row['mode'] not in (0o644, 0o755):
                raise ValueError('invalid_release_mode')
        elif row.get('kind') == 'symlink':
            exact(row, ('path', 'kind', 'target'))
            link_target(row.get('path'), row['target'])
        else:
            raise ValueError('invalid_release_file_kind')
        if path in files:
            raise ValueError('duplicate_release_file')
        files[path] = row
    if not REQUIRED <= set(files):
        raise ValueError('missing_release_file')
    for path, row in files.items():
        if any(str(parent) in files for parent in PurePosixPath(path).parents if str(parent) != '.'):
            raise ValueError('invalid_release_parent')
        if row['kind'] == 'symlink':
            target = files.get(link_target(path, row['target']))
            if not target or target['kind'] != 'file':
                raise ValueError('invalid_payload_link_target')

    def binary(record, expected_path):
        exact(record, ('path', 'version', 'sha256'))
        if record['path'] != expected_path:
            raise ValueError('invalid_binary_path')
        row = files[expected_path]
        if row['kind'] == 'symlink':
            row = files[link_target(expected_path, row['target'])]
        if row['kind'] != 'file' or row['mode'] != 0o755 or sha(record['sha256']) != row['sha256']:
            raise ValueError('binary_hash_mismatch')

    binary(value['node'], 'runtime/bin/node')
    if type(value['node']['version']) is not str or not re.fullmatch(r'v24\.[0-9]+\.[0-9]+', value['node']['version']):
        raise ValueError('invalid_node_pin')
    exact(value['clis'], CLI_VERSIONS)
    for name, version in CLI_VERSIONS.items():
        binary(value['clis'][name], f'tools/bin/{name}')
        if value['clis'][name]['version'] != version:
            raise ValueError('invalid_cli_pin')
    lock = files['package-lock.json']
    if lock['kind'] != 'file' or lock['sha256'] != value['lockfileSha256']:
        raise ValueError('lockfile_hash_mismatch')
    return value


def validate_host(expected, observed):
    """Compare explicit records, not physical-host attestation or runtime readiness."""
    for value in (expected, observed):
        exact(value, ('version', 'tenancy', 'region', 'instance', 'tenancyOcid', 'instanceOcid'))
        if (type(value['version']) is not int or value['version'] != 1
                or (value['tenancy'], value['region'], value['instance']) != ('surfguide', 'ap-osaka-1', 'osaka-smoke')):
            raise ValueError('oracle_host_identity_mismatch')
        for key, prefix in (('tenancyOcid', 'ocid1.tenancy.oc1..'),
                            ('instanceOcid', 'ocid1.instance.oc1.ap-osaka-1.')):
            suffix = value[key]
            if (type(suffix) is not str or not suffix.startswith(prefix)
                    or not re.fullmatch(r'[a-z0-9]{6,120}', suffix[len(prefix):])):
                raise ValueError('invalid_oracle_ocid')
    if expected != observed:
        raise ValueError('oracle_host_identity_mismatch')
