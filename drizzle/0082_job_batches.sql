CREATE TABLE job_batch_control (
  id integer PRIMARY KEY CHECK (id = 1),
  mode varchar(12) NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy','draining','versioned')),
  draining_from varchar(12),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch BETWEEN 1 AND 9007199254740991),
  writer_contract_version integer NOT NULL DEFAULT 0 CHECK (writer_contract_version >= 0),
  policy jsonb,
  policy_hash varchar(64),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_batch_control_drain_check CHECK ((mode='draining' AND draining_from IS NOT NULL AND draining_from IN ('legacy','versioned')) OR (mode<>'draining' AND draining_from IS NULL)),
  CONSTRAINT job_batch_control_policy_check CHECK ((policy IS NULL AND policy_hash IS NULL) OR (policy IS NOT NULL AND policy_hash IS NOT NULL AND policy_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
INSERT INTO job_batch_control(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE job_batch_candidates (
  role varchar(30) NOT NULL CHECK(role IN ('crawler','reviewer','publisher','text','maintenance','translation','product-health','site-evidence','official-news')),
  instance_id varchar(48) NOT NULL,
  host varchar(24) NOT NULL CHECK(host IN ('m3','mini','oracle-osaka-smoke')),
  boot_id varchar(36) NOT NULL,
  release varchar(120) NOT NULL,
  policy_hash varchar(64) NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
  capability jsonb,
  result_evidence jsonb,
  observed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(role,instance_id)
);
