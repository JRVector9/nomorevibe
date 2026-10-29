-- Old M1 native process and relay generation are proved ended; a different live native incarnation is preserved.
CREATE FUNCTION nmv_complete_m1_gateway_scope_valid(p jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE s jsonb:=p->'scope';t jsonb:=r->'scope';n jsonb:=s->'currentNative';o jsonb:=p->'provider';v jsonb;
BEGIN
 IF NOT nmv_boundary_keys(s,ARRAY['kind','gatewayServiceIds','relayService','relayProofArtifactHash','currentNative'])
  OR NOT nmv_boundary_keys(t,ARRAY['kind','gatewayServiceIds','gatewayIncarnationsEmpty','relayOriginalExited','relayProofArtifactHash','currentNative','artifactHash'])
  OR s->>'kind' IS DISTINCT FROM 'historical_m1_native_and_relay_exit' OR t->'kind' IS DISTINCT FROM s->'kind'
  OR s->>'relayService' IS DISTINCT FROM 'system/bot.brut.nmv-llm-relay'
  OR s->'relayProofArtifactHash' IS DISTINCT FROM t->'relayProofArtifactHash'
  OR jsonb_typeof(s->'relayProofArtifactHash') IS DISTINCT FROM 'string' OR s->>'relayProofArtifactHash' !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(t->'artifactHash') IS DISTINCT FROM 'string' OR t->>'artifactHash' !~ '^[a-f0-9]{64}$'
  OR t->'gatewayIncarnationsEmpty' IS DISTINCT FROM '[true,true]'::jsonb OR t->'relayOriginalExited' IS DISTINCT FROM 'true'::jsonb
  OR t->'gatewayServiceIds' IS DISTINCT FROM s->'gatewayServiceIds' OR t->'currentNative' IS DISTINCT FROM n
  OR p->'request'->>'groupId' IS DISTINCT FROM 'm1-qwen' OR p->'request'->>'providerBudgetId' IS DISTINCT FROM 'abcllm-m1-qwen'
  OR NOT nmv_boundary_identity_valid(n) OR n->>'kind' IS DISTINCT FROM 'launchd'
  OR n->>'host' IS DISTINCT FROM 'm1-macos' OR n->>'service' IS DISTINCT FROM 'gui/501/com.jinwooro.qwen-api' OR n->'uid' IS DISTINCT FROM '501'::jsonb
  OR o->>'host' IS DISTINCT FROM 'm1-macos' OR o->>'service' IS DISTINCT FROM 'gui/501/com.jinwooro.qwen-api' OR o->'uid' IS DISTINCT FROM '501'::jsonb
  OR n->'hostBootId' IS DISTINCT FROM o->'hostBootId' OR n->'pid' IS NOT DISTINCT FROM o->'pid' OR n->'incarnationId' IS NOT DISTINCT FROM o->'incarnationId'
  OR n->'plistSha256' IS DISTINCT FROM o->'plistSha256' OR n->'entrySha256' IS DISTINCT FROM o->'entrySha256'
  OR o->>'startedAt'>p->'request'->>'dispatchAt' OR n->>'startedAt'<=p->'request'->>'dispatchAt' OR n->>'startedAt'>p->>'createdAt' THEN RETURN false; END IF;
 IF jsonb_typeof(s->'gatewayServiceIds') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'gatewayServiceIds')<>2
  OR s->'gatewayServiceIds'->0=s->'gatewayServiceIds'->1 THEN RETURN false; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(s->'gatewayServiceIds') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR char_length(v#>>'{}') NOT BETWEEN 1 AND 200
   OR v#>>'{}'<>btrim(v#>>'{}') OR v#>>'{}' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_historical_m1_native_exit_valid(p jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE v jsonb:=p->'provider';c jsonb:=r->'provider';
BEGIN
 RETURN coalesce(nmv_boundary_identity_valid(v) AND v->>'kind'='launchd'
  AND nmv_boundary_keys(c,ARRAY['identity','observedAt','method','observedHostBootId','oldPidESRCH','processGroupESRCH','allKnownDescendantsESRCH','artifactHash'])
  AND c->'identity'=v AND c->>'method'='historical_launchd_process_group_exit' AND c->'observedHostBootId'=v->'hostBootId'
  AND c->'oldPidESRCH'='true'::jsonb AND c->'processGroupESRCH'='true'::jsonb AND c->'allKnownDescendantsESRCH'='true'::jsonb
  AND jsonb_typeof(c->'artifactHash')='string' AND c->>'artifactHash' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(c->'observedAt')='string' AND c->>'observedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
  AND to_char((c->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=c->>'observedAt',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text; part text[];
BEGIN
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_v2_launchd_0132(jsonb)'::regprocedure);
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['p->''version'' IS DISTINCT FROM ''2''::jsonb','p->''version'' IS DISTINCT FROM ''7''::jsonb'],
    ARRAY['r->''version'' IS DISTINCT FROM ''2''::jsonb','r->''version'' IS DISTINCT FROM ''7''::jsonb'],
    ARRAY['''provider'',''beforeArtifactHash'']','''provider'',''beforeArtifactHash'',''scope'']'],
    ARRAY['''currentIngressOwner'',''gateways'',''provider'']','''currentIngressOwner'',''gateways'',''provider'',''scope'']'],
    ARRAY['(CASE WHEN i=0 THEN p->>''createdAt'' ELSE q->>''dispatchAt'' END)','(CASE WHEN i=3 THEN q->>''dispatchAt'' ELSE p->>''createdAt'' END)']]
  LOOP
    IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'm1_scope_predecessor_changed'; END IF;
    definition:=replace(definition,part[1],part[2]);
  END LOOP;
  needle:='    IF NOT nmv_boundary_identity_valid(v) OR NOT nmv_boundary_exit_valid(c) OR c->''identity'' IS DISTINCT FROM v';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'm1_scope_predecessor_changed'; END IF;
  definition:=replace(definition,needle,'    IF i=3 THEN IF NOT nmv_historical_m1_native_exit_valid(p,r) THEN RETURN false; END IF; CONTINUE; END IF;'||chr(10)||needle);
  needle:='BEGIN'||chr(10);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'm1_scope_predecessor_changed'; END IF;
  definition:=replace(definition,needle,needle||'  IF NOT nmv_complete_m1_gateway_scope_valid(p,r) THEN RETURN false; END IF;'||chr(10));
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_v2_launchd_0132\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_v7_valid(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_valid(jsonb)'::regprocedure);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_valid\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_pre_0142(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);needle:='  RETURN NEW;'||chr(10)||'END';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'm1_scope_trigger_changed'; END IF;
  EXECUTE replace(definition,needle,'  IF NEW.terminal_evidence->''plan''->''version''=''7''::jsonb AND NOT nmv_boundary_original_owner_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boundary_original_owner_records_mismatch''; END IF;'||chr(10)||needle);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF e->'plan'->'version'='7'::jsonb THEN RETURN nmv_provider_boundary_release_v7_valid(e); END IF;
  RETURN nmv_provider_boundary_release_pre_0142(e);
END $$;
