"""Strict PG17 catalog observations. No restoration or promotion authority."""
import copy
from datetime import datetime
import json
import re


UNKNOWN = ['restore', 'replication', 'writer_fencing', 'external_call_drain',
           'capacity', 'growth_retention', 'sequence_current_values', 'architecture',
           'extension_binaries', 'complete_ddl', 'rpo_rto']
CATALOG_KEYS = ('relations', 'columns', 'indexes', 'sequences', 'extensions', 'largeObjectCount')


def require(condition):
    if not condition:
        raise ValueError('invalid_dr_inventory')


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def integer(value, minimum=0, maximum=2 ** 32 - 1):
    require(type(value) is int and minimum <= value <= maximum)


def text(value):
    require(type(value) is str and 0 < len(value) <= 1024 and not any(ord(c) < 32 for c in value))


def timestamp(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z', value))
    datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ')


def boolean_fields(value, names):
    for name in names:
        require(type(value[name]) is bool)


def load_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result)
            result[key] = value
        return result

    def invalid(_):
        raise ValueError('invalid_dr_json')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def validate_catalog(value):
    exact(value, CATALOG_KEYS)
    for key in CATALOG_KEYS[:-1]:
        require(type(value[key]) is list)
    integer(value['largeObjectCount'], maximum=2 ** 63 - 1)
    relations = {}
    names = set()
    for row in value['relations']:
        exact(row, ('oid', 'schema', 'name', 'kind', 'persistence', 'replicaIdentity',
                    'isPartition', 'parents', 'extension', 'rowSecurity', 'forceRowSecurity',
                    'schemaUsage', 'select'))
        integer(row['oid'], 1)
        text(row['schema'])
        text(row['name'])
        require(row['oid'] not in relations and (row['schema'], row['name']) not in names)
        relations[row['oid']] = row
        names.add((row['schema'], row['name']))
        require(row['kind'] in ('r', 'p', 'f', 'v', 'm', 'S'))
        require(row['persistence'] in ('p', 'u', 't'))
        require(row['replicaIdentity'] in ('d', 'n', 'f', 'i'))
        boolean_fields(row, ('isPartition', 'rowSecurity', 'forceRowSecurity', 'schemaUsage', 'select'))
        if row['extension'] is not None:
            text(row['extension'])
        require(type(row['parents']) is list)
        parents = set()
        for parent in row['parents']:
            exact(parent, ('schema', 'name'))
            text(parent['schema'])
            text(parent['name'])
            key = (parent['schema'], parent['name'])
            require(key not in parents)
            parents.add(key)
    columns = set()
    column_names = set()
    for row in value['columns']:
        exact(row, ('relationOid', 'number', 'name', 'typeSchema', 'typeName', 'typeModifier',
                    'notNull', 'identity', 'generated', 'collationSchema', 'collationName'))
        integer(row['relationOid'], 1)
        require(row['relationOid'] in relations)
        integer(row['number'], 1, 32767)
        key = (row['relationOid'], row['number'])
        name = (row['relationOid'], row['name'])
        require(key not in columns and name not in column_names)
        columns.add(key)
        column_names.add(name)
        for field in ('name', 'typeSchema', 'typeName'):
            text(row[field])
        integer(row['typeModifier'], -(2 ** 31), 2 ** 31 - 1)
        boolean_fields(row, ('notNull',))
        require(row['identity'] in ('', 'a', 'd') and row['generated'] in ('', 's'))
        require((row['collationSchema'] is None) == (row['collationName'] is None))
        if row['collationName'] is not None:
            text(row['collationSchema'])
            text(row['collationName'])
    index_ids = set()
    for row in value['indexes']:
        exact(row, ('oid', 'relationOid', 'primary', 'replicaIdentity', 'unique', 'valid',
                    'ready', 'live', 'immediate', 'predicatePresent', 'keyAttributeNumbers'))
        integer(row['oid'], 1)
        require(row['oid'] not in index_ids and row['oid'] not in relations)
        index_ids.add(row['oid'])
        integer(row['relationOid'], 1)
        require(row['relationOid'] in relations)
        boolean_fields(row, ('primary', 'replicaIdentity', 'unique', 'valid', 'ready',
                             'live', 'immediate', 'predicatePresent'))
        require(type(row['keyAttributeNumbers']) is list and row['keyAttributeNumbers'])
        for number in row['keyAttributeNumbers']:
            integer(number, -32768, 32767)
            require(number <= 0 or (row['relationOid'], number) in columns)
    sequence_ids = set()
    for row in value['sequences']:
        exact(row, ('oid', 'typeSchema', 'typeName', 'start', 'increment', 'minimum',
                    'maximum', 'cache', 'cycle', 'ownedBy'))
        integer(row['oid'], 1)
        require(row['oid'] not in sequence_ids and row['oid'] in relations
                and relations[row['oid']]['kind'] == 'S')
        sequence_ids.add(row['oid'])
        text(row['typeSchema'])
        text(row['typeName'])
        for field in ('start', 'increment', 'minimum', 'maximum', 'cache'):
            require(type(row[field]) is str and re.fullmatch(r'-?(0|[1-9]\d*)', row[field]))
            require(-(2 ** 63) <= int(row[field]) <= 2 ** 63 - 1)
        boolean_fields(row, ('cycle',))
        require(type(row['ownedBy']) is list)
        owners = set()
        for owner in row['ownedBy']:
            exact(owner, ('relationOid', 'columnNumber', 'dependency'))
            integer(owner['relationOid'], 1)
            integer(owner['columnNumber'], 1, 32767)
            key = (owner['relationOid'], owner['columnNumber'])
            require(key in columns and key not in owners and owner['dependency'] in ('a', 'i'))
            owners.add(key)
    require(sequence_ids == {oid for oid, row in relations.items() if row['kind'] == 'S'})
    extensions = set()
    for row in value['extensions']:
        exact(row, ('name', 'version', 'schema'))
        for field in row:
            text(row[field])
        require(row['name'] not in extensions)
        extensions.add(row['name'])
    require(all(row['extension'] is None or row['extension'] in extensions for row in relations.values()))


