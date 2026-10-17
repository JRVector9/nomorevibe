-- PR01b-8: append-only evidence ledger for the throughput judgement. New table only; existing tables, CHECKs and writers' guards are unchanged.
-- Writers insert nothing until an operator records the single 'recorder_started' marker. No FK: candidate/review rows stay deletable.
CREATE TABLE pipeline_evidence_events (
 id bigserial PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
 kind varchar(28) NOT NULL CHECK (kind IN ('recorder_started','human_decision_refused','human_decision_overridden',
   'late_write_refused','lease_violation','ai2_attempt')),
 stage varchar(3) CHECK (stage IN ('ai1','ai2')),
 candidate_id integer CHECK (candidate_id > 0),
 first_attempt_id integer CHECK (first_attempt_id > 0),
 second_review_id integer CHECK (second_review_id > 0),
 root_review_id integer CHECK (root_review_id > 0),
 failed boolean,
 code varchar(60) CHECK (char_length(btrim(code)) > 0),
 revision varchar(40) CHECK (revision ~ '^[a-f0-9]{7,40}$'),
 operator varchar(120) CHECK (char_length(btrim(operator)) > 0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT pipeline_evidence_events_shape_check CHECK (
   (kind = 'recorder_started' AND stage IS NULL AND revision IS NOT NULL AND operator IS NOT NULL)
   OR (kind IN ('human_decision_refused','human_decision_overridden') AND stage IS NOT NULL AND candidate_id IS NOT NULL
     AND revision IS NULL AND operator IS NULL)
   OR (kind IN ('late_write_refused','lease_violation') AND stage IS NOT NULL AND code IS NOT NULL
     AND (first_attempt_id IS NOT NULL OR second_review_id IS NOT NULL) AND revision IS NULL AND operator IS NULL)
   OR (kind = 'ai2_attempt' AND stage = 'ai2' AND second_review_id IS NOT NULL AND root_review_id IS NOT NULL AND failed IS NOT NULL
     AND revision IS NULL AND operator IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX pipeline_evidence_events_marker_idx ON pipeline_evidence_events (kind) WHERE kind = 'recorder_started';
--> statement-breakpoint
CREATE INDEX pipeline_evidence_events_created_idx ON pipeline_evidence_events (created_at);
--> statement-breakpoint
CREATE FUNCTION pipeline_evidence_events_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pipeline_evidence_events_append_only' USING ERRCODE = '55000'; END $$;
--> statement-breakpoint
CREATE TRIGGER pipeline_evidence_events_no_change BEFORE UPDATE OR DELETE ON pipeline_evidence_events
FOR EACH STATEMENT EXECUTE FUNCTION pipeline_evidence_events_reject_change();
--> statement-breakpoint
CREATE TRIGGER pipeline_evidence_events_no_truncate BEFORE TRUNCATE ON pipeline_evidence_events
FOR EACH STATEMENT EXECUTE FUNCTION pipeline_evidence_events_reject_change();
--> statement-breakpoint
ALTER TABLE pipeline_evidence_events ENABLE ALWAYS TRIGGER pipeline_evidence_events_no_change;
--> statement-breakpoint
ALTER TABLE pipeline_evidence_events ENABLE ALWAYS TRIGGER pipeline_evidence_events_no_truncate;
