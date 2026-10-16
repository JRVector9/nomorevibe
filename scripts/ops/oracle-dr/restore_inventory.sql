\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'postgres';
SET LOCAL bytea_output = 'hex';
SET LOCAL extra_float_digits = 3;
SELECT jsonb_build_object('frame','database','value',jsonb_build_object(
 'name',current_database(),'user',current_user,'version',current_setting('server_version_num')::int,
 'encoding',pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,
 'recovery',pg_is_in_recovery())) FROM pg_database d WHERE datname=current_database();
WITH ns AS MATERIALIZED (SELECT * FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'),
 rel AS MATERIALIZED (SELECT c.*,n.nspname FROM pg_class c JOIN ns n ON n.oid=c.relnamespace),
 funcs AS MATERIALIZED (SELECT p.*,n.nspname FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace)
SELECT jsonb_build_object('frame','catalog','value',jsonb_build_object(
 'schemas',coalesce((SELECT jsonb_agg(jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text) ORDER BY nspname COLLATE "C") FROM ns),'[]'::jsonb),
 'relations',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'name',r.relname,'kind',r.relkind,
  'owner',pg_get_userbyid(r.relowner),'acl',r.relacl::text,'persistence',r.relpersistence,'replicaIdentity',r.relreplident,
  'rowSecurity',r.relrowsecurity,'forceRowSecurity',r.relforcerowsecurity,'isPartition',r.relispartition,
  'partitionBound',pg_get_expr(r.relpartbound,r.oid),
  'parents',coalesce((SELECT jsonb_agg(format('%I.%I',pn.nspname,p.relname) ORDER BY pn.nspname,p.relname) FROM pg_inherits h JOIN pg_class p ON p.oid=h.inhparent JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE h.inhrelid=r.oid),'[]'::jsonb),
  'definition',CASE WHEN r.relkind IN ('v','m') THEN pg_get_viewdef(r.oid,false) END,
  'options',r.reloptions,'accessMethod',am.amname)
  ORDER BY r.nspname COLLATE "C",r.relname COLLATE "C") FROM rel r LEFT JOIN pg_am am ON am.oid=r.relam),'[]'::jsonb),
 'columns',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'relation',r.relname,'number',a.attnum,'name',a.attname,
  'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
  'default',pg_get_expr(d.adbin,d.adrelid),'collation',CASE WHEN a.attcollation<>0 THEN format('%I.%I',cn.nspname,co.collname) END,
  'acl',a.attacl::text,'storage',a.attstorage,'statistics',a.attstattarget)
  ORDER BY r.nspname COLLATE "C",r.relname COLLATE "C",a.attnum) FROM pg_attribute a JOIN rel r ON r.oid=a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
  WHERE a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
 'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'relation',r.relname,'name',c.conname,'definition',pg_get_constraintdef(c.oid,false),'validated',c.convalidated) ORDER BY r.nspname,r.relname,c.conname) FROM pg_constraint c JOIN rel r ON r.oid=c.conrelid),'[]'::jsonb),
 'indexes',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'name',r.relname,'definition',pg_get_indexdef(r.oid),'valid',i.indisvalid,'ready',i.indisready,'replicaIdentity',i.indisreplident) ORDER BY r.nspname,r.relname) FROM rel r JOIN pg_index i ON i.indexrelid=r.oid),'[]'::jsonb),
 'functions',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',p.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definition',pg_get_functiondef(p.oid)) ORDER BY p.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM funcs p WHERE p.prokind IN ('f','p','w')),'[]'::jsonb),
 'triggers',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'relation',r.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,false)) ORDER BY r.nspname,r.relname,t.tgname) FROM pg_trigger t JOIN rel r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),'[]'::jsonb),
 'types',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),'acl',t.typacl::text,'base',format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault,'labels',coalesce((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb)) ORDER BY n.nspname,t.typname) FROM pg_type t JOIN ns n ON n.oid=t.typnamespace WHERE t.typrelid=0 AND t.typelem=0),'[]'::jsonb),
 'sequences',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'name',r.relname,'type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
  'ownedBy',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',tn.nspname,'relation',tc.relname,'column',a.attname,'dependency',d.deptype) ORDER BY tn.nspname,tc.relname,a.attname) FROM pg_depend d JOIN pg_class tc ON tc.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=tc.relnamespace JOIN pg_attribute a ON a.attrelid=tc.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=r.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')),'[]'::jsonb)) ORDER BY r.nspname,r.relname) FROM rel r JOIN pg_sequence s ON s.seqrelid=r.oid),'[]'::jsonb),
 'extensions',coalesce((SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',pg_get_userbyid(e.extowner)) ORDER BY e.extname) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),'[]'::jsonb),
 'extensionMembers',coalesce((SELECT jsonb_agg(jsonb_build_object('extension',e.extname,'type',i.type,'schema',i.schema,'name',i.name,'identity',i.identity) ORDER BY e.extname,i.type,i.schema,i.name,i.identity) FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i WHERE d.refclassid='pg_extension'::regclass AND d.deptype='e'),'[]'::jsonb),
 'largeObjects',coalesce((SELECT jsonb_agg(jsonb_build_object('oid',oid::text,'owner',pg_get_userbyid(lomowner),'acl',lomacl::text) ORDER BY oid) FROM pg_largeobject_metadata),'[]'::jsonb),
 'defaultAcl',coalesce((SELECT jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'schema',n.nspname,'kind',d.defaclobjtype,'acl',d.defaclacl::text) ORDER BY d.defaclrole,n.nspname,d.defaclobjtype) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace),'[]'::jsonb),
 'policies',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN role=0 THEN 'public' ELSE pg_get_userbyid(role) END ORDER BY role) FROM unnest(p.polroles) role),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY n.nspname,c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN ns n ON n.oid=c.relnamespace),'[]'::jsonb),
 'databaseAcl',(SELECT datacl::text FROM pg_database WHERE datname=current_database()),
 'roles',coalesce((SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'createRole',rolcreaterole,'createDb',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypassRls',rolbypassrls,'limit',rolconnlimit,'validUntil',rolvaliduntil::text,'config',rolconfig) ORDER BY rolname) FROM pg_roles),'[]'::jsonb),
 'roleMembership',coalesce((SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option) ORDER BY roleid,member) FROM pg_auth_members),'[]'::jsonb),
 'databaseSettings',coalesce((SELECT jsonb_agg(jsonb_build_object('database',CASE WHEN setdatabase=0 THEN 'all' ELSE (SELECT datname FROM pg_database WHERE oid=setdatabase) END,'role',CASE WHEN setrole=0 THEN 'all' ELSE pg_get_userbyid(setrole) END,'config',setconfig) ORDER BY setdatabase,setrole) FROM pg_db_role_setting WHERE setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))),'[]'::jsonb),
 'unsupported',jsonb_build_object('foreignTables',(SELECT count(*) FROM pg_foreign_table),'foreignServers',(SELECT count(*) FROM pg_foreign_server),'publications',(SELECT count(*) FROM pg_publication),'subscriptions',(SELECT count(*) FROM pg_subscription),'eventTriggers',(SELECT count(*) FROM pg_event_trigger),'userCollations',(SELECT count(*) FROM pg_collation c JOIN ns n ON n.oid=c.collnamespace))));
SELECT format('SELECT jsonb_build_object(''frame'',''sequence'',''key'',jsonb_build_array(%L,%L),''last'',last_value::text,''called'',is_called) FROM %I.%I;',n.nspname,c.relname,n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"
\gexec
SELECT format('SELECT jsonb_build_object(''frame'',''rows'',''key'',jsonb_build_array(%L,%L),''value'',to_jsonb(t)::text) FROM ONLY %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";',n.nspname,c.relname,n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"
\gexec
SELECT jsonb_build_object('frame','lo','key',jsonb_build_array(loid::text),'value',pageno::text||':'||encode(data,'hex')) FROM pg_largeobject ORDER BY loid,pageno;
SELECT jsonb_build_object('frame','end');
ROLLBACK;
