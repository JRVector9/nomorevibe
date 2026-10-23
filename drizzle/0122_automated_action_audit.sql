ALTER TABLE llm_assist_controls DROP CONSTRAINT llm_assist_control_task;
ALTER TABLE llm_assist_controls ADD CONSTRAINT llm_assist_control_task
  CHECK (task IN ('uptime','repo_move','intro_recheck','semantic_exception','decision_audit'));
INSERT INTO llm_assist_controls(task) VALUES ('semantic_exception'),('decision_audit');
--> statement-breakpoint
CREATE UNIQUE INDEX llm_assist_audit_original_period_unique ON llm_assist_work
  (task,(source->'decision'->>'resultId'),(source->>'periodStart'))
  WHERE task IN ('semantic_exception','decision_audit');
ALTER TABLE llm_assist_work ADD CONSTRAINT llm_assist_audit_target CHECK (
  task NOT IN ('semantic_exception','decision_audit') OR coalesce(
    source->'product'->'id'=to_jsonb(product_id) AND source->'decision'->'productId'=to_jsonb(product_id)
    AND source->'decision'->>'task' IN ('uptime','repo','intro')
    AND source->'decision'->>'resultId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND source->>'periodStart' ~ '^\d{4}-\d{2}-\d{2}$'
    AND source->>'seedHash' ~ '^[a-f0-9]{64}$'
    AND (input IS NULL OR (input->>'task'='audit' AND input->'subject'->'id'=to_jsonb(product_id)
      AND input->'context'->>'subject'=source->'decision'->>'task'))
    AND ((source->'decision'->>'task'='uptime' AND origin_job='uptime-ping')
      OR (source->'decision'->>'task'='repo' AND origin_job='product-repo-review')
      OR (source->'decision'->>'task'='intro' AND origin_job='product-intro-check')),false));
--> statement-breakpoint
CREATE TABLE llm_assist_audit_periods (
  period_start date PRIMARY KEY,
  policy_hash varchar(64) NOT NULL,
  seed_hash varchar(64) NOT NULL,
  max_audits integer NOT NULL,
  max_exceptions integer NOT NULL,
  selected_result_ids jsonb,
  exception_count integer NOT NULL DEFAULT 0,
  skipped_unknown_family integer NOT NULL DEFAULT 0,
  candidates_clipped boolean NOT NULL DEFAULT false,
  frozen_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT llm_assist_audit_period_hash CHECK (policy_hash ~ '^[a-f0-9]{64}$' AND seed_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT llm_assist_audit_period_limits CHECK (max_audits BETWEEN 1 AND 1000 AND max_exceptions BETWEEN 0 AND 1000
    AND exception_count BETWEEN 0 AND max_exceptions AND skipped_unknown_family>=0),
  CONSTRAINT llm_assist_audit_period_selection CHECK ((selected_result_ids IS NULL AND frozen_at IS NULL) OR coalesce(
    jsonb_typeof(selected_result_ids)='array' AND jsonb_array_length(selected_result_ids)<=max_audits AND frozen_at IS NOT NULL,false))
);
--> statement-breakpoint
CREATE TABLE llm_assist_audit_findings (
  audit_result_id uuid PRIMARY KEY REFERENCES llm_assist_results(id) ON DELETE CASCADE,
  original_result_id uuid NOT NULL REFERENCES llm_assist_results(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES llm_assist_work(id) ON DELETE CASCADE,
  period_start date NOT NULL REFERENCES llm_assist_audit_periods(period_start),
  subject varchar(12) NOT NULL,
  original_model_family varchar(120),
  auditor_model_family varchar(120) NOT NULL,
  decision_at timestamp NOT NULL,
  audited_at timestamp NOT NULL,
  decision_source_hash varchar(64) NOT NULL,
  current_input_hash varchar(64) NOT NULL,
  comparison jsonb NOT NULL,
  CONSTRAINT llm_assist_audit_finding_subject CHECK (subject IN ('uptime','repo','intro')),
  CONSTRAINT llm_assist_audit_finding_family CHECK (original_model_family IS NOT NULL AND original_model_family<>auditor_model_family
    AND original_model_family IN ('qwen3.8-flash-next','deepseek-v4.1-flash-1017','gpt-oss-120b')
    AND auditor_model_family IN ('qwen3.8-flash-next','deepseek-v4.1-flash-1017','gpt-oss-120b')),
  CONSTRAINT llm_assist_audit_finding_hash CHECK (decision_source_hash ~ '^[a-f0-9]{64}$' AND current_input_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT llm_assist_audit_finding_comparison CHECK (coalesce(comparison->>'authority'='record_only'
    AND comparison->>'interpretation'='current_evidence_comparison'
    AND comparison->>'status' IN ('agree','human_review','needs_evidence'),false))
);
CREATE UNIQUE INDEX llm_assist_audit_human_unique ON llm_assist_audit_findings(original_result_id,period_start)
  WHERE comparison->>'status'='human_review';
CREATE INDEX llm_assist_audit_attention ON llm_assist_audit_findings(audited_at)
  WHERE comparison->>'status'='human_review';
--> statement-breakpoint
CREATE FUNCTION llm_assist_audit_preserve_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_hash<>OLD.policy_hash OR NEW.seed_hash<>OLD.seed_hash OR NEW.period_start<>OLD.period_start
    OR NEW.max_audits<>OLD.max_audits OR NEW.max_exceptions<>OLD.max_exceptions OR NEW.exception_count<OLD.exception_count
    OR (OLD.frozen_at IS NOT NULL AND (NEW.selected_result_ids IS DISTINCT FROM OLD.selected_result_ids
      OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at)) THEN
    RAISE EXCEPTION 'audit_period_is_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER llm_assist_audit_preserve_period BEFORE UPDATE ON llm_assist_audit_periods
  FOR EACH ROW EXECUTE FUNCTION llm_assist_audit_preserve_period();
