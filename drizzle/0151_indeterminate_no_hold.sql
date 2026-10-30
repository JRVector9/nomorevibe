-- 0151: indeterminate rows no longer hold capacity (owner decision 2026-10-30: "타임아웃으로 '확인 못함'으로 남기고 슬롯을 점유하지 못하게 하고
-- 해당 작업은 종료시킨다. 다른 제품들 검토에 방해를 줄 수 없다. 미확인은 사람이 검토하면 된다."). Semantics only: no row is rewritten.
-- 1) The three partial indexes stop treating 'indeterminate' as live/occupying, so the same logical/work key can be re-admitted while an
--    unknown row for it exists (lib/llm/capacity-states.ts is the single source of these state lists).
-- 2) dispatch_indeterminate gains the reason 'client_timeout' (caller deadline) beside transport_unknown/local_abort/process_exit/commit_unknown.
-- 3) Human review close (dispatch_reviewed, indeterminate -> withdrawn with {version,kind:'operator_review',...} evidence on the row and the event).
--    Like 0132/0149, each CHECK is rebuilt from its live pg_get_constraintdef predicate as the whole left side plus one appended OR branch; the
--    $ai2_local$ quoting tag is the marker the schema history tests recognise. The shape predicate lives in one SQL function shared by the three CHECKs.
DROP INDEX IF EXISTS model_capacity_requests_logical_active_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX model_capacity_requests_logical_active_idx ON model_capacity_requests (logical_work_key) WHERE logical_work_key IS NOT NULL AND state IN ('reserved','dispatched');
--> statement-breakpoint
DROP INDEX IF EXISTS model_capacity_requests_live_work_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX model_capacity_requests_live_work_idx ON model_capacity_requests (owner_instance_id, owner_boot_id, work_key) WHERE state IN ('waiting','reserved','dispatched');
--> statement-breakpoint
DROP INDEX IF EXISTS model_capacity_requests_active_idx;
--> statement-breakpoint
CREATE INDEX model_capacity_requests_active_idx ON model_capacity_requests (provider_budget_id, group_id, pool) WHERE state IN ('reserved','dispatched');
--> statement-breakpoint
ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_reason_check;
--> statement-breakpoint
ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_reason_check CHECK (reason IS NULL OR reason IN ('transport_unknown','local_abort','process_exit','commit_unknown','client_timeout'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_operator_review_evidence_valid(evidence jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(evidence)='object' AND evidence ?& ARRAY['version','kind','requestId','owner','fromState','operator','note','reviewedAt'] AND evidence - ARRAY['version','kind','requestId','owner','fromState','operator','note','reviewedAt']='{}'::jsonb
    AND evidence->'version'='1'::jsonb AND evidence->'kind'='"operator_review"'::jsonb AND evidence->'fromState'='"indeterminate"'::jsonb
    AND jsonb_typeof(evidence->'requestId')='string' AND (evidence->>'requestId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(evidence->'owner')='object' AND (evidence->'owner') ?& ARRAY['instanceId','bootId'] AND (evidence->'owner') - ARRAY['instanceId','bootId']='{}'::jsonb
    AND jsonb_typeof(evidence->'owner'->'instanceId')='string' AND char_length(evidence->'owner'->>'instanceId') BETWEEN 1 AND 120
    AND jsonb_typeof(evidence->'owner'->'bootId')='string' AND (evidence->'owner'->>'bootId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(evidence->'operator')='string' AND char_length(evidence->>'operator') BETWEEN 1 AND 120
    AND jsonb_typeof(evidence->'note')='string' AND char_length(evidence->>'note') BETWEEN 1 AND 400
    AND jsonb_typeof(evidence->'reviewedAt')='string' AND (evidence->>'reviewedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$', false)
$$;
--> statement-breakpoint
DO $$
DECLARE old_predicate text;
BEGIN
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate
    FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname='model_capacity_requests_dispatch_check';
  ALTER TABLE model_capacity_requests DROP CONSTRAINT model_capacity_requests_dispatch_check;
  EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT model_capacity_requests_dispatch_check CHECK ((%s) OR (%s))',
    old_predicate, $ai2_local$coalesce(state='withdrawn' AND dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL AND terminal_evidence IS NOT NULL AND terminal_evidence->>'kind'='operator_review' AND nmv_operator_review_evidence_valid(terminal_evidence) AND terminal_evidence->>'requestId'=request_id::text AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),false)$ai2_local$);
END $$;
--> statement-breakpoint
DO $$
DECLARE old_predicate text;
BEGIN
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate
    FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname='model_capacity_requests_terminal_check';
  ALTER TABLE model_capacity_requests DROP CONSTRAINT model_capacity_requests_terminal_check;
  EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT model_capacity_requests_terminal_check CHECK ((%s) OR (%s))',
    old_predicate, $ai2_local$coalesce(state='withdrawn' AND terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NULL AND token IS NOT NULL AND terminal_evidence->>'kind'='operator_review' AND nmv_operator_review_evidence_valid(terminal_evidence) AND terminal_evidence->>'requestId'=request_id::text AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),false)$ai2_local$);
END $$;
--> statement-breakpoint
DO $$
DECLARE old_predicate text;
BEGIN
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate
    FROM pg_constraint WHERE conrelid='model_capacity_events'::regclass AND conname='model_capacity_events_kind_check';
  ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_kind_check;
  EXECUTE format('ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK ((%s) OR (%s))',
    old_predicate, $ai2_local$coalesce(kind='dispatch_reviewed' AND from_state='indeterminate' AND to_state='withdrawn' AND reason IS NULL AND nmv_operator_review_evidence_valid(evidence) AND evidence->>'requestId'=request_id::text,false)$ai2_local$);
END $$;
