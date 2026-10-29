-- Manual, complete physical service-scope proof. This never treats generation replacement or TTL as exit.
CREATE FUNCTION nmv_complete_m3_provider_scope_valid(p jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE s jsonb:=p->'scope'; t jsonb:=r->'scope'; k text; v jsonb;
BEGIN
  IF NOT nmv_boundary_keys(s,ARRAY['kind','sourceRoot','originalObservedAt','originalSourceHash','currentSourceHash','originalArtifactHash','currentArtifactHash','topologyArtifactHash','gatewayServiceIds'])
    OR NOT nmv_boundary_keys(t,ARRAY['kind','sourceRoot','sourceHash','gatewayServiceIds','gatewayIncarnationsEmpty','providerIncarnationsEmpty','artifactHash'])
    OR s->>'kind' IS DISTINCT FROM 'complete_launchd_and_swarm_scope' OR t->>'kind' IS DISTINCT FROM 'complete_provider_scope_exit'
    OR s->>'sourceRoot' IS DISTINCT FROM '/Users/jr/deepseek-serve' OR t->'sourceRoot' IS DISTINCT FROM s->'sourceRoot'
    OR p->'request'->>'groupId' IS DISTINCT FROM 'm3-mlx' OR p->'request'->>'providerBudgetId' IS DISTINCT FROM 'abcllm-m3-mlx'
    OR p->'provider'->>'host' IS DISTINCT FROM 'm3-macos' OR p->'provider'->>'kind' IS DISTINCT FROM 'launchd'
    OR p->'provider'->>'service' IS DISTINCT FROM 'gui/501/com.jr.deepseek' OR p->'provider'->'uid' IS DISTINCT FROM '501'::jsonb
    OR s->'originalSourceHash' IS DISTINCT FROM s->'currentSourceHash' OR t->'sourceHash' IS DISTINCT FROM s->'currentSourceHash'
    OR s->'topologyArtifactHash' IS DISTINCT FROM p->'provider'->'topologyProofSha256'
    OR t->'gatewayIncarnationsEmpty' IS DISTINCT FROM '[true,true]'::jsonb OR t->'providerIncarnationsEmpty' IS DISTINCT FROM 'true'::jsonb
    OR t->'gatewayServiceIds' IS DISTINCT FROM s->'gatewayServiceIds' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['originalSourceHash','currentSourceHash','originalArtifactHash','currentArtifactHash','topologyArtifactHash'] LOOP
    IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR s->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(t->'artifactHash') IS DISTINCT FROM 'string' OR t->>'artifactHash' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(s->'gatewayServiceIds') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'gatewayServiceIds')<>2
    OR s->'gatewayServiceIds'->0=s->'gatewayServiceIds'->1 THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'gatewayServiceIds') LOOP
    IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR char_length(v#>>'{}') NOT BETWEEN 1 AND 200
      OR v#>>'{}'<>btrim(v#>>'{}') OR v#>>'{}' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(s->>'originalObservedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    AND to_char((s->>'originalObservedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=s->>'originalObservedAt'
    AND s->>'originalObservedAt'<p->'request'->>'dispatchAt',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text; part text[];
BEGIN
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_v2_launchd_0132(jsonb)'::regprocedure);
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['p->''version'' IS DISTINCT FROM ''2''::jsonb','p->''version'' IS DISTINCT FROM ''6''::jsonb'],
    ARRAY['r->''version'' IS DISTINCT FROM ''2''::jsonb','r->''version'' IS DISTINCT FROM ''6''::jsonb'],
    ARRAY['''provider'',''beforeArtifactHash'']','''provider'',''beforeArtifactHash'',''scope'']'],
    ARRAY['''currentIngressOwner'',''gateways'',''provider'']','''currentIngressOwner'',''gateways'',''provider'',''scope'']'],
    ARRAY['(CASE WHEN i=0 THEN p->>''createdAt'' ELSE q->>''dispatchAt'' END)','p->>''createdAt''']]
  LOOP
    IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'complete_scope_predecessor_changed'; END IF;
    definition:=replace(definition,part[1],part[2]);
  END LOOP;
  needle:='BEGIN'||chr(10);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'complete_scope_predecessor_changed'; END IF;
  definition:=replace(definition,needle,needle||'  IF NOT nmv_complete_m3_provider_scope_valid(p,r) THEN RETURN false; END IF;'||chr(10));
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_v2_launchd_0132\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_v6_valid(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_valid(jsonb)'::regprocedure);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_valid\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_pre_0141(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);needle:='  RETURN NEW;'||chr(10)||'END';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'complete_scope_trigger_changed'; END IF;
  EXECUTE replace(definition,needle,'  IF NEW.terminal_evidence->''plan''->''version''=''6''::jsonb AND NOT nmv_boundary_original_owner_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boundary_original_owner_records_mismatch''; END IF;'||chr(10)||needle);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF e->'plan'->'version'='6'::jsonb THEN RETURN nmv_provider_boundary_release_v6_valid(e); END IF;
  RETURN nmv_provider_boundary_release_pre_0141(e);
END $$;