def findings(catalog):
    result = []
    for row in sorted(catalog['relations'], key=lambda x: (x['schema'], x['name'])):
        key = [row['schema'], row['name']]
        codes = []
        if row['persistence'] != 'p':
            codes.append('non_permanent_relation')
        if row['kind'] not in ('r', 'p'):
            codes.append('relation_not_logical_table')
        else:
            indexes = [i for i in catalog['indexes'] if i['relationOid'] == row['oid']]
            usable = [i for i in indexes if all(i[k] for k in ('valid', 'ready', 'live', 'unique', 'immediate'))
                      and not i['predicatePresent'] and all(n > 0 for n in i['keyAttributeNumbers'])]
            identity = row['replicaIdentity']
            if identity == 'f':
                codes.append('replica_identity_full_requires_review')
            elif identity == 'n' or identity == 'd' and not any(i['primary'] for i in usable) \
                    or identity == 'i' and not any(i['replicaIdentity'] for i in usable):
                codes.append('update_delete_identity_missing')
            if row['isPartition'] or row['kind'] == 'p':
                codes.append('partition_publication_mapping_unverified')
        if not row['select'] or not row['schemaUsage']:
            codes.append('data_read_permission_not_observed')
        if row['rowSecurity'] or row['forceRowSecurity']:
            codes.append('row_security_requires_review')
        result.extend({'code': code, 'relation': key} for code in codes)
    if catalog['largeObjectCount']:
        result.append({'code': 'large_objects_not_logically_replicated'})
    if catalog['sequences']:
        result.append({'code': 'sequence_state_not_observed'})
    return result


def build_report(raw, *, side, label, client_started_at, client_finished_at):
    exact(raw, ('database', 'startedAt', 'finishedAt', *CATALOG_KEYS))
    database = raw['database']
    exact(database, ('name', 'oid', 'user', 'serverVersionNum', 'encoding', 'inRecovery',
                     'readOnly', 'isolation'))
    for key in ('name', 'user', 'encoding'):
        text(database[key])
    integer(database['oid'], 1)
    integer(database['serverVersionNum'], 170000, 179999)
    boolean_fields(database, ('inRecovery', 'readOnly'))
    require(database['readOnly'] and database['isolation'] == 'repeatable read')
    require(side in ('source', 'target'))
    text(label)
    require(label == label.strip() and len(label) <= 120)
    for value in (raw['startedAt'], raw['finishedAt'], client_started_at, client_finished_at):
        timestamp(value)
    require(raw['startedAt'] <= raw['finishedAt'] and client_started_at <= client_finished_at)
    catalog = {key: copy.deepcopy(raw[key]) for key in CATALOG_KEYS}
    validate_catalog(catalog)
    return {'kind': 'nomorevibe-oracle-dr-inventory', 'version': 1, 'side': side, 'label': label,
            'database': copy.deepcopy(database),
            'collectedAt': {'clientStartedAt': client_started_at, 'clientFinishedAt': client_finished_at,
                            'databaseStartedAt': raw['startedAt'], 'databaseFinishedAt': raw['finishedAt']},
            'catalog': catalog, 'findings': findings(catalog), 'readiness': 'unknown',
            'automaticDrAllowed': False, 'unknowns': list(UNKNOWN)}


