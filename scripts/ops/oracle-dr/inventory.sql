BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
SELECT pg_catalog.jsonb_build_object(
  'frame', 'start',
  'at', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'database', pg_catalog.jsonb_build_object(
    'name', pg_catalog.current_database(),
    'oid', (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    'user', current_user,
    'serverVersionNum', pg_catalog.current_setting('server_version_num')::integer,
    'encoding', pg_catalog.current_setting('server_encoding'),
    'inRecovery', pg_catalog.pg_is_in_recovery(),
    'readOnly', pg_catalog.current_setting('transaction_read_only') = 'on',
    'isolation', pg_catalog.current_setting('transaction_isolation')));
WITH relations AS MATERIALIZED (
  SELECT c.*, n.nspname AS schema_name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
)
SELECT pg_catalog.jsonb_build_object('frame', 'inventory', 'catalog', pg_catalog.jsonb_build_object(
  'relations', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'oid', r.oid::bigint, 'schema', r.schema_name, 'name', r.relname,
    'kind', r.relkind, 'persistence', r.relpersistence, 'replicaIdentity', r.relreplident,
    'isPartition', r.relispartition,
    'parents', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', pn.nspname, 'name', p.relname) ORDER BY pn.nspname, p.relname)
      FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class p ON p.oid = h.inhparent
      JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace WHERE h.inhrelid = r.oid), '[]'::jsonb),
    'extension', (SELECT e.extname FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = r.oid AND d.objsubid = 0
        AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e'),
    'rowSecurity', r.relrowsecurity, 'forceRowSecurity', r.relforcerowsecurity,
    'schemaUsage', pg_catalog.has_schema_privilege(current_user, r.relnamespace, 'USAGE'),
    'select', pg_catalog.has_table_privilege(current_user, r.oid, 'SELECT'))
    ORDER BY r.schema_name, r.relname) FROM relations r), '[]'::jsonb),
  'columns', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'relationOid', a.attrelid::bigint, 'number', a.attnum, 'name', a.attname,
    'typeSchema', tn.nspname, 'typeName', t.typname, 'typeModifier', a.atttypmod,
    'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
    'collationSchema', cn.nspname, 'collationName', co.collname) ORDER BY a.attrelid, a.attnum)
    FROM pg_catalog.pg_attribute a JOIN relations r ON r.oid = a.attrelid
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb),
  'indexes', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'oid', i.indexrelid::bigint, 'relationOid', i.indrelid::bigint, 'primary', i.indisprimary,
    'replicaIdentity', i.indisreplident, 'unique', i.indisunique, 'valid', i.indisvalid,
    'ready', i.indisready, 'live', i.indislive, 'immediate', i.indimmediate,
    'predicatePresent', i.indpred IS NOT NULL,
    'keyAttributeNumbers', (SELECT pg_catalog.jsonb_agg(k.number ORDER BY k.ordinal)
      FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(number, ordinal)
      WHERE k.ordinal <= i.indnkeyatts)) ORDER BY i.indexrelid)
    FROM pg_catalog.pg_index i JOIN relations r ON r.oid = i.indrelid), '[]'::jsonb),
  'sequences', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'oid', s.seqrelid::bigint, 'typeSchema', tn.nspname, 'typeName', t.typname,
    'start', s.seqstart::text, 'increment', s.seqincrement::text, 'minimum', s.seqmin::text,
    'maximum', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
    'ownedBy', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'relationOid', d.refobjid::bigint, 'columnNumber', d.refobjsubid, 'dependency', d.deptype)
      ORDER BY d.refobjid, d.refobjsubid)
      FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass
        AND d.objid = s.seqrelid AND d.objsubid = 0
        AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjsubid > 0
        AND d.deptype IN ('a', 'i')), '[]'::jsonb)) ORDER BY s.seqrelid)
    FROM pg_catalog.pg_sequence s JOIN relations r ON r.oid = s.seqrelid
    JOIN pg_catalog.pg_type t ON t.oid = s.seqtypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace), '[]'::jsonb),
  'extensions', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', e.extname, 'version', e.extversion, 'schema', n.nspname) ORDER BY e.extname)
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace), '[]'::jsonb),
  'largeObjectCount', (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata)));
SELECT pg_catalog.jsonb_build_object('frame', 'end',
  'at', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
ROLLBACK;
