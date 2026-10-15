-- Isolated test/bootstrap administrator only. Never include in production migrations.
-- Runtime grants are explicit and column-scoped; identity is provisioned separately.
CREATE TABLE pipeline_replay.capacity_runs (
  run_id text PRIMARY KEY, owner_id uuid NOT NULL, manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared','running','draining','sealed')),
  started_at timestamptz, deadline_at timestamptz,
  charged_calls bigint NOT NULL DEFAULT 0 CHECK (charged_calls >= 0),
  charged_tokens bigint NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0)
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
  PRIMARY KEY (run_id, call_id),
  FOREIGN KEY (run_id, candidate_id, input_hash, source_revision_hash)
    REFERENCES pipeline_replay.capacity_inputs(run_id, candidate_id, input_hash, source_revision_hash),
  CHECK ((input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0)),
  CHECK (first_attempt_id IS NULL OR first_attempt_id > 0),
  CHECK ((stage = 'first' AND first_attempt_id IS NOT NULL AND second_review_id IS NULL AND generation_key IS NULL AND vote IS NULL)
    OR (stage = 'second' AND second_review_id IS NOT NULL AND second_review_id > 0
      AND generation_key IS NOT NULL AND length(generation_key) BETWEEN 1 AND 160 AND vote IS NOT NULL AND vote > 0))
);
CREATE TABLE pipeline_replay.capacity_transitions (
  run_id text NOT NULL REFERENCES pipeline_replay.capacity_runs(run_id), seq bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), kind text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);
REVOKE ALL ON pipeline_replay.capacity_runs, pipeline_replay.capacity_inputs,
  pipeline_replay.capacity_calls, pipeline_replay.capacity_transitions FROM PUBLIC;