def validate_report(value):
    exact(value, ('kind', 'version', 'side', 'label', 'database', 'collectedAt', 'catalog',
                  'findings', 'readiness', 'automaticDrAllowed', 'unknowns'))
    require(value['kind'] == 'nomorevibe-oracle-dr-inventory' and type(value['version']) is int
            and value['version'] == 1)
    require(type(value['automaticDrAllowed']) is bool and not value['automaticDrAllowed'])
    times = value['collectedAt']
    exact(times, ('clientStartedAt', 'clientFinishedAt', 'databaseStartedAt', 'databaseFinishedAt'))
    exact(value['catalog'], CATALOG_KEYS)
    raw = {'database': value['database'], 'startedAt': times['databaseStartedAt'],
           'finishedAt': times['databaseFinishedAt'], **value['catalog']}
    checked = build_report(raw, side=value['side'], label=value['label'],
                           client_started_at=times['clientStartedAt'], client_finished_at=times['clientFinishedAt'])
    require(value == checked)
    return checked


def compare_reports(source, target):
    source = validate_report(source)
    target = validate_report(target)
    require(source['side'] == 'source' and target['side'] == 'target')
    differences = []
    left = {(r['schema'], r['name']): r for r in source['catalog']['relations']}
    right = {(r['schema'], r['name']): r for r in target['catalog']['relations']}
    for key in sorted(left.keys() | right.keys()):
        if key not in left or key not in right:
            differences.append({'code': 'relation_missing_on_' + ('source' if key not in left else 'target'),
                                'relation': list(key)})
            continue
        fields = ('kind', 'persistence', 'replicaIdentity', 'isPartition', 'parents', 'extension',
                  'rowSecurity', 'forceRowSecurity')
        if any(left[key][f] != right[key][f] for f in fields):
            differences.append({'code': 'relation_metadata_differs', 'relation': list(key)})
        for group, code in (('columns', 'column_metadata_differs'), ('indexes', 'index_metadata_differs')):
            observed = []
            for report, relation in ((source, left[key]), (target, right[key])):
                rows = [{k: v for k, v in r.items() if k not in ('oid', 'relationOid')}
                        for r in report['catalog'][group] if r['relationOid'] == relation['oid']]
                observed.append(sorted(rows, key=lambda x: json.dumps(x, sort_keys=True)))
            if observed[0] != observed[1]:
                differences.append({'code': code, 'relation': list(key)})
        if left[key]['kind'] == 'S' and right[key]['kind'] == 'S':
            observed = []
            for report, relation in ((source, left[key]), (target, right[key])):
                sequence = next(r for r in report['catalog']['sequences'] if r['oid'] == relation['oid'])
                logical_names = {r['oid']: (r['schema'], r['name']) for r in report['catalog']['relations']}
                owners = sorted((*logical_names[o['relationOid']], o['columnNumber'], o['dependency'])
                                for o in sequence['ownedBy'])
                observed.append({**{k: v for k, v in sequence.items() if k not in ('oid', 'ownedBy')},
                                 'ownedBy': owners})
            if observed[0] != observed[1]:
                differences.append({'code': 'sequence_metadata_differs', 'relation': list(key)})
    left_extensions = {r['name']: r for r in source['catalog']['extensions']}
    right_extensions = {r['name']: r for r in target['catalog']['extensions']}
    for name in sorted(left_extensions.keys() | right_extensions.keys()):
        a, b = left_extensions.get(name), right_extensions.get(name)
        if a is None or b is None:
            differences.append({'code': 'extension_missing_on_' + ('source' if a is None else 'target'), 'name': name})
        elif a['version'] != b['version']:
            differences.append({'code': 'extension_version_differs', 'name': name,
                                'source': a['version'], 'target': b['version']})
        elif a['schema'] != b['schema']:
            differences.append({'code': 'extension_schema_differs', 'name': name})
    if source['database']['encoding'] != target['database']['encoding']:
        differences.append({'code': 'database_encoding_differs'})
    return {'kind': 'nomorevibe-oracle-dr-comparison', 'version': 1,
            'sourceLabel': source['label'], 'targetLabel': target['label'],
            'sourceDatabase': source['database'], 'targetDatabase': target['database'],
            'sourceCollectedAt': source['collectedAt'], 'targetCollectedAt': target['collectedAt'],
            'sourceFindings': source['findings'], 'targetFindings': target['findings'],
            'differences': differences, 'readiness': 'unknown', 'automaticDrAllowed': False,
            'unknowns': list(UNKNOWN)}
