-- Isolated test/bootstrap administrator only. Never include in production migrations.
-- Runtime grants are explicit and column-scoped; identity is provisioned separately.
CREATE TABLE pipeline_replay.capacity_runs (
  run_id text PRIMARY KEY, owner_id uuid NOT NULL, manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared','running','draining','sealed')),
  started_at timestamptz, deadline_at timestamptz,
  admission_closed_at timestamptz, writers_fenced_at timestamptz, sealed_at timestamptz,
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  initial_projection jsonb, current_projection jsonb, initial_state_hash text, comparison_state_hash text,
  captured_at timestamptz, runner jsonb, quality jsonb, seal jsonb,
  charged_calls bigint NOT NULL DEFAULT 0 CHECK (charged_calls >= 0),
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0)
);
-- Trigger writes must not acquire a run-row FK lock, sequence lock, or domain read.
CREATE TABLE pipeline_replay.capacity_changes (
  run_id text NOT NULL, tx_key uuid NOT NULL, ordinal bigint NOT NULL CHECK (ordinal > 0),
  table_name text NOT NULL, operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  old_row jsonb, new_row jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, tx_key, ordinal)
);
CREATE TABLE pipeline_replay.capacity_transactions (
  run_id text NOT NULL, tx_key uuid NOT NULL, db_xid text NOT NULL, seq bigint NOT NULL,
  tx_started_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL, changes jsonb NOT NULL,
  PRIMARY KEY (run_id, tx_key), UNIQUE (run_id, seq)
);
CREATE TABLE pipeline_replay.capacity_commit_confirmations (
  run_id text NOT NULL, tx_key uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, tx_key)
);
CREATE TABLE pipeline_replay.capacity_inputs (
  run_id text NOT NULL REFERENCES pipeline_replay.capacity_runs(run_id), candidate_id bigint NOT NULL,
  input_hash text NOT NULL, source_revision_hash text NOT NULL, frozen_input jsonb NOT NULL,
  frozen_hash text NOT NULL CHECK (frozen_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (run_id, candidate_id, input_hash, source_revision_hash)
);
CREATE TABLE pipeline_replay.capacity_calls (
  run_id text NOT NULL, call_id text NOT NULL, candidate_id bigint NOT NULL, first_attempt_id bigint,
  input_hash text NOT NULL, source_revision_hash text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('first','second')), provider text NOT NULL, model text NOT NULL,
  second_review_id bigint, generation_key text, vote bigint,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  token_upper_bound bigint NOT NULL CHECK (token_upper_bound > 0),
  state text NOT NULL CHECK (state IN ('reserved','dispatching','in_flight','settled','cancelled_before_dispatch','indeterminate')),
  dispatched_at timestamptz, settled_at timestamptz, input_tokens bigint, output_tokens bigint,
  result_ok boolean, result_hash text, result_decision_hash text,
  failure_class text CHECK (failure_class IN ('technical','cancelled','deferred','unknown')),
  PRIMARY KEY (run_id, call_id),
  FOREIGN KEY (run_id, candidate_id, input_hash, source_revision_hash)
    REFERENCES pipeline_replay.capacity_inputs(run_id, candidate_id, input_hash, source_revision_hash),
  CHECK ((input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0)),
  CHECK (first_attempt_id IS NULL OR first_attempt_id > 0),
  CHECK ((result_ok IS NULL AND result_hash IS NULL AND result_decision_hash IS NULL)
    OR (result_ok IS FALSE AND result_hash IS NULL AND result_decision_hash IS NULL)
    OR (result_ok IS TRUE AND result_hash IS NOT NULL AND result_hash ~ '^[a-f0-9]{64}$'
      AND result_decision_hash IS NOT NULL AND result_decision_hash ~ '^[a-f0-9]{64}$')),
  CHECK ((stage = 'first' AND first_attempt_id IS NOT NULL AND second_review_id IS NULL AND generation_key IS NULL AND vote IS NULL)
    OR (stage = 'second' AND second_review_id IS NOT NULL AND second_review_id > 0
      AND generation_key IS NOT NULL AND length(generation_key) BETWEEN 1 AND 160 AND vote IS NOT NULL AND vote > 0))
);
CREATE TABLE pipeline_replay.capacity_transitions (
  run_id text NOT NULL REFERENCES pipeline_replay.capacity_runs(run_id), seq bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), kind text NOT NULL, payload jsonb NOT NULL,
  tx_key text DEFAULT nullif(current_setting('pipeline_replay.tx_key', true), ''),
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE pipeline_replay.capacity_finals (
  run_id text NOT NULL, candidate_id bigint NOT NULL, input_hash text NOT NULL,
  source_revision_hash text NOT NULL, policy_hash text NOT NULL,
  seq bigint NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_attempt_id bigint NOT NULL CHECK (first_attempt_id > 0), first_call_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  second_witnesses jsonb NOT NULL CHECK (jsonb_typeof(second_witnesses) = 'array'),
  PRIMARY KEY (run_id, candidate_id, input_hash, source_revision_hash, policy_hash),
  FOREIGN KEY (run_id, seq) REFERENCES pipeline_replay.capacity_transitions(run_id, seq),
  FOREIGN KEY (run_id, first_call_id) REFERENCES pipeline_replay.capacity_calls(run_id, call_id),
  FOREIGN KEY (run_id, candidate_id, input_hash, source_revision_hash)
    REFERENCES pipeline_replay.capacity_inputs(run_id, candidate_id, input_hash, source_revision_hash)
);
REVOKE ALL ON pipeline_replay.capacity_runs, pipeline_replay.capacity_inputs,
  pipeline_replay.capacity_calls, pipeline_replay.capacity_transitions, pipeline_replay.capacity_finals,
  pipeline_replay.capacity_changes, pipeline_replay.capacity_transactions, pipeline_replay.capacity_commit_confirmations FROM PUBLIC;

CREATE FUNCTION pipeline_replay.capture_handler_change() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE replay_run text := current_setting('pipeline_replay.run_id', true);
  replay_tx text := current_setting('pipeline_replay.tx_key', true); next_ordinal bigint;
BEGIN
  IF replay_run IS NULL OR replay_run = '' OR replay_tx IS NULL OR replay_tx = '' THEN RETURN NULL; END IF;
  IF TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME NOT IN ('public.crawl_candidates','public.crawl_review_attempts',
    'public.second_reviews','public.crawl_frontier','public.jobs','public.operations_observations','pipeline_replay.capacity_calls',
    'public.pipeline_stage_modes','public.pipeline_item_leases')
    THEN RAISE EXCEPTION 'replay_journal_table_rejected'; END IF;
  next_ordinal := coalesce(nullif(current_setting('pipeline_replay.ordinal', true), ''), '0')::bigint + 1;
  PERFORM set_config('pipeline_replay.ordinal', next_ordinal::text, true);
  INSERT INTO pipeline_replay.capacity_changes(run_id,tx_key,ordinal,table_name,operation,old_row,new_row)
    VALUES (replay_run,replay_tx::uuid,next_ordinal,TG_TABLE_NAME,TG_OP,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION pipeline_replay.capture_handler_change() FROM PUBLIC;
