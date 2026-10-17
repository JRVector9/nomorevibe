-- PR11e: Oracle activation gaps. New function/trigger/index only; existing tables, columns, CHECK constraints and grants are unchanged.
-- (1) Worker principals INSERT job_batch_candidates for the heartbeat (Drizzle names every column, so INSERT cannot be column-limited).
-- A row may carry capability/result_evidence only when the inserting role may also UPDATE that column (the attest principal, the owner);
-- every other role inserts both as NULL, exactly what the heartbeat writes. SQLSTATE 42501 like any other privilege refusal.
CREATE FUNCTION job_batch_candidates_evidence_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.capability IS NOT NULL AND NOT pg_catalog.has_column_privilege(TG_RELID, 'capability', 'UPDATE'))
    OR (NEW.result_evidence IS NOT NULL AND NOT pg_catalog.has_column_privilege(TG_RELID, 'result_evidence', 'UPDATE')) THEN
    RAISE EXCEPTION 'job_batch_candidates_evidence_insert_denied' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_batch_candidates_evidence_insert_guard BEFORE INSERT ON job_batch_candidates FOR EACH ROW EXECUTE FUNCTION job_batch_candidates_evidence_insert_guard();
--> statement-breakpoint
-- (2) Oracle translation model readback (attest and runtime preflight): route + owner instance + the tick's requestedVersion.
CREATE INDEX model_capacity_requests_job_readback_idx ON model_capacity_requests (route_id, owner_instance_id, ((dispatch_binding->'job'->>'requestedVersion')));
