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
