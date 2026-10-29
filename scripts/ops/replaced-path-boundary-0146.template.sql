-- 0146: an absent hop counts only when observed after the dispatch (0145 accepted an absence observed at any time).
-- Only the evidence validator changes; CHECKs, triggers and already withdrawn rows are untouched.
DO $$
BEGIN
  IF to_regprocedure('public.nmv_replaced_path_release_valid(jsonb)') IS NULL
    OR to_regprocedure('public.nmv_replaced_path_required_hops(text,text)') IS NULL
    THEN RAISE EXCEPTION 'replaced_path_predecessor_0145_missing'; END IF;
END $$;
--> statement-breakpoint
-- Every process on the call path is replaced, absent, or (engine only) idle after its upstream. No stop, usage, success or TTL release.
CREATE OR REPLACE FUNCTION nmv_replaced_path_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE p jsonb:=e->'plan'; q jsonb:=p->'request'; r jsonb:=e->'receipt'; req jsonb; h jsonb; i integer; t text; cutoff timestamptz;
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
    OR (SELECT count(DISTINCT (x->>'host')||chr(10)||(x->>'incarnationId')) FROM jsonb_array_elements(r->'hops') x WHERE x->>'mode'<>'absent')
      <>(SELECT count(*) FROM jsonb_array_elements(r->'hops') x WHERE x->>'mode'<>'absent') THEN RETURN false; END IF;
  -- An idle engine counts only after every hop above it was replaced (its start) or absent (its observation).
  SELECT max(CASE WHEN x->>'mode'='absent' THEN (x->>'observedAt')::timestamptz ELSE (x->>'startedAt')::timestamptz END) INTO cutoff
    FROM jsonb_array_elements(r->'hops') x WHERE x->>'role'<>'provider';
  IF cutoff IS NULL THEN RETURN false; END IF;
  FOR i IN 0..jsonb_array_length(req)-1 LOOP
    h:=r->'hops'->i;
    IF jsonb_build_object('role',h->'role','host',h->'host','kind',h->'kind','service',h->'service') IS DISTINCT FROM req->i
      OR to_char((h->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>h->>'observedAt'
      OR (h->>'observedAt')::timestamptz>(r->>'observedAt')::timestamptz THEN RETURN false; END IF;
    IF h->>'mode'='absent' THEN
      IF h->>'role' IN ('owner','provider') OR h->'startedAt'<>'null'::jsonb OR h->>'incarnationId'<>'absent'
        OR (h->>'observedAt')::timestamptz<=(q->>'dispatchAt')::timestamptz THEN RETURN false; END IF;
    ELSIF h->>'mode' IN ('replaced','idle') THEN
      IF jsonb_typeof(h->'startedAt')<>'string'
        OR to_char((h->>'startedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>h->>'startedAt'
        OR (h->>'startedAt')::timestamptz>(h->>'observedAt')::timestamptz
        OR h->>'mode'='replaced' AND (h->>'startedAt')::timestamptz<=(q->>'dispatchAt')::timestamptz
        OR h->>'mode'='idle' AND (h->>'role'<>'provider' OR (h->>'observedAt')::timestamptz<=cutoff) THEN RETURN false; END IF;
    ELSE RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
