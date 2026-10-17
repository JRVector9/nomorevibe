"""Bounded PG17.11 exported-DDL evidence, never PR14b restore authority.

The only ignored node field is ParseLoc location. No SQL algebra, cast removal,
OID renaming or operand sorting occurs. Historical context remains unknown.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

PG_VERSION = 170011
MAX_TREE_BYTES = 2_097_152
MAX_TOKENS = 200_000
MAX_DEPTH = 96
MAX_NODES = 30_000
SQL_PATH = Path(__file__).with_name('ddl_probe.sql')
_TOKEN = re.compile(r'<>|[{}()\[\]:]|-?\d+|[A-Za-z_][A-Za-z_0-9]*')


class DdlUnknown(ValueError):
    """Fixed safe diagnostic; never includes SQL, user rows, DSNs or stderr."""


def require(value, reason):
    if not value:
        raise DdlUnknown(reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


FIELDS = {
    'VAR': 'varno varattno vartype vartypmod varcollid varnullingrels varlevelsup varnosyn varattnosyn location',
    'CONST': 'consttype consttypmod constcollid constlen constbyval constisnull location constvalue',
    'OPEXPR': 'opno opfuncid opresulttype opretset opcollid inputcollid args location',
    'DISTINCTEXPR': 'opno opfuncid opresulttype opretset opcollid inputcollid args location',
    'SCALARARRAYOPEXPR': 'opno opfuncid hashfuncid negfuncid useOr inputcollid args location',
    'BOOLEXPR': 'boolop args location',
    'RELABELTYPE': 'arg resulttype resulttypmod resultcollid relabelformat location',
    'ARRAYEXPR': 'array_typeid array_collid element_typeid elements multidims location',
    'NULLTEST': 'arg nulltesttype argisrow location',
    'COALESCEEXPR': 'coalescetype coalescecollid args location',
    'FUNCEXPR': 'funcid funcresulttype funcretset funcvariadic funcformat funccollid inputcollid args location',
}
BOOL_FIELDS = {'constbyval', 'constisnull', 'opretset', 'useOr', 'multidims',
               'argisrow', 'funcretset', 'funcvariadic'}
NODE_FIELDS = {'arg'}
NODE_LIST_FIELDS = {'args', 'elements'}


class _Reader:
    def __init__(self, text):
        require(type(text) is str and len(text.encode()) <= MAX_TREE_BYTES, 'tree_size')
        self.tokens = []
        offset = 0
        while offset < len(text):
            if text[offset].isspace():
                offset += 1
                continue
            match = _TOKEN.match(text, offset)
            require(match is not None, 'unknown_tree_token')
            self.tokens.append(match.group())
            require(len(self.tokens) <= MAX_TOKENS, 'tree_tokens')
            offset += len(match.group())
        self.pos, self.nodes, self.locations = 0, 0, []

    def take(self, wanted=None):
        require(self.pos < len(self.tokens), 'incomplete_tree')
        token = self.tokens[self.pos]
        self.pos += 1
        require(wanted is None or token == wanted, 'invalid_tree_syntax')
        return token

    def number(self):
        token = self.take()
        require(re.fullmatch(r'-?\d+', token) is not None, 'invalid_node_number')
        require(len(token) <= 12, 'node_number_bound')
        return int(token)

    def node(self, depth=0):
        require(depth <= MAX_DEPTH, 'tree_depth')
        self.nodes += 1
        require(self.nodes <= MAX_NODES, 'tree_nodes')
        self.take('{')
        tag = self.take()
        require(tag in FIELDS, 'unknown_node')
        fields = {}
        for expected in FIELDS[tag].split():
            self.take(':')
            name = self.take()
            require(name == expected, 'unknown_or_missing_field')
            if name == 'location':
                value = self.number()
                require(value >= -1, 'invalid_location')
                self.locations.append(value)
                continue
            if name in BOOL_FIELDS:
                value = self.take()
                require(value in ('true', 'false'), 'invalid_node_boolean')
                fields[name] = value == 'true'
            elif name == 'boolop':
                value = self.take()
                require(value in ('and', 'or', 'not'), 'unknown_boolop')
                fields[name] = value
            elif name in NODE_FIELDS:
                fields[name] = self.node(depth + 1)
            elif name in NODE_LIST_FIELDS:
                self.take('(')
                values = []
                while self.pos < len(self.tokens) and self.tokens[self.pos] != ')':
                    values.append(self.node(depth + 1))
                self.take(')')
                require(values, 'empty_expression_list')
                fields[name] = values
            elif name == 'varnullingrels':
                # Only base-table Vars occur in the fixed probes; join Vars unknown.
                self.take('(')
                self.take('b')
                self.take(')')
                fields[name] = ['b']
            elif name == 'constvalue':
                if self.pos < len(self.tokens) and self.tokens[self.pos] == '<>':
                    self.take('<>')
                    fields[name] = None
                else:
                    length = self.number()
                    require(0 <= length <= MAX_TREE_BYTES, 'datum_size')
                    self.take('[')
                    values = []
                    while self.pos < len(self.tokens) and self.tokens[self.pos] != ']':
                        byte = self.number()
                        require(-128 <= byte <= 255, 'datum_byte')
                        values.append(byte)
                    self.take(']')
                    fields[name] = {'length': length, 'bytes': values}
            else:
                fields[name] = self.number()
        self.take('}')
        return {'tag': tag, 'fields': fields}


def read_pg_node_tree(text):
    reader = _Reader(text)
    if reader.tokens[:1] == ['(']:
        reader.take('(')
        tree = []
        while reader.pos < len(reader.tokens) and reader.tokens[reader.pos] != ')':
            tree.append(reader.node())
        reader.take(')')
        require(tree, 'empty_tree')
    else:
        tree = reader.node()
    require(reader.pos == len(reader.tokens), 'trailing_tree')
    return {'tree': tree, 'locations': reader.locations}


def _oid(value):
    require(type(value) is int and 0 <= value <= 4_294_967_295, 'invalid_oid')
    return value


def _catalog(context):
    keys = {'version', 'types', 'operators', 'functions', 'casts', 'collations', 'columns'}
    require(type(context) is dict and keys <= set(context) <= keys | {'database'}, 'missing_context')
    require(type(context['version']) is int and context['version'] == PG_VERSION, 'unsupported_pg_version')
    if 'database' in context:
        db = context['database']
        require(type(db) is dict and set(db) == {'encoding', 'provider', 'locale', 'collate', 'ctype',
                'icuRules', 'version', 'actualVersion'} and db['encoding'] == 'UTF8'
                and db['provider'] in ('b', 'c', 'i') and db['version'] == db['actualVersion']
                and all(db[k] is None or type(db[k]) is str for k in ('locale', 'collate', 'ctype',
                    'icuRules', 'version', 'actualVersion')), 'unknown_database_context')
    result = {}
    shapes = {
        'types': 'oid namespace name kind base element length byValue',
        'operators': 'oid namespace name left right result function',
        'functions': 'oid namespace name args result volatility definition config owner language strict returnsSet securityDefiner parallel leakproof',
        'collations': 'oid namespace name provider deterministic encoding collate ctype locale icuRules version actualVersion',
        'columns': 'number name type typmod collation notNull',
        'casts': 'source target method context function',
    }
    for group, shape in shapes.items():
        rows = context[group]
        require(type(rows) is list and len(rows) <= 20_000, 'catalog_size')
        index = {}
        for row in rows:
            require(type(row) is dict and set(row) == set(shape.split()), 'unknown_context_field')
            if group not in ('casts', 'columns'):
                require(all(type(row[k]) is str and 0 < len(row[k]) <= 256 for k in ('namespace', 'name')), 'invalid_binding_identity')
            if group == 'types':
                require(type(row['byValue']) is bool and type(row['length']) is int
                        and -2 <= row['length'] <= 1024, 'invalid_type_context')
                _oid(row['base']); _oid(row['element'])
            elif group == 'functions':
                require(type(row['args']) is list and len(row['args']) <= 100
                        and all(type(arg) is int and 0 < arg <= 4_294_967_295 for arg in row['args'])
                        and type(row['definition']) is str and 0 < len(row['definition']) <= 262_144
                        and type(row['owner']) is str and row['owner']
                        and type(row['language']) is str and row['language']
                        and row['volatility'] in ('i', 's', 'v') and row['parallel'] in ('u', 'r', 's')
                        and all(type(row[k]) is bool for k in ('strict', 'returnsSet', 'securityDefiner', 'leakproof'))
                        and (row['config'] is None or type(row['config']) is list), 'invalid_function_context')
                _oid(row['result'])
            elif group == 'operators':
                for k in ('left', 'right', 'result', 'function'): _oid(row[k])
            elif group == 'columns':
                require(type(row['typmod']) is int and type(row['notNull']) is bool
                        and type(row['name']) is str and row['name'], 'invalid_column_context')
                _oid(row['type']); _oid(row['collation'])
            if group == 'casts':
                key = (_oid(row['source']), _oid(row['target']))
                require(row['method'] in ('b', 'f', 'i') and row['context'] in ('a', 'e', 'i'), 'unknown_cast')
                _oid(row['function'])
            else:
                key = row['number'] if group == 'columns' else _oid(row['oid'])
                require(type(key) is int and key > 0, 'invalid_catalog_key')
            require(key not in index, 'duplicate_catalog_key')
            index[key] = row
        result[group] = index
    result['database'] = context.get('database')
    return result


def _validate_tree(tree, catalog):
    def bound_type(oid):
        row = catalog['types'].get(_oid(oid))
        require(row is not None and row['namespace'] == 'pg_catalog'
                and row['kind'] == 'b' and row['base'] == 0, 'unknown_type_binding')
        return row

    def collation(oid):
        if _oid(oid) == 0:
            return
        row = catalog['collations'].get(oid)
        require(row is not None and row['namespace'] == 'pg_catalog'
                and row['provider'] in ('b', 'c', 'd', 'i')
                and type(row['deterministic']) is bool
                and type(row['encoding']) is int and row['encoding'] in (-1, 6)
                and row['version'] == row['actualVersion'], 'unknown_collation_binding')
        require(catalog['database'] is not None, 'missing_collation_context')

    def function(oid):
        row = catalog['functions'].get(_oid(oid))
        require(row is not None and (row['namespace'] == 'pg_catalog'
                or (row['namespace'], row['name'], row['definition']) in TRUSTED_FUNCTIONS)
                and row['volatility'] == 'i' and row['config'] in (None, ['search_path=pg_catalog, public']),
                'unknown_function_binding')
        require(not row['securityDefiner'] and not row['returnsSet'], 'unknown_function_effects')
        if row['namespace'] == 'public':
            require(row['owner'] == 'nomorevibe', 'unknown_function_owner')
        return row

    def visit(node):
        tag, f = node['tag'], node['fields']
        if tag == 'VAR':
            column = catalog['columns'].get(f['varattno'])
            require(f['varno'] in (1, 2) and f['varlevelsup'] == 0
                    and f['varnosyn'] == f['varno'] and f['varattnosyn'] == f['varattno']
                    and column is not None and (f['vartype'], f['vartypmod'], f['varcollid'])
                    == (column['type'], column['typmod'], column['collation']), 'unknown_column_binding')
            bound_type(f['vartype']); collation(f['varcollid'])
            return f['vartype']
        if tag == 'CONST':
            typ = bound_type(f['consttype']); collation(f['constcollid'])
            require(f['constlen'] == typ['length'] and f['constbyval'] is typ['byValue'], 'unknown_const_type')
            value = f['constvalue']
            require((value is None) == f['constisnull'], 'invalid_const_null')
            if value is not None:
                require(value['length'] >= 0 and len(value['bytes']) <= MAX_TREE_BYTES, 'invalid_datum')
                if f['constbyval']:
                    require(value['length'] == f['constlen'] and len(value['bytes']) == 8, 'unsupported_datum_layout')
                else:
                    require(len(value['bytes']) == value['length'], 'invalid_datum_length')
            return f['consttype']
        if tag == 'BOOLEXPR':
            require((f['boolop'] == 'not' and len(f['args']) == 1)
                    or (f['boolop'] != 'not' and len(f['args']) >= 2), 'invalid_bool_arity')
            require(all(visit(arg) == 16 for arg in f['args']), 'invalid_bool_type')
            return 16
        if tag == 'NULLTEST':
            require(f['nulltesttype'] in (0, 1) and not f['argisrow'], 'unsupported_null_test')
            visit(f['arg'])
            return 16
        if tag == 'RELABELTYPE':
            source = visit(f['arg']); bound_type(f['resulttype']); collation(f['resultcollid'])
            cast = catalog['casts'].get((source, f['resulttype']))
            require(f['relabelformat'] in (0, 1, 2, 3) and cast is not None
                    and cast['method'] == 'b' and cast['function'] == 0, 'unknown_cast_binding')
            return f['resulttype']
        if tag == 'ARRAYEXPR':
            typ = bound_type(f['array_typeid']); bound_type(f['element_typeid']); collation(f['array_collid'])
            require(not f['multidims'] and typ['element'] == f['element_typeid']
                    and all(visit(arg) == f['element_typeid'] for arg in f['elements']), 'unknown_array_binding')
            return f['array_typeid']
        if tag == 'COALESCEEXPR':
            bound_type(f['coalescetype']); collation(f['coalescecollid'])
            require(all(visit(arg) == f['coalescetype'] for arg in f['args']), 'invalid_coalesce_type')
            return f['coalescetype']
        if tag == 'FUNCEXPR':
            proc = function(f['funcid']); bound_type(f['funcresulttype'])
            collation(f['funccollid']); collation(f['inputcollid'])
            args = [visit(arg) for arg in f['args']]
            require(not f['funcretset'] and not f['funcvariadic'] and f['funcformat'] in (0, 1, 2, 3)
                    and proc['args'] == args and proc['result'] == f['funcresulttype'], 'unknown_function_signature')
            if f['funcformat'] in (1, 2):
                cast = catalog['casts'].get((args[0], proc['result'])) if len(args) == 1 else None
                require(cast is not None and cast['method'] == 'f' and cast['function'] == f['funcid'], 'unknown_cast_binding')
            return f['funcresulttype']
        op = catalog['operators'].get(_oid(f['opno']))
        require(op is not None and op['namespace'] == 'pg_catalog'
                and f['opfuncid'] in (0, op['function']), 'unknown_operator_binding')
        proc = function(op['function'])
        args = [visit(arg) for arg in f['args']]
        require(len(args) == 2 and proc['args'] == [op['left'], op['right']]
                and proc['result'] == op['result'], 'unknown_operator_signature')
        if tag == 'SCALARARRAYOPEXPR':
            collation(f['inputcollid'])
            for oid in (f['hashfuncid'], f['negfuncid']):
                if oid: function(oid)
            require(args[0] == op['left'] and bound_type(args[1])['element'] == op['right']
                    and op['result'] == 16, 'unknown_array_operator')
            return 16
        bound_type(f['opresulttype']); collation(f['opcollid']); collation(f['inputcollid'])
        require(not f['opretset'] and args == [op['left'], op['right']]
                and f['opresulttype'] == op['result'], 'unknown_operator_signature')
        return f['opresulttype']

    if isinstance(tree, list):
        return [visit(node) for node in tree]
    return visit(tree)


def compare_native_pair(source, target, context):
    try:
        catalog = _catalog(context)
        left, right = read_pg_node_tree(source), read_pg_node_tree(target)
        _validate_tree(left['tree'], catalog); _validate_tree(right['tree'], catalog)
        return {'status': 'exported_ddl_structural_match' if left['tree'] == right['tree'] else 'mismatch',
                'historicalEquivalenceProved': False,
                'sourceTreeHash': digest(left['tree']), 'targetTreeHash': digest(right['tree']),
                'locations': {'source': left['locations'], 'target': right['locations']}}
    except DdlUnknown as error:
        return {'status': 'unknown', 'reason': str(error), 'historicalEquivalenceProved': False}


# Populated below from the fixed historical catalog, never from caller SQL.
TRUSTED_FUNCTIONS = frozenset([('public', 'invalidate_product_search_profile', 'CREATE OR REPLACE FUNCTION public.invalidate_product_search_profile()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  UPDATE product_search_profiles\n    SET needs_refresh = true, source_revision = source_revision + 1,\n        attempts = 0, error_code = null, retry_at = null\n    WHERE product_id = NEW.id;\n  RETURN NEW;\nEND;\n$function$\n'), ('public', 'search_profile_description', "CREATE OR REPLACE FUNCTION public.search_profile_description(value text, tagline text)\n RETURNS bytea\n LANGUAGE sql\n IMMUTABLE STRICT\nAS $function$\n  -- ECMAScript trim whitespace, matching profileEvidence's optional description.\n  SELECT CASE WHEN btrim(value, ws) = btrim(tagline, ws) THEN NULL ELSE search_profile_prefix(value, 600) END\n  FROM (SELECT chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||\n    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||\n    chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279) AS ws) trimmed;\n$function$\n"), ('public', 'search_profile_prefix', "CREATE OR REPLACE FUNCTION public.search_profile_prefix(value text, units integer)\n RETURNS bytea\n LANGUAGE plpgsql\n IMMUTABLE STRICT\nAS $function$\nDECLARE used integer := 0; i integer; code integer; width integer;\nBEGIN\n  FOR i IN 1..least(length(value), units) LOOP\n    code := ascii(substr(value, i, 1));\n    width := CASE WHEN code > 65535 THEN 2 ELSE 1 END;\n    IF used + width > units THEN\n      RETURN decode('01', 'hex') || convert_to(substr(value, 1, i - 1), 'UTF8') || decode(lpad(to_hex(55296 + (code - 65536) / 1024), 4, '0'), 'hex');\n    END IF;\n    used := used + width;\n    IF used = units THEN RETURN decode('00', 'hex') || convert_to(substr(value, 1, i), 'UTF8'); END IF;\n  END LOOP;\n  RETURN decode('00', 'hex') || convert_to(value, 'UTF8');\nEND;\n$function$\n")])
SQL_SHA256 = '73367721085a793dca610e890834836dd40804c735724984191fe16e6d71f8b2'


def _fixed_sql_snapshot():
    raw = SQL_PATH.read_bytes()
    require(len(raw) <= 524_288 and hashlib.sha256(raw).hexdigest() == SQL_SHA256, 'fixed_sql_changed')
    return raw


def fixed_objects():
    raw = _fixed_sql_snapshot()
    values = [json.loads(line[len('-- pr14c-object '):]) for line in raw.decode().splitlines()
              if line.startswith('-- pr14c-object ')]
    require(len(values) == 45, 'fixed_object_count')
    return values


def assess_historical(source, target):
    result = {'status': 'unknown', 'automaticDrAllowed': False, 'strictRestoreVerified': False,
              'historicalContext': 'unknown', 'historicalEquivalenceProved': False}
    try:
        for snapshot in (source, target):
            require(type(snapshot) is dict and set(snapshot) == {'database', 'catalog', 'data'}
                    and type(snapshot['database']) is dict and snapshot['database'].get('version') == PG_VERSION
                    and type(snapshot['catalog']) is dict and type(snapshot['data']) is dict, 'invalid_snapshot')
        differences = _differences(source, target)
        result['rawDifferenceCount'] = len(differences)
        result['rawDifferences'] = differences
        left_settings = source['catalog'].get('databaseSettings')
        right_settings = target['catalog'].get('databaseSettings')
        require(type(left_settings) is list and type(right_settings) is list, 'missing_database_settings')
        result['databaseSettingsAssessment'] = {
            'status': 'raw_match' if left_settings == right_settings else 'unsupported',
            'rawSource': left_settings, 'rawTarget': right_settings,
            'applied': False, 'settingsPreserved': left_settings == right_settings}
        expected_paths = set()
        counts = {'constraints': 0, 'indexes': 0, 'triggers': 0}
        for obj in fixed_objects():
            group = obj['kind']
            for snapshot, side in ((source, 'source'), (target, 'target')):
                rows = snapshot['catalog'].get(group)
                require(type(rows) is list, 'missing_object_catalog')
                found = [(i, row) for i, row in enumerate(rows) if type(row) is dict
                         and row.get('schema') == obj['schema'] and row.get('name') == obj['name']
                         and (group == 'indexes' or row.get('relation') == obj['relation'])]
                require(len(found) == 1, 'object_key_cardinality')
                index, row = found[0]
                require(row == obj[side], 'unsupported_exported_definition_or_metadata')
                expected_paths.add(('catalog', group, index, 'definition'))
            counts[group] += 1
        if left_settings != right_settings:
            expected_paths.add(('catalog', 'databaseSettings'))
        require({tuple(d['path']) for d in differences} == expected_paths, 'other_raw_difference')
        result.update(status='fixed_exported_ddl_context_required', ddlCounts=counts,
                      reason='historical_native_bindings_not_captured')
    except DdlUnknown as error:
        result['reason'] = str(error)
    return result


def _differences(left, right, path=(), depth=0):
    require(depth <= 32, 'snapshot_depth')
    if type(left) is not type(right):
        return [{'path': list(path), 'source': left, 'target': right}]
    if isinstance(left, dict):
        if set(left) != set(right):
            return [{'path': list(path), 'source': left, 'target': right}]
        return [d for key in sorted(left) for d in _differences(left[key], right[key], path + (key,), depth + 1)]
    if isinstance(left, list):
        require(len(left) <= 100_000 and len(right) <= 100_000, 'snapshot_size')
        if len(left) != len(right):
            return [{'path': list(path), 'source': left, 'target': right}]
        return [d for i, (a, b) in enumerate(zip(left, right)) for d in _differences(a, b, path + (i,), depth + 1)]
    return [] if left == right else [{'path': list(path), 'source': left, 'target': right}]


def assess_probe(frames, source, target):
    result = {'status': 'unknown', 'automaticDrAllowed': False, 'strictRestoreVerified': False,
              'historicalContext': 'unknown', 'historicalEquivalenceProved': False,
              'evidenceProvenance': 'artifact_readback_only'}
    try:
        historical = assess_historical(source, target)
        require(historical['status'] == 'fixed_exported_ddl_context_required', 'unsupported_historical_evidence')
        result['databaseSettingsAssessment'] = historical['databaseSettingsAssessment']
        require(type(frames) is list and len(frames) == 48, 'probe_frame_count')
        identity, context, end = frames[0], frames[1], frames[-1]
        require(set(identity) == {'frame', 'value'} and identity['frame'] == 'identity'
                and type(identity['value']) is dict and set(identity['value']) == {
                    'version', 'database', 'user', 'backendPid', 'transactionId'}, 'probe_identity')
        value = identity['value']
        require(value['version'] == PG_VERSION and type(value['version']) is int
                and value['database'] == 'nomorevibe_test' and value['user'] == 'nomorevibe'
                and type(value['backendPid']) is int and value['backendPid'] > 0
                and type(value['transactionId']) is str and re.fullmatch(r'[0-9]{1,20}', value['transactionId']), 'probe_identity')
        require(set(context) == {'frame', 'value'} and context['frame'] == 'context'
                and type(context['value']) is dict and set(context['value']) == {
                    'version', 'database', 'types', 'operators', 'functions', 'casts', 'collations'}, 'probe_context')
        require(end == {'frame': 'end', 'probeRelations': 0, 'transactionIdle': True}
                and type(end['probeRelations']) is int and type(end['transactionIdle']) is bool, 'rollback_unconfirmed')
        objects = fixed_objects()
        keys, relation_oids, outputs = set(), {}, []
        for frame, obj in zip(frames[2:-1], objects):
            key = [obj['kind'], obj['schema'], obj['relation'], obj['name']]
            require(type(frame) is dict and set(frame) == {'frame', 'key', 'sourceHash', 'targetHash',
                    'columns', 'source', 'target'} and frame['frame'] == 'pair' and frame['key'] == key,
                    'probe_key_or_order')
            require(tuple(key) not in keys, 'duplicate_probe_key')
            keys.add(tuple(key))
            for side in ('source', 'target'):
                require(frame[side + 'Hash'] == hashlib.sha256(obj[side]['definition'].encode()).hexdigest(), 'definition_hash_mismatch')
            ctx = {**context['value'], 'columns': frame['columns']}
            catalog = _catalog(ctx)
            a, b = frame['source'], frame['target']
            for native in (a, b):
                require(type(native) is dict and set(native) == {'tree', 'aux', 'aliasRelationOid', 'metadata'}, 'native_shape')
                require(type(native['aliasRelationOid']) is int and native['aliasRelationOid'] > 0, 'native_relation')
                require(_validate_tree(read_pg_node_tree(native['tree'])['tree'], catalog) == 16, 'predicate_not_boolean')
                _metadata(obj['kind'], native, catalog)
            require(a['aliasRelationOid'] == b['aliasRelationOid'], 'different_typed_relation')
            oid = relation_oids.setdefault(obj['relation'], a['aliasRelationOid'])
            require(oid == a['aliasRelationOid'] and len(set(relation_oids.values())) == len(relation_oids), 'relation_alias_changed')
            compared = compare_native_pair(a['tree'], b['tree'], ctx)
            if a['metadata'] != b['metadata']:
                compared = {'status': 'mismatch', 'reason': 'native_metadata_changed'}
            if a['aux'] is not None or b['aux'] is not None:
                require(a['aux'] is not None and b['aux'] is not None, 'index_expression_shape')
                auxiliary = compare_native_pair(a['aux'], b['aux'], ctx)
                if auxiliary['status'] != 'exported_ddl_structural_match': compared = auxiliary
            outputs.append({'key': key, 'comparison': compared,
                            'metadataHash': {'source': digest(a['metadata']), 'target': digest(b['metadata'])}})
        result.update(objects=outputs, matched=sum(x['comparison']['status'] == 'exported_ddl_structural_match' for x in outputs),
                      contextHash=digest(context['value']), rollbackObserved=True)
        statuses = [x['comparison']['status'] for x in outputs]
        result['status'] = 'unknown' if 'unknown' in statuses else 'mismatch' if 'mismatch' in statuses else 'exported_ddl_structural_match'
    except (DdlUnknown, TypeError, KeyError) as error:
        result['reason'] = str(error) if isinstance(error, DdlUnknown) else 'invalid_probe_shape'
    return result


def _metadata(kind, native, catalog):
    meta = native['metadata']
    require(type(meta) is dict, 'missing_native_metadata')
    if kind == 'constraints':
        require(set(meta) == {'type', 'validated', 'deferrable', 'deferred', 'noInherit'}
                and meta['type'] == 'c' and all(type(meta[k]) is bool for k in set(meta) - {'type'})
                and native['aux'] is None, 'unknown_check_metadata')
    elif kind == 'triggers':
        require(set(meta) == {'type', 'enabled', 'function', 'attributes', 'nargs', 'args', 'deferrable',
                'deferred', 'oldTable', 'newTable', 'parent', 'constraint'}, 'unknown_trigger_metadata')
        proc = catalog['functions'].get(meta['function'])
        require(type(meta['type']) is int and meta['type'] == 17 and meta['enabled'] in ('O', 'D', 'R', 'A')
                and type(meta['nargs']) is int and meta['nargs'] == 0 and meta['args'] == ''
                and all(type(meta[k]) is bool for k in ('deferrable', 'deferred'))
                and meta['oldTable'] is None and meta['newTable'] is None and meta['parent'] == 0
                and meta['constraint'] == 0 and native['aux'] is None
                and type(meta['attributes']) is str and re.fullmatch(r'[1-9][0-9]*( [1-9][0-9]*)*', meta['attributes'])
                and all(int(n) in catalog['columns'] for n in meta['attributes'].split())
                and proc is not None and proc['args'] == [] and proc['result'] == 2279
                and proc['owner'] == 'nomorevibe' and not proc['securityDefiner'] and not proc['returnsSet']
                and (proc['namespace'], proc['name'], proc['definition']) in TRUSTED_FUNCTIONS,
                'unknown_trigger_binding')
    else:
        ints = {'indnatts', 'indnkeyatts'}
        vectors = {'indkey', 'indcollation', 'indclass', 'indoption'}
        booleans = {'indisunique', 'indnullsnotdistinct', 'indisprimary', 'indisexclusion', 'indimmediate',
                    'indisvalid', 'indisready', 'indislive', 'indisreplident'}
        require(set(meta) == ints | vectors | booleans | {'opclasses'}
                and all(type(meta[k]) is bool for k in booleans)
                and all(type(meta[k]) is int for k in ints)
                and 0 < meta['indnkeyatts'] == meta['indnatts'] <= 32, 'unknown_index_metadata')
        parsed = {}
        for field in vectors:
            require(type(meta[field]) is str and re.fullmatch(r'[0-9]+( [0-9]+)*', meta[field]), 'invalid_index_vector')
            parsed[field] = [int(n) for n in meta[field].split()]
            require(len(parsed[field]) == meta['indnatts'], 'index_vector_cardinality')
        require(all(option <= 3 for option in parsed['indoption']), 'unknown_index_order')
        expressions = []
        if native['aux'] is not None:
            expressions = _validate_tree(read_pg_node_tree(native['aux'])['tree'], catalog)
            require(type(expressions) is list, 'invalid_index_expression_list')
        require(len(expressions) == parsed['indkey'].count(0), 'index_expression_cardinality')
        require(type(meta['opclasses']) is list, 'missing_opclass')
        classes = {}
        for row in meta['opclasses']:
            require(type(row) is dict and set(row) == {'oid', 'namespace', 'name', 'method', 'family', 'type', 'keyType', 'default'}
                    and row['namespace'] == 'pg_catalog' and row['method'] == 'btree'
                    and type(row['default']) is bool and row['oid'] not in classes, 'unknown_opclass')
            for k in ('oid', 'family', 'type', 'keyType'): _oid(row[k])
            classes[row['oid']] = row
        require(set(classes) == set(parsed['indclass']), 'opclass_cardinality')
        for key, coll, cls in zip(parsed['indkey'], parsed['indcollation'], parsed['indclass']):
            typ = expressions.pop(0) if key == 0 else catalog['columns'].get(key, {}).get('type')
            cast = catalog['casts'].get((typ, classes[cls]['type']))
            require(typ is not None and (classes[cls]['type'] == typ
                    or cast is not None and cast['method'] == 'b' and cast['function'] == 0), 'unknown_index_binding')
            if coll:
                row = catalog['collations'].get(coll)
                require(row is not None and row['namespace'] == 'pg_catalog'
                        and row['provider'] in ('b', 'c', 'd', 'i') and type(row['deterministic']) is bool
                        and row['encoding'] in (-1, 6) and row['version'] == row['actualVersion']
                        and catalog['database'] is not None, 'unknown_index_collation')


def _regular_input(path, maximum=67_108_864):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and 0 < info.st_size <= maximum, 'unsafe_input_file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(os.fstat(stream.fileno()).st_ino == info.st_ino, 'input_changed')
        raw = stream.read(maximum + 1)
    require(len(raw) <= maximum, 'input_size')
    return raw


def read_probe_frames(path):
    import restore_contract as contract
    raw = _regular_input(path, 33_554_432)
    lines = raw.splitlines()
    require(len(lines) == 48, 'probe_frame_count')
    return [contract.load_json(line) for line in lines]


def read_snapshot(path):
    import restore_contract as contract
    raw = _regular_input(path)
    value = contract.parse_inventory(path)
    require(_regular_input(path) == raw, 'input_changed')
    return value


def run_local_probe(identity_path, source, target, output_directory):
    """Explicit disposable local verifier only. No DSN or environment fallback.

    Existing fixed Docker/child settlement is reused. A successful child and a
    separate zero-backend check are required; a JSON artifact alone has neither.
    Root must separately allocate and authorize this fixture before invocation.
    """
    import restore_contract as contract
    import restore_rehearsal as rehearsal
    historical = assess_historical(source, target)
    require(historical['status'] == 'fixed_exported_ddl_context_required', 'unsupported_historical_evidence')
    identity = contract.read_identity(identity_path)
    require(identity['name'].startswith('nomorevibe-logical-restore-ddl-verifier-')
            and identity['scope'].startswith('pipeline-local-logical-restore-ddl-verifier-'), 'not_ddl_verifier')
    sql_snapshot = _fixed_sql_snapshot()  # Execute these verified bytes after every await.
    directory = Path(output_directory)
    directory.mkdir(mode=0o700)
    tag = 'nomorevibe-pr14c-' + uuid.uuid4().hex
    original, cleanup, assessment = None, [], None

    def sql(text, output):
        argv = [rehearsal.DOCKER, 'exec', '-i', '-e', 'PGAPPNAME=' + tag,
                '-e', 'PGOPTIONS=-c statement_timeout=15000 -c lock_timeout=1000', identity['id'], *rehearsal.PSQL]
        return rehearsal._run_child(argv, directory / output, limit=33_554_432, input_bytes=text)

    # No backend has been opened yet. A rejected container identity must not
    # reach even a read-only cleanup SQL connection.
    rehearsal.inspect_identity(identity, directory / 'inspect.json')
    try:
        info_sql = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; "
                    + rehearsal.INFO_SQL + " ROLLBACK;").encode()
        sql(info_sql, 'info.json')
        info = contract.load_json((directory / 'info.json').read_bytes())
        require(info['database'] == rehearsal.DATABASE and info['user'] == rehearsal.USER
                and info['owner'] == rehearsal.USER and info['version'] == PG_VERSION
                and info['recovery'] is False and info['clients'] == 0, 'verifier_database_identity')
        child = sql(sql_snapshot, 'probe.jsonl')
        assessment = assess_probe(read_probe_frames(directory / 'probe.jsonl'), source, target)
        assessment['execution'] = {'nativeChildExit': child['exit'], 'sqlSHA256': SQL_SHA256,
                                   'identityHash': digest(identity), 'applicationName': tag}
    except BaseException as error:
        original = error
    finally:
        try:
            # Fixed tag, no caller SQL. Actual child close precedes this observer.
            observer = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT jsonb_build_object('pending',count(*)) "
                        "FROM pg_stat_activity WHERE application_name='" + tag
                        + "' AND pid<>pg_backend_pid(); ROLLBACK;").encode()
            sql(observer, 'backends.json')
            backends = contract.load_json((directory / 'backends.json').read_bytes())
            require(backends == {'pending': 0}, 'backend_settlement_unconfirmed')
        except BaseException as error:
            cleanup.append(error)
    if original is not None or cleanup:
        try:
            rehearsal.finish_errors(original, cleanup)
        except BaseException as error:
            try:
                rehearsal._json_file(directory / 'error.json', rehearsal.safe_error(error))
            except BaseException as save_error:
                rehearsal.finish_errors(error, [save_error])
            raise
    assessment['evidenceProvenance'] = 'fixed_local_native_probe'
    assessment['execution']['taggedBackends'] = 0
    return assessment


def main(argv=None):
    import restore_rehearsal as rehearsal
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Explicit original PR14b source inventory JSONL')
    parser.add_argument('--target', required=True, help='Explicit original PR14b target inventory JSONL')
    parser.add_argument('--report', required=True, help='New private JSON report; refuses overwrite')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--probe-artifact', help='Offline un-attested native probe JSONL')
    mode.add_argument('--verifier-identity', help='Root-assigned disposable local verifier identity')
    parser.add_argument('--probe-directory', help='New private output directory, explicit native mode only')
    args = parser.parse_args(argv)
    try:
        require(bool(args.verifier_identity) == bool(args.probe_directory), 'probe_directory_contract')
        source, target = read_snapshot(args.source), read_snapshot(args.target)
        report = {'version': 1, 'historicalAssessment': assess_historical(source, target),
                  'exportedDdlAssessment': {'status': 'unknown', 'reason': 'native_probe_not_run'},
                  'strictRestoreVerified': False, 'readiness': 'unknown', 'automaticDrAllowed': False}
        if args.probe_artifact:
            report['exportedDdlAssessment'] = assess_probe(read_probe_frames(args.probe_artifact), source, target)
        elif args.verifier_identity:
            report['exportedDdlAssessment'] = run_local_probe(args.verifier_identity, source, target, args.probe_directory)
        rehearsal._json_file(Path(args.report), report)
        print(json.dumps({'outcome': 'assessment_recorded', 'readiness': 'unknown', 'automaticDrAllowed': False}))
        return 0
    except BaseException as error:
        print(json.dumps({'outcome': 'failed', 'error': str(error) if isinstance(error, DdlUnknown)
                          else rehearsal.safe_error(error), 'automaticDrAllowed': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
