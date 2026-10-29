-- Separate, manual proof for an already-ended vLLM invocation. Never TTL/health-based release.
-- Preserve every predecessor CHECK and all v1-v4 predicates.
CREATE FUNCTION nmv_systemd_invocation_boundary_valid(p jsonb,r jsonb,q jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE v jsonb:=p->'provider'; c jsonb:=r->'provider'; k text;
BEGIN
  IF NOT nmv_boundary_keys(v,ARRAY['kind','host','hostBootId','service','serviceRevision','incarnationId','startedAt','endedAt','currentInvocationId','currentStartedAt','killMode','sendSIGKILL','delegate','journalArtifactHash','configurationArtifactHash'])
    OR NOT nmv_boundary_keys(c,ARRAY['identity','observedAt','method','oldInvocationInactive','currentConfigurationUnchanged','currentCgroupContainsOnlyCurrentInvocation','artifactHash'])
    OR c->'identity' IS DISTINCT FROM v OR v->>'kind' IS DISTINCT FROM 'systemd_invocation_exit'
    OR q->>'groupId' IS DISTINCT FROM 'supa' OR q->>'providerBudgetId' IS DISTINCT FROM 'abcllm-supa' OR v->>'host' IS DISTINCT FROM 'supa'
    OR v->>'service' IS DISTINCT FROM 'vllm.service' OR v->>'killMode' IS DISTINCT FROM 'control-group'
    OR v->'sendSIGKILL' IS DISTINCT FROM 'true'::jsonb OR v->'delegate' IS DISTINCT FROM 'false'::jsonb
    OR c->>'method' IS DISTINCT FROM 'systemd_journal_invocation_end'
    OR c->'oldInvocationInactive' IS DISTINCT FROM 'true'::jsonb OR c->'currentConfigurationUnchanged' IS DISTINCT FROM 'true'::jsonb
    OR c->'currentCgroupContainsOnlyCurrentInvocation' IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(v->'host') IS DISTINCT FROM 'string' OR char_length(v->>'host') NOT BETWEEN 1 AND 120
    OR v->>'host'<>btrim(v->>'host') OR v->>'host' ~ '[[:cntrl:]]'
    OR jsonb_typeof(v->'hostBootId') IS DISTINCT FROM 'string' OR v->>'hostBootId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['serviceRevision','journalArtifactHash','configurationArtifactHash'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR v->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['incarnationId','currentInvocationId'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR v->>k !~ '^[a-f0-9]{32}$' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['startedAt','endedAt','currentStartedAt'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR v->>k !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
      OR to_char((v->>k)::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v->>k THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(v->>'incarnationId'<>v->>'currentInvocationId' AND v->>'startedAt'<=q->>'dispatchAt'
    AND q->>'dispatchAt'<v->>'endedAt' AND v->>'endedAt'<v->>'currentStartedAt' AND v->>'currentStartedAt'<=p->>'createdAt'
    AND c->>'artifactHash' ~ '^[a-f0-9]{64}$' AND c->>'observedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    AND to_char((c->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=c->>'observedAt',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text; part text[];
BEGIN
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_v2_systemd_valid(jsonb)'::regprocedure);
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['p->''version'' IS DISTINCT FROM ''2''::jsonb','p->''version'' IS DISTINCT FROM ''5''::jsonb'],
    ARRAY['r->''version'' IS DISTINCT FROM ''2''::jsonb','r->''version'' IS DISTINCT FROM ''5''::jsonb'],
    ARRAY['p->''provider''->>''kind'' IS DISTINCT FROM ''systemd''','p->''provider''->>''kind'' IS DISTINCT FROM ''systemd_invocation_exit''']]
  LOOP
    IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'invocation_boundary_predecessor_changed'; END IF;
    definition:=replace(definition,part[1],part[2]);
  END LOOP;
  needle:='    IF NOT nmv_boundary_identity_valid_linux_0126(v) OR NOT nmv_boundary_exit_valid_linux_0126(c) OR c->''identity'' IS DISTINCT FROM v';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'invocation_boundary_predecessor_changed'; END IF;
  definition:=replace(definition,needle,'    IF i=3 THEN IF NOT nmv_systemd_invocation_boundary_valid(p,r,q) THEN RETURN false; END IF; CONTINUE; END IF;'||chr(10)||needle);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_v2_systemd_valid\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_v5_valid(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_valid(jsonb)'::regprocedure);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_valid\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_pre_0140(');
  definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);
  needle:='  RETURN NEW;'||chr(10)||'END';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'invocation_boundary_trigger_changed'; END IF;
  EXECUTE replace(definition,needle,'  IF NEW.terminal_evidence->''plan''->''version''=''5''::jsonb AND NOT nmv_boundary_original_owner_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boundary_original_owner_records_mismatch''; END IF;'||chr(10)||needle);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF e->'plan'->'version'='5'::jsonb THEN RETURN nmv_provider_boundary_release_v5_valid(e); END IF;
  RETURN nmv_provider_boundary_release_pre_0140(e);
END $$;
