-- Separate workload-pool membership from the existing fallback ranks (1..3).
-- No defaults are inserted, no tasks enabled, no capacity/dispatch/terminal rules changed.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE ai_task_execution_configs (
  task varchar(64) NOT NULL, slot integer NOT NULL, mode varchar(16) NOT NULL,
  revision bigint NOT NULL DEFAULT 1, updated_by varchar(120) NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task, slot),
  CONSTRAINT ai_task_execution_configs_task_check CHECK (task ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT ai_task_execution_configs_slot_check CHECK (slot BETWEEN 1 AND 8),
  CONSTRAINT ai_task_execution_configs_mode_check CHECK (mode IN ('fallback','workload_pool')),
  CONSTRAINT ai_task_execution_configs_revision_check CHECK (revision BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE ai_task_pool_members (
  member_id uuid PRIMARY KEY, task varchar(64) NOT NULL, slot integer NOT NULL,
  position integer NOT NULL, connection_id uuid NOT NULL, model varchar(200) NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb, canonical_model varchar(200) NOT NULL,
  device_id varchar(120) NOT NULL, engine_key varchar(64) NOT NULL,
  CONSTRAINT ai_task_pool_members_config_fk FOREIGN KEY (task,slot) REFERENCES ai_task_execution_configs(task,slot) ON DELETE CASCADE,
  CONSTRAINT ai_task_pool_members_connection_fk FOREIGN KEY (connection_id) REFERENCES ai_connections(id) ON DELETE RESTRICT,
  CONSTRAINT ai_task_pool_members_position_key UNIQUE (task,slot,position),
  CONSTRAINT ai_task_pool_members_engine_key UNIQUE (task,slot,engine_key),
  CONSTRAINT ai_task_pool_members_position_check CHECK (position BETWEEN 1 AND 4),
  CONSTRAINT ai_task_pool_members_model_check CHECK (char_length(model) BETWEEN 1 AND 200 AND model=btrim(model) AND model !~ '[[:cntrl:]]'),
  CONSTRAINT ai_task_pool_members_canonical_check CHECK (char_length(canonical_model) BETWEEN 1 AND 200 AND canonical_model=btrim(canonical_model) AND canonical_model !~ '[[:cntrl:]]'),
  CONSTRAINT ai_task_pool_members_device_check CHECK (char_length(device_id) BETWEEN 1 AND 120 AND device_id=btrim(device_id) AND device_id !~ '[[:cntrl:]]'),
  CONSTRAINT ai_task_pool_members_engine_check CHECK (engine_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ai_task_pool_members_options_check CHECK (jsonb_typeof(options)='object' AND pg_column_size(options)<=4096)
);
--> statement-breakpoint
CREATE INDEX ai_task_pool_members_connection_idx ON ai_task_pool_members(connection_id);
--> statement-breakpoint
-- Immutable selection of a newly created AI2 vote; existing pending votes are not backfilled.
-- No FK to live configuration/membership: later edits cannot rewrite a vote's original selection.
CREATE TABLE second_review_workload_assignments (
  second_review_id integer PRIMARY KEY REFERENCES second_reviews(id) ON DELETE CASCADE,
  task_slot integer NOT NULL, config_revision bigint NOT NULL, member_id uuid NOT NULL,
  canonical_model varchar(200) NOT NULL,
  CONSTRAINT second_review_workload_slot_check CHECK (task_slot BETWEEN 1 AND 3),
  CONSTRAINT second_review_workload_revision_check CHECK (config_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT second_review_workload_canonical_check CHECK (length(canonical_model)>0 AND canonical_model=btrim(canonical_model) AND canonical_model !~ '[[:cntrl:]]')
);
