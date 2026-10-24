-- Operator observations are a privileged trust boundary, never native terminal/usage authority.
-- All predecessor CHECKs are preserved whole. The extra branch additionally rechecks the predecessor binding under indeterminate state.
CREATE FUNCTION nmv_boundary_keys(v jsonb, keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(v)='object' AND v ?& keys AND v-keys='{}'::jsonb,false)
$$;
--> statement-breakpoint
CREATE FUNCTION nmv_boundary_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF jsonb_typeof(v)='object' THEN RETURN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||nmv_boundary_canonical(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(v)),'')||'}'; END IF;
  IF jsonb_typeof(v)='array' THEN RETURN '['||coalesce((SELECT string_agg(nmv_boundary_canonical(value),',' ORDER BY ord) FROM jsonb_array_elements(v) WITH ORDINALITY x(value,ord)),'')||']'; END IF;
  RETURN v::text;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boundary_identity_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text;
BEGIN
  IF NOT nmv_boundary_keys(v,ARRAY['host','hostBootId','kind','service','serviceRevision','incarnationId','startedAt','pid','startTicks','pidNamespace','cgroup']) THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['host','service','serviceRevision','incarnationId','cgroup'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'string' OR char_length(v->>k) NOT BETWEEN 1 AND (CASE WHEN k='cgroup' THEN 500 WHEN k='host' THEN 120 ELSE 200 END)
      OR v->>k<>btrim(v->>k) OR v->>k ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(v->>'hostBootId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND v->>'kind' IN ('container','systemd') AND v->>'startedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    AND to_char((v->>'startedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=v->>'startedAt'
    AND jsonb_typeof(v->'pid')='number' AND v->>'pid' ~ '^[1-9][0-9]*$' AND (v->>'pid')::numeric BETWEEN 2 AND 9007199254740991
    AND jsonb_typeof(v->'startTicks')='string' AND v->>'startTicks' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(v->'pidNamespace')='string' AND v->>'pidNamespace' ~ '^[1-9][0-9]*$',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boundary_exit_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE keys text[]:=ARRAY['identity','observedAt','method','mainPid','oldPidAbsent','serviceStopped','replacements','autoRestartBlocked','artifactHash']; method text:=v->>'method';
BEGIN
  IF method IN ('container_and_cgroup_empty','systemd_and_cgroup_empty') THEN
    keys:=keys||ARRAY['cgroupPopulated','cgroupPids'];
    IF v->'cgroupPopulated' IS DISTINCT FROM 'false'::jsonb OR v->'cgroupPids' IS DISTINCT FROM '[]'::jsonb
      OR (v->'identity'->>'kind'='container') IS DISTINCT FROM (method='container_and_cgroup_empty') THEN RETURN false; END IF;
  ELSIF method='private_pid_namespace_end' THEN
    keys:=keys||ARRAY['pidMode','initPid','initNamespace','selfNamespace','waitExitCode','containerStatus','running'];
    IF v->'identity'->>'kind' IS DISTINCT FROM 'container' OR jsonb_typeof(v->'pidMode') IS DISTINCT FROM 'string' OR coalesce(v->>'pidMode' NOT IN ('','private'),true)
      OR v->'initPid' IS DISTINCT FROM '1'::jsonb OR v->'initNamespace' IS DISTINCT FROM v->'identity'->'pidNamespace'
      OR v->'selfNamespace' IS DISTINCT FROM v->'identity'->'pidNamespace' OR jsonb_typeof(v->'containerStatus') IS DISTINCT FROM 'string' OR coalesce(v->>'containerStatus' NOT IN ('exited','removed'),true)
      OR v->'running' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(v->'waitExitCode') IS DISTINCT FROM 'number'
      OR v->>'waitExitCode' !~ '^[0-9]+$' OR (v->>'waitExitCode')::numeric NOT BETWEEN 0 AND 255 THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  RETURN coalesce(nmv_boundary_keys(v,keys) AND nmv_boundary_identity_valid(v->'identity') AND v->'mainPid'='0'::jsonb
    AND v->'oldPidAbsent'='true'::jsonb AND v->'serviceStopped'='true'::jsonb AND v->'replacements'='0'::jsonb AND v->'autoRestartBlocked'='true'::jsonb
    AND jsonb_typeof(v->'artifactHash')='string' AND v->>'artifactHash' ~ '^[a-f0-9]{64}$'
    AND v->>'observedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    AND to_char((v->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=v->>'observedAt'
    AND v->>'observedAt'>=v->'identity'->>'startedAt',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE p jsonb:=e->'plan'; r jsonb:=e->'receipt'; q jsonb:=p->'request'; c jsonb:=p->'control'; v jsonb; k text; i integer;
BEGIN
  IF NOT nmv_boundary_keys(e,ARRAY['version','kind','requestId','owner','fromState','dispatchAt','bindingHash','notBefore','evaluatedAt','operator','reference','plan','receipt'])
    OR e->'version' IS DISTINCT FROM '1'::jsonb OR e->>'kind' IS DISTINCT FROM 'provider_boundary_exit' OR e->>'fromState' IS DISTINCT FROM 'indeterminate'
    OR NOT nmv_boundary_keys(p,ARRAY['version','kind','createdAt','request','control','owner','gateways','provider','beforeArtifactHash'])
    OR p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'kind' IS DISTINCT FROM 'provider_boundary_plan'
    OR NOT nmv_boundary_keys(q,ARRAY['requestId','owner','state','tokenHash','epoch','revision','policyHash','bindingHash','dispatchAt','providerBudgetId','groupId','servingContractHash'])
    OR q->>'state' IS DISTINCT FROM 'indeterminate' OR NOT nmv_boundary_keys(c,ARRAY['mode','epoch','revision','policyHash','updatedAt']) OR c->>'mode' IS DISTINCT FROM 'draining'
    OR NOT nmv_boundary_keys(r,ARRAY['version','kind','planHash','owner','gateways','provider']) OR r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'kind' IS DISTINCT FROM 'provider_boundary_receipt'
    OR NOT nmv_boundary_keys(q->'owner',ARRAY['instanceId','bootId']) OR e->'owner' IS DISTINCT FROM q->'owner'
    OR e->'requestId' IS DISTINCT FROM q->'requestId' OR e->'dispatchAt' IS DISTINCT FROM q->'dispatchAt'
    OR e->'bindingHash' IS DISTINCT FROM q->'bindingHash' OR e->'notBefore' IS DISTINCT FROM r->'provider'->'observedAt' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['operator','reference'] LOOP
    IF jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR char_length(e->>k) NOT BETWEEN 1 AND (CASE WHEN k='operator' THEN 120 ELSE 400 END)
      OR e->>k<>btrim(e->>k) OR e->>k ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['instanceId','bootId'] LOOP IF jsonb_typeof(q->'owner'->k) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
  IF q->>'requestId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR q->'owner'->>'bootId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR char_length(q->'owner'->>'instanceId') NOT BETWEEN 1 AND 120 OR q->'owner'->>'instanceId'<>btrim(q->'owner'->>'instanceId') OR q->'owner'->>'instanceId' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  FOREACH v IN ARRAY ARRAY[q,c] LOOP
    FOREACH k IN ARRAY ARRAY['epoch','revision'] LOOP IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' OR v->>k !~ '^[1-9][0-9]*$' OR (v->>k)::numeric>9007199254740991 THEN RETURN false; END IF; END LOOP;
    IF jsonb_typeof(v->'policyHash') IS DISTINCT FROM 'string' OR v->>'policyHash' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['tokenHash','bindingHash','servingContractHash'] LOOP IF jsonb_typeof(q->k) IS DISTINCT FROM 'string' OR q->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF; END LOOP;
  FOREACH k IN ARRAY ARRAY['providerBudgetId','groupId'] LOOP IF jsonb_typeof(q->k) IS DISTINCT FROM 'string' OR char_length(q->>k) NOT BETWEEN 1 AND 120 OR q->>k<>btrim(q->>k) OR q->>k ~ '[[:cntrl:]]' THEN RETURN false; END IF; END LOOP;
  IF jsonb_typeof(p->'beforeArtifactHash') IS DISTINCT FROM 'string' OR p->>'beforeArtifactHash' !~ '^[a-f0-9]{64}$'
    OR r->>'planHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p),'UTF8')),'hex')
    OR jsonb_typeof(p->'gateways') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'gateways')<>2
    OR jsonb_typeof(r->'gateways') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'gateways')<>2
    OR p->'owner'->>'kind' IS DISTINCT FROM 'container' OR p->'provider'->>'kind' IS DISTINCT FROM 'systemd'
    OR p->'gateways'->0->>'host'=p->'gateways'->1->>'host' THEN RETURN false; END IF;
  FOR i IN 0..3 LOOP
    v:=CASE i WHEN 0 THEN p->'owner' WHEN 3 THEN p->'provider' ELSE p->'gateways'->(i-1) END;
    c:=CASE i WHEN 0 THEN r->'owner' WHEN 3 THEN r->'provider' ELSE r->'gateways'->(i-1) END;
    IF NOT nmv_boundary_identity_valid(v) OR NOT nmv_boundary_exit_valid(c) OR c->'identity' IS DISTINCT FROM v
      OR v->>'startedAt'>q->>'dispatchAt' OR i IN (1,2) AND v->>'kind'<>'container' THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'host'||':'||(x->>'incarnationId')) FROM jsonb_array_elements(jsonb_build_array(p->'owner',p->'gateways'->0,p->'gateways'->1,p->'provider')) x)<>4 THEN RETURN false; END IF;
  FOREACH v IN ARRAY ARRAY[jsonb_build_object('at',q->'dispatchAt'),jsonb_build_object('at',p->'createdAt'),jsonb_build_object('at',e->'evaluatedAt')] LOOP
    IF v->>'at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' OR to_char((v->>'at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v->>'at' THEN RETURN false; END IF;
  END LOOP;
  IF p->'control'->>'updatedAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$' OR to_char((p->'control'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>p->'control'->>'updatedAt' THEN RETURN false; END IF;
  RETURN coalesce(p->>'createdAt'>=q->>'dispatchAt' AND p->'control'->>'updatedAt'<=p->>'createdAt' AND r->'owner'->>'observedAt'>=p->>'createdAt'
    AND r->'gateways'->0->>'observedAt'>=r->'owner'->>'observedAt' AND r->'gateways'->1->>'observedAt'>=r->'owner'->>'observedAt'
    AND r->'provider'->>'observedAt'>=r->'gateways'->0->>'observedAt' AND r->'provider'->>'observedAt'>=r->'gateways'->1->>'observedAt'
    AND e->>'evaluatedAt'>=r->'provider'->>'observedAt' AND (e->>'evaluatedAt')::timestamptz-(r->'provider'->>'observedAt')::timestamptz<=interval '5 minutes'
    AND (e->>'evaluatedAt')::timestamptz-(p->>'createdAt')::timestamptz<=interval '30 minutes',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
-- Save the exact 0125 predecessor predicates before widening any CHECK. No binding rule is reconstructed or omitted.
DO $$
DECLARE predicates text;
BEGIN
  SELECT string_agg('('||substring(pg_get_constraintdef(oid) FROM 7)||')',' AND ' ORDER BY conname) INTO predicates FROM pg_constraint
    WHERE conrelid='model_capacity_requests'::regclass AND conname IN ('model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check');
  IF predicates IS NULL OR (SELECT count(*) FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname IN ('model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check'))<>3 THEN RAISE EXCEPTION 'provider_boundary_predecessor_missing'; END IF;
  EXECUTE 'CREATE FUNCTION nmv_boundary_predecessor_binding_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT coalesce(('||predicates||'),false) FROM jsonb_populate_record(NULL::model_capacity_requests,v||''{"state":"indeterminate","terminal_evidence":null,"terminal_evidence_hash":null,"settled_at":null}''::jsonb) r $fn$';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_provider_boundary_request_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(v->>'state'='withdrawn' AND v->'settled_at'='null'::jsonb AND nmv_provider_boundary_release_valid(v->'terminal_evidence')
   AND v->>'terminal_evidence_hash'=encode(sha256(convert_to(nmv_boundary_canonical(v->'terminal_evidence'),'UTF8')),'hex') AND nmv_boundary_predecessor_binding_valid(v)
   AND v->'terminal_evidence'->>'requestId'=v->>'request_id' AND v->'terminal_evidence'->'owner'->>'instanceId'=v->>'owner_instance_id'
   AND v->'terminal_evidence'->'owner'->>'bootId'=v->>'owner_boot_id' AND v->'terminal_evidence'->>'bindingHash'=v->>'dispatch_binding_hash'
   AND (v->'terminal_evidence'->>'dispatchAt')::timestamptz=(v->>'dispatched_at')::timestamptz
   AND v->'terminal_evidence'->'plan'->'request'->'epoch'=v->'epoch' AND v->'terminal_evidence'->'plan'->'request'->'revision'=v->'revision'
   AND v->'terminal_evidence'->'plan'->'request'->>'policyHash'=v->>'policy_hash'
   AND v->'terminal_evidence'->'plan'->'request'->>'providerBudgetId'=v->>'provider_budget_id'
   AND v->'terminal_evidence'->'plan'->'request'->>'groupId'=v->>'group_id'
   AND v->'terminal_evidence'->'plan'->'request'->>'servingContractHash'=v->'dispatch_binding'->>'servingContractHash'
   AND v->'terminal_evidence'->'plan'->'request'->>'tokenHash'=encode(sha256(convert_to(v->>'token','UTF8')),'hex'),false)
$$;
--> statement-breakpoint
DO $$
DECLARE n text; old_predicate text;
BEGIN
  FOREACH n IN ARRAY ARRAY['model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check'] LOOP
    SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname=n;
    EXECUTE format('ALTER TABLE model_capacity_requests DROP CONSTRAINT %I',n);
    EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT %I CHECK ((%s) OR nmv_provider_boundary_request_valid(to_jsonb(model_capacity_requests)))',n,old_predicate);
  END LOOP;
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_events'::regclass AND conname='model_capacity_events_kind_check';
  ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_kind_check;
  EXECUTE 'ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK (('||old_predicate||') OR coalesce(kind=''dispatch_released'' AND from_state=''indeterminate'' AND to_state=''withdrawn'' AND reason IS NULL AND nmv_provider_boundary_release_valid(evidence) AND evidence->>''requestId''=request_id::text AND evidence->''plan''->''request''->''epoch''=to_jsonb(epoch) AND evidence->''plan''->''request''->''revision''=to_jsonb(revision) AND evidence->''plan''->''request''->>''policyHash''=policy_hash,false))';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_provider_boundary_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c model_capacity_control; f dr_writer_fence; observed_now timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND OLD.terminal_evidence->>'kind'='provider_boundary_exit' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'provider_boundary_terminal_immutable';
  END IF;
  IF NEW.terminal_evidence->>'kind' IS DISTINCT FROM 'provider_boundary_exit' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'provider_boundary_transition_invalid'; END IF;
  IF OLD.terminal_evidence=NEW.terminal_evidence AND OLD.state='withdrawn' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  SELECT * INTO STRICT f FROM dr_writer_fence WHERE id=1 FOR SHARE;
  SELECT * INTO STRICT c FROM model_capacity_control WHERE id=1 FOR UPDATE;
  observed_now:=clock_timestamp();
  IF f.state<>'active' OR c.mode<>'draining' OR OLD.state<>'indeterminate' OR NEW.state<>'withdrawn'
    OR (to_jsonb(OLD)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at'])
    OR NEW.terminal_evidence->'plan'->'control' IS DISTINCT FROM jsonb_build_object('mode',c.mode,'epoch',c.epoch,'revision',c.revision,'policyHash',c.policy_hash,'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    OR (NEW.terminal_evidence->>'evaluatedAt')::timestamptz NOT BETWEEN observed_now-interval '30 seconds' AND observed_now
    OR (NEW.terminal_evidence->'receipt'->'provider'->>'observedAt')::timestamptz NOT BETWEEN observed_now-interval '5 minutes' AND observed_now
    OR (NEW.terminal_evidence->'plan'->>'createdAt')::timestamptz NOT BETWEEN observed_now-interval '30 minutes' AND observed_now
    THEN RAISE EXCEPTION 'provider_boundary_transition_conflict'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_capacity_provider_boundary_guard BEFORE INSERT OR UPDATE ON model_capacity_requests
 FOR EACH ROW EXECUTE FUNCTION nmv_provider_boundary_transition_guard();
