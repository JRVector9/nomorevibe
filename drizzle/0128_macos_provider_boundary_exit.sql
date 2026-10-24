-- Privileged operator observations only. Keep existing CHECK definitions/OIDs and Linux bodies intact.
DO $$
DECLARE n text; definition text; needle text:='p->''provider''->>''kind'' IS DISTINCT FROM ''systemd''';
BEGIN
  FOREACH n IN ARRAY ARRAY['nmv_boundary_identity_valid','nmv_boundary_exit_valid','nmv_provider_boundary_release_valid'] LOOP
    definition:=pg_get_functiondef(('public.'||n||'(jsonb)')::regprocedure);
    IF definition NOT LIKE 'CREATE OR REPLACE FUNCTION public.'||n||'(%' THEN RAISE EXCEPTION 'boundary_function_signature_changed'; END IF;
    EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.'||n||'\(','CREATE FUNCTION public.'||n||'_linux_0126(');
  END LOOP;
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_valid(jsonb)'::regprocedure);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'boundary_provider_branch_changed'; END IF;
  definition:=replace(definition,needle,'p->''provider''->>''kind'' IS DISTINCT FROM ''launchd''');
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_valid\(','CREATE FUNCTION public.nmv_provider_boundary_release_launchd_valid(');
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boundary_launchd_identity_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text; child jsonb;
BEGIN
  IF NOT nmv_boundary_keys(v,ARRAY['host','hostBootId','kind','service','serviceRevision','incarnationId','startedAt','pid','startSec','startUsec','uid','ppid','pgid','sid','domain','label','servingRevision','plistSha256','entrySha256','topologyProofSha256','inferenceScope','knownDescendantPids','listenerPort'])
    OR v->>'kind' IS DISTINCT FROM 'launchd' OR v->>'inferenceScope' IS DISTINCT FROM 'in_process_threads_only' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['host','hostBootId','service','serviceRevision','incarnationId','startedAt','domain','label','servingRevision'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR char_length(v->>k) NOT BETWEEN 1 AND (CASE WHEN k='host' THEN 120 ELSE 200 END)
      OR v->>k<>btrim(v->>k) OR v->>k ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['plistSha256','entrySha256','topologyProofSha256'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR v->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['pid','uid','ppid','pgid','sid','startUsec','listenerPort'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' OR v->>k !~ '^(0|[1-9][0-9]*)$' OR (v->>k)::numeric>9007199254740991 THEN RETURN false; END IF;
  END LOOP;
  IF (v->>'pid')::numeric<2 OR (v->>'ppid')::numeric<1 OR (v->>'pgid')::numeric<2 OR v->'pgid' IS DISTINCT FROM v->'pid' OR (v->>'sid')::numeric<1
    OR (v->>'startUsec')::numeric>999999 OR (v->>'listenerPort')::numeric NOT BETWEEN 1 AND 65535
    OR jsonb_typeof(v->'startSec') IS DISTINCT FROM 'string' OR v->>'startSec' !~ '^[1-9][0-9]*$' OR (v->>'startSec')::numeric>9007199254740991
    OR v->>'hostBootId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR v->>'domain' !~ '^(system|(gui|user)/[0-9]+)$' OR v->>'service' IS DISTINCT FROM (v->>'domain')||'/'||(v->>'label')
    OR (v->>'domain'<>'system' AND v->>'domain' NOT IN ('gui/'||(v->>'uid'),'user/'||(v->>'uid')))
    OR v->>'startedAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    OR to_char(to_timestamp((v->>'startSec')::double precision) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'.'||lpad(floor((v->>'startUsec')::numeric/1000)::text,3,'0')||'Z' IS DISTINCT FROM v->>'startedAt'
    OR jsonb_typeof(v->'knownDescendantPids') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'knownDescendantPids')>4096 THEN RETURN false; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(v->'knownDescendantPids') LOOP
    IF jsonb_typeof(child) IS DISTINCT FROM 'number' OR child::text !~ '^[1-9][0-9]*$' OR child::text::numeric NOT BETWEEN 2 AND 9007199254740991 OR child=v->'pid' THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(v->'knownDescendantPids'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boundary_launchd_exit_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text;
BEGIN
  IF NOT nmv_boundary_keys(v,ARRAY['identity','observedAt','method','mainPid','oldPidAbsent','serviceStopped','replacements','autoRestartBlocked','artifactHash','observedHostBootId','launchdDisabled','launchdUnloaded','oldPidESRCH','processGroupESRCH','allKnownDescendantsESRCH','replacementPids','ownedListeners'])
    OR v->>'method' IS DISTINCT FROM 'launchd_process_group_empty' OR NOT nmv_boundary_launchd_identity_valid(v->'identity')
    OR v->'observedHostBootId' IS DISTINCT FROM v->'identity'->'hostBootId' OR v->'mainPid' IS DISTINCT FROM '0'::jsonb
    OR v->'replacements' IS DISTINCT FROM '0'::jsonb OR v->'replacementPids' IS DISTINCT FROM '[]'::jsonb OR v->'ownedListeners' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['oldPidAbsent','serviceStopped','autoRestartBlocked','launchdDisabled','launchdUnloaded','oldPidESRCH','processGroupESRCH','allKnownDescendantsESRCH'] LOOP
    IF v->k IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(jsonb_typeof(v->'artifactHash')='string' AND v->>'artifactHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(v->'observedAt')='string' AND v->>'observedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    AND to_char((v->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=v->>'observedAt'
    AND v->>'observedAt'>=v->'identity'->>'startedAt',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
-- Retain original public OIDs: existing CHECK dependencies must call these additive validators.
CREATE OR REPLACE FUNCTION nmv_boundary_identity_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF v->>'kind'='launchd' THEN RETURN nmv_boundary_launchd_identity_valid(v); END IF;
  RETURN nmv_boundary_identity_valid_linux_0126(v);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_boundary_exit_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF v->'identity'->>'kind'='launchd' THEN RETURN nmv_boundary_launchd_exit_valid(v); END IF;
  IF v->>'method'='launchd_process_group_empty' THEN RETURN false; END IF;
  RETURN nmv_boundary_exit_valid_linux_0126(v);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF e->'plan'->'provider'->>'kind'='launchd' THEN RETURN nmv_provider_boundary_release_launchd_valid(e); END IF;
  RETURN nmv_provider_boundary_release_valid_linux_0126(e);
END $$;
