"""Local logical restore evidence. These JSON values confer no runtime authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

PINNED_IMAGE = 'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f'
IDENTITY_KEYS = {'id', 'name', 'volume', 'port', 'scope', 'image', 'state', 'sourceHead', 'memoryBytes'}
UNKNOWN = ['oracle_arm', 'production_capacity', 'growth_retention', 'replication', 'promotion',
           'writer_fencing', 'external_call_drain', 'rpo_rto', 'concurrent_source_writers',
           'cluster_globals', 'operational_credentials']


class RestoreError(Exception):
    def __init__(self, code, process_exit=None):
        self.code = code
        self.process_exit = process_exit
        super().__init__(code)


def require(condition, code='invalid_contract'):
    if not condition:
        raise RestoreError(code)


def positive(value):
    require(type(value) is int and value > 0, 'invalid_positive_bound')
    return value


def load_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'duplicate_json_key')
            value[key] = item
        return value
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, 'invalid_json_number'))
    except (ValueError, TypeError, UnicodeError):
        raise RestoreError('invalid_json') from None


def parse_identity(value):
    require(type(value) is dict and set(value) == IDENTITY_KEYS, 'invalid_identity')
    require(type(value['id']) is str and re.fullmatch('[0-9a-f]{64}', value['id']), 'invalid_identity')
    for field in ('name', 'volume', 'scope'):
        require(type(value[field]) is str and re.fullmatch('[a-z0-9][a-z0-9-]{1,119}', value[field]), 'invalid_identity')
    require(value['name'].startswith('nomorevibe-logical-restore-')
            and value['volume'] == value['name'] + '-data'
            and value['scope'].startswith('pipeline-local-logical-restore-'), 'invalid_identity')
    require(type(value['port']) is int and 1024 <= value['port'] <= 65535, 'invalid_identity')
    require(type(value['memoryBytes']) is int and 0 < value['memoryBytes'] <= 805306368, 'invalid_identity')
    require(value['image'] == PINNED_IMAGE and value['state'] == 'created', 'invalid_identity')
    require(type(value['sourceHead']) is str and re.fullmatch('[0-9a-f]{40}', value['sourceHead']), 'invalid_identity')
    return dict(value)


def read_identity(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), 'unsafe_identity_file')
    require(info.st_size <= 8192, 'invalid_identity')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(os.fstat(stream.fileno()).st_ino == info.st_ino, 'identity_changed')
        return parse_identity(load_json(stream.read(8193)))


def check_pair(source, target):
    source, target = parse_identity(source), parse_identity(target)
    require(all(source[key] != target[key] for key in ('id', 'name', 'volume', 'port', 'scope')), 'identical_source_target')


def assert_empty(value):
    require(type(value) is dict and set(value) == {'objects'} and type(value['objects']) is int, 'invalid_empty_inventory')
    require(value['objects'] == 0, 'target_not_empty')


def compare_snapshots(source, target):
    require(type(source) is dict and type(target) is dict, 'invalid_inventory')
    require(set(source) == set(target) == {'database', 'catalog', 'data'}, 'invalid_inventory')
    require(source == target, 'restore_mismatch')
    return {'outcome': 'local_restore_verified', 'readiness': 'unknown',
            'automaticDrAllowed': False, 'mismatches': [], 'unknown': list(UNKNOWN)}


def archive_receipt(path):
    size, digest = 0, hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'unsafe_archive')
        prefix = stream.read(5)
        require(prefix == b'PGDMP', 'invalid_archive')
        digest.update(prefix)
        size = len(prefix)
        while block := stream.read(65536):
            digest.update(block)
            size += len(block)
    return {'bytes': size, 'sha256': digest.hexdigest()}


def verify_archive(path, receipt):
    require(archive_receipt(path) == receipt, 'archive_changed')


def parse_inventory(path):
    """Hash exact PG JSONB row text, never round-trip SQL numeric values through float."""
    database = catalog = None
    data, ended, last_key, digest, count = {}, False, None, None, 0
    def finish():
        if last_key is not None:
            require(last_key not in data, 'duplicate_data_key')
            data[last_key] = {'count': count, 'sha256': digest.hexdigest()}
    with open(path, 'rb') as stream:
        for raw in stream:
            frame = load_json(raw)
            require(type(frame) is dict and 'frame' in frame and not ended, 'invalid_inventory_frame')
            kind = frame['frame']
            if kind == 'database':
                require(database is None and set(frame) == {'frame', 'value'}, 'invalid_inventory_frame')
                database = frame['value']
            elif kind == 'catalog':
                require(database is not None and catalog is None and set(frame) == {'frame', 'value'}, 'invalid_inventory_frame')
                catalog = frame['value']
            elif kind == 'sequence':
                require(catalog is not None and set(frame) == {'frame', 'key', 'last', 'called'}, 'invalid_inventory_frame')
                catalog.setdefault('sequenceValues', []).append({key: frame[key] for key in ('key', 'last', 'called')})
            elif kind in ('rows', 'lo'):
                require(catalog is not None and set(frame) == {'frame', 'key', 'value'}, 'invalid_inventory_frame')
                require(type(frame['key']) is list and type(frame['value']) is str, 'invalid_inventory_frame')
                key = json.dumps([kind, frame['key']], ensure_ascii=True, separators=(',', ':'))
                if last_key != key:
                    finish()
                    last_key, digest, count = key, hashlib.sha256(), 0
                encoded = frame['value'].encode('utf-8')
                digest.update(len(encoded).to_bytes(8, 'big'))
                digest.update(encoded)
                count += 1
            elif kind == 'end':
                require(set(frame) == {'frame'} and catalog is not None, 'invalid_inventory_frame')
                ended = True
            else:
                raise RestoreError('invalid_inventory_frame')
    finish()
    require(ended and type(database) is dict and type(catalog) is dict, 'incomplete_inventory')
    # Empty relations/LOs are still in the catalog; data absence means zero rows, not missing relation.
    return {'database': database, 'catalog': catalog, 'data': data}
