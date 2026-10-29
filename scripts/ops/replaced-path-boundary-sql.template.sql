-- 0145 follows 0143 (replaced provider boundary). Every CHECK below is rebuilt from its live definition,
-- so the 0143 branch and its shared shape validator must already be installed.
DO $$
BEGIN
  IF to_regprocedure('public.nmv_replaced_provider_request_valid(jsonb)') IS NULL
    OR to_regprocedure('public.nmv_replaced_provider_shape_valid(jsonb,jsonb,integer)') IS NULL
    OR to_regprocedure('public.nmv_boundary_canonical(jsonb)') IS NULL
    THEN RAISE EXCEPTION 'replaced_path_predecessor_0143_missing'; END IF;
END $$;
--> statement-breakpoint
-- Topology authority, generated from lib/llm/replaced-path-boundary-contract.ts. A changed path needs a new migration.
CREATE FUNCTION nmv_replaced_path_required_hops(owner_instance text, budget text) RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN o IS NULL OR p IS NULL THEN NULL ELSE jsonb_build_array(o)||p END
  FROM (SELECT $owners$__OWNERS__$owners$::jsonb->owner_instance AS o, $providers$__PROVIDERS__$providers$::jsonb->budget AS p) x
$$;
--> statement-breakpoint
-- Every process on the call path was replaced after the dispatch and is a single instance. No stop, usage, success or TTL release.
CREATE FUNCTION nmv_replaced_path_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE p jsonb:=e->'plan'; q jsonb:=p->'request'; r jsonb:=e->'receipt'; req jsonb; h jsonb; i integer; t text;
BEGIN
  IF NOT nmv_replaced_provider_shape_valid(e,$shape$__EVIDENCE_SHAPE__$shape$::jsonb) THEN RETURN false; END IF;
  IF e->'requestId' IS DISTINCT FROM q->'requestId' OR e->'owner' IS DISTINCT FROM q->'owner' OR e->'dispatchAt' IS DISTINCT FROM q->'dispatchAt'
    OR e->'bindingHash' IS DISTINCT FROM q->'bindingHash' OR e->'reference' IS DISTINCT FROM p->'reviewReference'
    OR e->'notBefore' IS DISTINCT FROM r->'observedAt'
    OR r->>'planHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p),'UTF8')),'hex') THEN RETURN false; END IF;
  FOREACH t IN ARRAY ARRAY[e->>'dispatchAt',e->>'notBefore',e->>'evaluatedAt',p->>'createdAt',r->>'observedAt'] LOOP
    IF to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>t THEN RETURN false; END IF;
  END LOOP;
  t:=p->'control'->>'updatedAt';
  IF to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>t
    OR t::timestamptz>(p->>'createdAt')::timestamptz OR (q->>'dispatchAt')::timestamptz>(p->>'createdAt')::timestamptz
    OR (p->>'createdAt')::timestamptz>(e->>'evaluatedAt')::timestamptz OR (r->>'observedAt')::timestamptz>(e->>'evaluatedAt')::timestamptz
    OR (e->>'evaluatedAt')::timestamptz-(p->>'createdAt')::timestamptz>interval '60 minutes'
    OR (e->>'evaluatedAt')::timestamptz-(r->>'observedAt')::timestamptz>interval '24 hours' THEN RETURN false; END IF;
  req:=nmv_replaced_path_required_hops(q->'owner'->>'instanceId',q->>'providerBudgetId');
  IF req IS NULL OR jsonb_array_length(r->'hops')<>jsonb_array_length(req)
    OR (SELECT count(DISTINCT (x->>'host')||chr(10)||(x->>'incarnationId')) FROM jsonb_array_elements(r->'hops') x)<>jsonb_array_length(req) THEN RETURN false; END IF;
  FOR i IN 0..jsonb_array_length(req)-1 LOOP
    h:=r->'hops'->i;
    IF jsonb_build_object('role',h->'role','host',h->'host','kind',h->'kind','service',h->'service') IS DISTINCT FROM req->i
      OR to_char((h->>'startedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>h->>'startedAt'
      OR to_char((h->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>h->>'observedAt'
      OR (h->>'startedAt')::timestamptz<=(q->>'dispatchAt')::timestamptz OR (h->>'startedAt')::timestamptz>(h->>'observedAt')::timestamptz
      OR (h->>'observedAt')::timestamptz>(r->>'observedAt')::timestamptz
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
-- Keep the complete old constraints (including 0143's branch) as the indeterminate predecessor.
DO $$
DECLARE predicates text; amount integer;
BEGIN
  SELECT string_agg('('||substring(pg_get_constraintdef(oid) FROM 7)||')',' AND ' ORDER BY conname),count(*) INTO predicates,amount
    FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname=ANY(ARRAY['model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check']);
  IF amount<>4 THEN RAISE EXCEPTION 'replaced_path_predecessor_missing'; END IF;
  EXECUTE 'CREATE FUNCTION nmv_replaced_path_predecessor_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT coalesce(('||predicates||'),false) FROM jsonb_populate_record(NULL::model_capacity_requests,v||''{"state":"indeterminate","terminal_evidence":null,"terminal_evidence_hash":null,"settled_at":null}''::jsonb) model_capacity_requests $fn$';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_path_request_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE e jsonb:=v->'terminal_evidence'; q jsonb:=e->'plan'->'request'; b jsonb:=v->'dispatch_binding';
BEGIN
  RETURN coalesce(v->>'state'='withdrawn' AND v->'settled_at'='null'::jsonb AND v->'token'<>'null'::jsonb
    AND nmv_replaced_path_release_valid(e) AND nmv_replaced_path_predecessor_valid(v)
    AND v->>'terminal_evidence_hash'=encode(sha256(convert_to(nmv_boundary_canonical(e),'UTF8')),'hex')
    AND e->>'requestId'=v->>'request_id' AND e->'owner'->>'instanceId'=v->>'owner_instance_id' AND e->'owner'->>'bootId'=v->>'owner_boot_id'
    AND e->>'bindingHash'=v->>'dispatch_binding_hash' AND (e->>'dispatchAt')::timestamptz=(v->>'dispatched_at')::timestamptz
    AND q->>'tokenHash'=encode(sha256(convert_to(v->>'token','UTF8')),'hex') AND q->'epoch'=v->'epoch' AND q->'revision'=v->'revision'
    AND q->>'policyHash'=v->>'policy_hash' AND q->>'providerBudgetId'=v->>'provider_budget_id' AND q->>'groupId'=v->>'group_id'
    AND q->>'routeId'=v->>'route_id' AND q->>'provider'=v->>'provider' AND q->>'model'=v->>'model'
    AND q->'servingContractHash'=b->'servingContractHash'
    AND v->>'dispatch_binding_hash'=encode(sha256(convert_to(nmv_boundary_canonical(b),'UTF8')),'hex'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_path_records_valid(e jsonb,v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c model_capacity_control; f dr_writer_fence; p jsonb:=e->'plan';
BEGIN
  SELECT * INTO STRICT f FROM dr_writer_fence WHERE id=1;
  SELECT * INTO STRICT c FROM model_capacity_control WHERE id=1;
  RETURN coalesce(f.state='active' AND c.mode='draining' AND v->>'state'='indeterminate'
    AND v->'terminal_evidence'='null'::jsonb AND v->'terminal_evidence_hash'='null'::jsonb AND v->'settled_at'='null'::jsonb
    AND p->'request'->>'rowHash'=encode(sha256(convert_to(v::text,'UTF8')),'hex')
    AND p->'writer'=jsonb_build_object('lineageId',f.lineage_id,'writerEpoch',f.writer_epoch)
    AND p->'control'=jsonb_build_object('mode',c.mode,'epoch',c.epoch,'revision',c.revision,'policyHash',c.policy_hash,'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_path_event_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE e jsonb:=v->'evidence';
BEGIN
  RETURN coalesce(v->>'kind'='dispatch_released' AND v->>'from_state'='indeterminate' AND v->>'to_state'='withdrawn' AND v->'reason'='null'::jsonb
    AND nmv_replaced_path_release_valid(e) AND e->>'requestId'=v->>'request_id'
    AND e->'plan'->'request'->'epoch'=v->'epoch' AND e->'plan'->'request'->'revision'=v->'revision'
    AND e->'plan'->'request'->'policyHash'=v->'policy_hash',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE n text; old_predicate text;
BEGIN
  FOREACH n IN ARRAY ARRAY['model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check'] LOOP
    SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname=n;
    EXECUTE format('ALTER TABLE model_capacity_requests DROP CONSTRAINT %I',n);
    EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT %I CHECK ((%s) OR nmv_replaced_path_request_valid(to_jsonb(model_capacity_requests)))',n,old_predicate);
  END LOOP;
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_events'::regclass AND conname='model_capacity_events_kind_check';
  ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_kind_check;
  EXECUTE 'ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK (('||old_predicate||') OR nmv_replaced_path_event_valid(to_jsonb(model_capacity_events)))';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_path_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed_now timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND OLD.terminal_evidence->>'kind'='replaced_path_boundary_exit' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'replaced_path_terminal_immutable';
  END IF;
  IF NEW.terminal_evidence->>'kind' IS DISTINCT FROM 'replaced_path_boundary_exit' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'replaced_path_transition_invalid'; END IF;
  PERFORM 1 FROM dr_writer_fence WHERE id=1 FOR SHARE;
  PERFORM 1 FROM model_capacity_control WHERE id=1 FOR UPDATE;
  observed_now:=clock_timestamp();
  IF NOT nmv_replaced_path_records_valid(NEW.terminal_evidence,to_jsonb(OLD))
    OR NOT nmv_replaced_path_request_valid(to_jsonb(NEW))
    OR (to_jsonb(OLD)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at'])
    OR (NEW.terminal_evidence->>'evaluatedAt')::timestamptz NOT BETWEEN observed_now-interval '30 seconds' AND observed_now
    OR (NEW.terminal_evidence->'receipt'->>'observedAt')::timestamptz NOT BETWEEN observed_now-interval '24 hours' AND observed_now
    OR (NEW.terminal_evidence->'plan'->>'createdAt')::timestamptz NOT BETWEEN observed_now-interval '60 minutes' AND observed_now
    THEN RAISE EXCEPTION 'replaced_path_transition_conflict'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_capacity_replaced_path_guard BEFORE INSERT OR UPDATE ON model_capacity_requests FOR EACH ROW EXECUTE FUNCTION nmv_replaced_path_transition_guard();
