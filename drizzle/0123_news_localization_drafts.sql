-- Add a typed news target; all controls remain off.
ALTER TABLE llm_assist_controls DROP CONSTRAINT llm_assist_control_task;
ALTER TABLE llm_assist_controls ADD CONSTRAINT llm_assist_control_task CHECK (task IN ('uptime','repo_move','intro_recheck','decision_audit','semantic_exception','news'));
INSERT INTO llm_assist_controls(task) VALUES ('news');
--> statement-breakpoint
ALTER TABLE llm_assist_work ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE llm_assist_work ADD COLUMN news_item_id integer REFERENCES news_items(id) ON DELETE CASCADE;
ALTER TABLE llm_assist_work ADD CONSTRAINT llm_assist_work_target CHECK
  ((task='news' AND product_id IS NULL AND news_item_id IS NOT NULL) OR (task<>'news' AND product_id IS NOT NULL AND news_item_id IS NULL));
CREATE UNIQUE INDEX llm_assist_news_source_unique ON llm_assist_work(task,news_item_id,source_hash);
CREATE UNIQUE INDEX llm_assist_news_active_unique ON llm_assist_work(task,news_item_id) WHERE state IN ('claimed','indeterminate');
ALTER TABLE llm_assist_work ADD CONSTRAINT llm_assist_work_news_binding CHECK (task<>'news' OR coalesce(
  origin_job='news-refresh' AND source->>'locale'='ko' AND source->'news'->'id'=to_jsonb(news_item_id)
  AND source->'news'->>'state' IN ('approved','pending') AND source->'news'->>'revision' IS NOT NULL
  AND (input IS NULL OR (input->>'task'='news' AND input->'subject'->>'type'='news_item'
    AND input->'subject'->'id'=to_jsonb(news_item_id) AND input->>'policyVersion'=policy_version AND input->>'promptVersion'=prompt_version)),false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_local_assist_task_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(value IN ('uptime','repo_move','intro_recheck','decision_audit','semantic_exception','news'), false)
$$;
--> statement-breakpoint
-- PR10 dormant backend. Requires PR04's common llm_assist_* tables and the
-- parent-owned news_item_id typed-target/task/check/index delta described in
-- docs/plans/2026-10-23-qwen-first/PR-10-backend-integration.md.
-- No public translation selection, source rewrite, job registration or activation.
CREATE TABLE news_localizations (
  result_id uuid PRIMARY KEY REFERENCES llm_assist_results(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES llm_assist_work(id) ON DELETE CASCADE,
  news_item_id integer NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  locale varchar(8) NOT NULL DEFAULT 'ko',
  source_hash varchar(64) NOT NULL,
  source_snapshot jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'needs_review',
  title varchar(45), summary text, facts jsonb, validation jsonb NOT NULL,
  backend_id varchar(120) NOT NULL, model_family varchar(120) NOT NULL, model_id varchar(200) NOT NULL,
  policy_version varchar(120) NOT NULL, prompt_version varchar(120) NOT NULL,
  input_hash varchar(64) NOT NULL, contract_hash varchar(64) NOT NULL,
  prompt_hash varchar(64) NOT NULL, response_hash varchar(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT news_localizations_locale CHECK (locale='ko'),
  CONSTRAINT news_localizations_status CHECK (status IN ('draft','needs_review')),
  CONSTRAINT news_localizations_draft CHECK (status<>'draft' OR (title IS NOT NULL AND summary IS NOT NULL AND facts IS NOT NULL AND validation @> '{"ok":true,"authority":"translation_candidate_only","semanticCoverage":"bounded_patterns"}'::jsonb)),
  CONSTRAINT news_localizations_source CHECK (coalesce(jsonb_typeof(source_snapshot)='object' AND source_snapshot->'id'=to_jsonb(news_item_id) AND source_snapshot->>'state' IN ('approved','pending'),false)),
  CONSTRAINT news_localizations_hash CHECK (source_hash ~ '^[a-f0-9]{64}$' AND input_hash ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND prompt_hash ~ '^[a-f0-9]{64}$' AND response_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX news_localizations_source_idx ON news_localizations(news_item_id,locale,source_hash,created_at DESC);
