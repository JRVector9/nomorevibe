CREATE TABLE llm_assist_controls (
  task varchar(32) PRIMARY KEY,
  mode varchar(10) NOT NULL DEFAULT 'off',
  confirmation_required boolean NOT NULL DEFAULT false,
  dispatch_enabled boolean NOT NULL DEFAULT false,
  apply_enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT llm_assist_control_task CHECK (task IN ('uptime')),
  CONSTRAINT llm_assist_control_mode CHECK (mode IN ('off','shadow','confirm')),
  CONSTRAINT llm_assist_control_confirm CHECK (mode<>'confirm' OR confirmation_required),
  CONSTRAINT llm_assist_control_apply CHECK (NOT apply_enabled OR (dispatch_enabled AND mode='confirm')),
  CONSTRAINT llm_assist_control_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO llm_assist_controls(task) VALUES ('uptime');
--> statement-breakpoint
CREATE TABLE llm_assist_work (
  id uuid PRIMARY KEY,
  task varchar(32) NOT NULL REFERENCES llm_assist_controls(task),
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin_job varchar(80) NOT NULL,
  source_hash varchar(64) NOT NULL,
  source jsonb NOT NULL,
  policy_version varchar(120) NOT NULL,
  prompt_version varchar(120) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'queued',
  revision bigint NOT NULL DEFAULT 1,
  priority integer NOT NULL DEFAULT 0,
  control_revision bigint NOT NULL DEFAULT 1,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  claim_token uuid, claim_job varchar(80), claim_job_token uuid, claim_requested_version bigint,
  owner_instance_id varchar(120), owner_boot_id uuid,
  backend_id varchar(120), capacity_request_id uuid,
  input jsonb, input_hash varchar(64),
  attempts integer NOT NULL DEFAULT 0,
  last_error varchar(120),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT llm_assist_work_state CHECK (state IN ('queued','claimed','waiting_evidence','waiting_capacity','retryable_transport','human','done','obsolete','indeterminate')),
  CONSTRAINT llm_assist_work_revision CHECK (revision BETWEEN 1 AND 9007199254740991 AND attempts BETWEEN 0 AND 1000),
  CONSTRAINT llm_assist_work_hash CHECK (source_hash ~ '^[a-f0-9]{64}$' AND (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$')),
  CONSTRAINT llm_assist_work_source_shape CHECK (jsonb_typeof(source)='object' AND source->>'kind'=task),
  CONSTRAINT llm_assist_work_claim CHECK ((state IN ('claimed','indeterminate')) = (claim_token IS NOT NULL)
    AND (claim_token IS NULL OR (claim_job IS NOT NULL AND claim_job_token IS NOT NULL AND claim_requested_version IS NOT NULL AND owner_instance_id IS NOT NULL AND owner_boot_id IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX llm_assist_work_source_unique ON llm_assist_work(task,product_id,source_hash);
CREATE UNIQUE INDEX llm_assist_work_active_unique ON llm_assist_work(task,product_id) WHERE state IN ('claimed','indeterminate');
CREATE INDEX llm_assist_work_due ON llm_assist_work(next_attempt_at,priority,id) WHERE state IN ('queued','waiting_capacity','retryable_transport');
--> statement-breakpoint
CREATE TABLE llm_assist_results (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES llm_assist_work(id) ON DELETE CASCADE,
  work_revision bigint NOT NULL,
  capacity_request_id uuid NOT NULL,
  backend_id varchar(120) NOT NULL, model_family varchar(120) NOT NULL,
  contract_hash varchar(64) NOT NULL, input_hash varchar(64) NOT NULL,
  prompt_hash varchar(64) NOT NULL, response_hash varchar(64) NOT NULL,
  outcome jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  completed_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT llm_assist_result_hash CHECK (contract_hash ~ '^[a-f0-9]{64}$' AND input_hash ~ '^[a-f0-9]{64}$'
    AND prompt_hash ~ '^[a-f0-9]{64}$' AND response_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX llm_assist_results_request_unique ON llm_assist_results(capacity_request_id);
--> statement-breakpoint
CREATE FUNCTION llm_assist_preserve_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.confirmation_required AND NOT NEW.confirmation_required THEN
    RAISE EXCEPTION 'assist_confirmation_gate_cannot_be_reset';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER llm_assist_preserve_confirmation BEFORE UPDATE ON llm_assist_controls
  FOR EACH ROW EXECUTE FUNCTION llm_assist_preserve_confirmation();
