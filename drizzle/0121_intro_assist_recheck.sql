ALTER TABLE llm_assist_controls DROP CONSTRAINT llm_assist_control_task;
--> statement-breakpoint
ALTER TABLE llm_assist_controls ADD CONSTRAINT llm_assist_control_task CHECK (task IN ('uptime','repo_move','intro_recheck'));
--> statement-breakpoint
INSERT INTO llm_assist_controls(task) VALUES ('intro_recheck');
--> statement-breakpoint
CREATE TABLE intro_assist_corrections (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES llm_assist_work(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  factual_result_id uuid NOT NULL REFERENCES llm_assist_results(id) ON DELETE CASCADE,
  capacity_request_id uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  prompt_hash varchar(64) NOT NULL,
  response_hash varchar(64) NOT NULL,
  contract_hash varchar(64) NOT NULL,
  model varchar(200) NOT NULL,
  backend_id varchar(120) NOT NULL,
  correction jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT intro_assist_correction_hash CHECK (request_hash ~ '^[a-f0-9]{64}$' AND prompt_hash ~ '^[a-f0-9]{64}$' AND response_hash ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX intro_assist_correction_request ON intro_assist_corrections(capacity_request_id);
CREATE UNIQUE INDEX intro_assist_correction_factual ON intro_assist_corrections(factual_result_id);
