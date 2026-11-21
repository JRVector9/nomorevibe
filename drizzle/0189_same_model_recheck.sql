-- Separate advisory record: never read by vote/hold/auto-close predicates.
-- New table only; no model ledger CHECK rebuild or DRAIN requirement for this migration.
-- 0188 is reserved by the parallel stale-recollect PR #987.
CREATE TABLE product_audit_same_model_rechecks (
  item_id integer NOT NULL REFERENCES product_audit_items(id) ON DELETE CASCADE,
  reject_revision varchar(32) NOT NULL,
  prompt_version varchar(80) NOT NULL,
  source varchar(40) NOT NULL DEFAULT 'same-model-recheck',
  actor varchar(40) NOT NULL DEFAULT 'same-model-recheck',
  model varchar(160) NOT NULL,
  decision varchar(20) NOT NULL,
  reason text,
  confidence double precision,
  input_hash varchar(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, reject_revision, prompt_version),
  CONSTRAINT same_model_recheck_source CHECK (source = 'same-model-recheck' AND actor = 'same-model-recheck'),
  CONSTRAINT same_model_recheck_decision CHECK (decision IN ('approve', 'reject', 'needs_review')),
  CONSTRAINT same_model_recheck_confidence CHECK (confidence BETWEEN 0 AND 1)
);
