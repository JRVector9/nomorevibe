-- Preserve v1 physical contracts. v2 distinguishes durable original-owner facts from a fresh current-ingress stop.
CREATE FUNCTION nmv_boundary_original_owner_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE g jsonb; k text; ids bigint[]:=ARRAY[]::bigint[]; seqs bigint[]:=ARRAY[]::bigint[];
BEGIN
  IF NOT nmv_boundary_keys(v,ARRAY['kind','instanceId','bootId','openedEventId','groups','localEndEventId','localEndEvidenceHash','artifactHash'])
    OR v->>'kind' IS DISTINCT FROM 'durable_process_group_exit' OR jsonb_typeof(v->'instanceId') IS DISTINCT FROM 'string'
    OR char_length(v->>'instanceId') NOT BETWEEN 1 AND 120 OR v->>'instanceId'<>btrim(v->>'instanceId') OR v->>'instanceId' ~ '[[:cntrl:]]'
    OR jsonb_typeof(v->'bootId') IS DISTINCT FROM 'string' OR v->>'bootId' !~ '^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
    OR jsonb_typeof(v->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'groups') NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['openedEventId','localEndEventId'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' OR v->>k !~ '^[1-9][0-9]*$' OR (v->>k)::numeric>9007199254740991 THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['localEndEvidenceHash','artifactHash'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR v->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  ids:=ARRAY[(v->>'openedEventId')::bigint];
  FOR g IN SELECT value FROM jsonb_array_elements(v->'groups') LOOP
    IF NOT nmv_boundary_keys(g,ARRAY['seq','pid','runIdHash','spawnIntentEventId','spawnedEventId','exitEventId'])
      OR jsonb_typeof(g->'runIdHash') IS DISTINCT FROM 'string' OR g->>'runIdHash' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
    FOREACH k IN ARRAY ARRAY['seq','pid','spawnIntentEventId','spawnedEventId','exitEventId'] LOOP
      IF jsonb_typeof(g->k) IS DISTINCT FROM 'number' OR g->>k !~ '^[1-9][0-9]*$'
        OR (g->>k)::numeric>(CASE WHEN k IN ('seq','pid') THEN 2147483647 ELSE 9007199254740991 END) THEN RETURN false; END IF;
    END LOOP;
    IF (g->>'pid')::bigint<2 OR (g->>'seq')::bigint=ANY(seqs) THEN RETURN false; END IF;
    seqs:=seqs||(g->>'seq')::bigint;
    FOREACH k IN ARRAY ARRAY['spawnIntentEventId','spawnedEventId','exitEventId'] LOOP
      IF (g->>k)::bigint=ANY(ids) THEN RETURN false; END IF; ids:=ids||(g->>k)::bigint;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
-- Authoritative append-only records are read under the existing release transaction/trigger, not declared in JSON.
CREATE FUNCTION nmv_boundary_original_owner_records_valid(p jsonb,v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE o jsonb:=p->'originalOwner'; g jsonb; opened dr_process_group_events; intent dr_process_group_events; spawned dr_process_group_events; exited dr_process_group_events;
  ended model_capacity_events; dispatch_at timestamptz:=(v->>'dispatched_at')::timestamptz; possible bigint; intents bigint; maxseq bigint;
BEGIN
  IF NOT nmv_boundary_original_owner_valid(o) OR o->>'instanceId' IS DISTINCT FROM v->>'owner_instance_id'
    OR o->>'bootId' IS DISTINCT FROM v->>'owner_boot_id' OR dispatch_at IS NULL THEN RETURN false; END IF;
  SELECT * INTO opened FROM dr_process_group_events WHERE id=(o->>'openedEventId')::bigint;
  IF NOT FOUND OR opened.kind<>'owner_opened' OR opened.seq<>0 OR opened.owner_instance_id<>o->>'instanceId'
    OR opened.owner_boot_id::text<>o->>'bootId' OR opened.recorded_at>=dispatch_at THEN RETURN false; END IF;
  SELECT count(*),max(seq),count(*) FILTER(WHERE recorded_at<=dispatch_at) INTO intents,maxseq,possible FROM dr_process_group_events
    WHERE owner_instance_id=o->>'instanceId' AND owner_boot_id=(o->>'bootId')::uuid AND kind='spawn_intent';
  IF intents<>maxseq OR possible<>jsonb_array_length(o->'groups') THEN RETURN false; END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(o->'groups') LOOP
    SELECT * INTO intent FROM dr_process_group_events WHERE id=(g->>'spawnIntentEventId')::bigint;
    IF NOT FOUND OR intent.kind<>'spawn_intent' OR intent.owner_instance_id<>o->>'instanceId' OR intent.owner_boot_id::text<>o->>'bootId'
      OR intent.seq<>(g->>'seq')::integer OR intent.recorded_at>dispatch_at
      OR encode(sha256(convert_to(intent.run_id::text,'UTF8')),'hex') IS DISTINCT FROM g->>'runIdHash' THEN RETURN false; END IF;
    SELECT * INTO spawned FROM dr_process_group_events WHERE id=(g->>'spawnedEventId')::bigint;
    IF NOT FOUND OR spawned.kind<>'spawned' OR spawned.owner_instance_id<>intent.owner_instance_id OR spawned.owner_boot_id<>intent.owner_boot_id
      OR spawned.seq<>intent.seq OR spawned.run_id IS DISTINCT FROM intent.run_id OR spawned.pid<>(g->>'pid')::integer THEN RETURN false; END IF;
    SELECT * INTO exited FROM dr_process_group_events WHERE id=(g->>'exitEventId')::bigint;
    IF NOT FOUND OR exited.kind<>'group_exited' OR exited.owner_instance_id<>intent.owner_instance_id OR exited.owner_boot_id<>intent.owner_boot_id
      OR exited.seq<>intent.seq OR exited.run_id IS DISTINCT FROM intent.run_id OR exited.pid IS DISTINCT FROM spawned.pid
      OR exited.method IS DISTINCT FROM 'pgid_esrch_after_sigkill' OR exited.recorded_at<dispatch_at
      OR spawned.recorded_at<intent.recorded_at OR exited.recorded_at<spawned.recorded_at OR exited.recorded_at>(p->>'createdAt')::timestamptz THEN RETURN false; END IF;
  END LOOP;
  SELECT * INTO ended FROM model_capacity_events WHERE id=(o->>'localEndEventId')::bigint;
  RETURN coalesce(FOUND AND ended.request_id::text=v->>'request_id' AND ended.kind='dispatch_local_ended'
    AND ended.from_state='indeterminate' AND ended.to_state='indeterminate' AND ended.created_at>=dispatch_at AND ended.created_at<=(p->>'createdAt')::timestamptz
    AND ended.epoch::text=v->>'epoch' AND ended.revision::text=v->>'revision' AND ended.policy_hash=v->>'policy_hash'
    AND nmv_boundary_keys(ended.evidence,ARRAY['version','kind','requestId','owner','bindingHash','dispatches','terminals'])
    AND ended.evidence->'version'='1'::jsonb AND ended.evidence->>'kind'='gateway_local_end'
    AND ended.evidence->>'requestId'=v->>'request_id' AND ended.evidence->'owner'=p->'request'->'owner'
    AND ended.evidence->>'bindingHash'=v->>'dispatch_binding_hash' AND jsonb_typeof(ended.evidence->'dispatches')='number'
    AND ended.evidence->>'dispatches' ~ '^[1-9][0-9]*$' AND (ended.evidence->>'dispatches')::numeric<=4096
    AND ended.evidence->'dispatches'=ended.evidence->'terminals'
    AND encode(sha256(convert_to(ended.evidence::text,'UTF8')),'hex')=o->>'localEndEvidenceHash',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text; replacement text; part text[];
BEGIN
  -- Save exact existing public bodies, preserving their original source and public OIDs.
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['nmv_provider_boundary_release_valid','nmv_provider_boundary_release_v1_0128'],
    ARRAY['nmv_provider_boundary_transition_guard','nmv_provider_boundary_transition_guard_v1_0128']]
  LOOP
    definition:=pg_get_functiondef(('public.'||part[1]||CASE WHEN part[1]='nmv_provider_boundary_transition_guard' THEN '()' ELSE '(jsonb)' END)::regprocedure);
    EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.'||part[1]||'\(','CREATE FUNCTION public.'||part[2]||'(');
  END LOOP;
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_launchd_valid(jsonb)'::regprocedure);
  -- Copy the whole strict physical validator; change only explicit v2 fields and the separate ingress birth bound.
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''owner'',''gateways'',''provider'',''beforeArtifactHash'']','ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''originalOwner'',''currentIngressOwner'',''gateways'',''provider'',''beforeArtifactHash'']'],
    ARRAY['ARRAY[''version'',''kind'',''planHash'',''owner'',''gateways'',''provider'']','ARRAY[''version'',''kind'',''planHash'',''originalOwnerProofHash'',''currentIngressOwner'',''gateways'',''provider'']'],
    ARRAY['p->''version'' IS DISTINCT FROM ''1''::jsonb','p->''version'' IS DISTINCT FROM ''2''::jsonb'],
    ARRAY['r->''version'' IS DISTINCT FROM ''1''::jsonb','r->''version'' IS DISTINCT FROM ''2''::jsonb'],
    ARRAY['p->''owner''','p->''currentIngressOwner'''],ARRAY['r->''owner''','r->''currentIngressOwner'''],
    ARRAY['v->>''startedAt''>q->>''dispatchAt''','v->>''startedAt''>(CASE WHEN i=0 THEN p->>''createdAt'' ELSE q->>''dispatchAt'' END)']]
  LOOP
    IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'historical_boundary_predecessor_changed'; END IF;
    definition:=replace(definition,part[1],part[2]);
  END LOOP;
  needle:='BEGIN'||chr(10);
  replacement:=needle||'  IF NOT nmv_boundary_original_owner_valid(p->''originalOwner'') OR p->''originalOwner''->>''instanceId'' IS DISTINCT FROM q->''owner''->>''instanceId'' OR p->''originalOwner''->>''bootId'' IS DISTINCT FROM q->''owner''->>''bootId'' OR r->>''originalOwnerProofHash'' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p->''originalOwner''),''UTF8'')),''hex'') THEN RETURN false; END IF;'||chr(10);
  definition:=replace(definition,needle,replacement);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_launchd_valid\(','CREATE FUNCTION public.nmv_provider_boundary_release_v2_valid(');

  definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);
  needle:='  RETURN NEW;'||chr(10)||'END';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'historical_boundary_trigger_changed'; END IF;
  replacement:='  IF NEW.terminal_evidence->''plan''->''version''=''2''::jsonb AND NOT nmv_boundary_original_owner_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boundary_original_owner_records_mismatch''; END IF;'||chr(10)||needle;
  EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF e->'plan'->'version'='2'::jsonb THEN RETURN nmv_provider_boundary_release_v2_valid(e); END IF;
  RETURN nmv_provider_boundary_release_v1_0128(e);
END $$;
