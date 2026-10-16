-- PR15: single writer fence, manual promotion records and process-group exit evidence.
-- New tables only. Existing writers, permits, modes and CHECK constraints are unchanged.
CREATE TABLE dr_writer_fence (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
 lineage_id uuid NOT NULL,
 writer_epoch bigint NOT NULL DEFAULT 1 CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
 state varchar(8) NOT NULL DEFAULT 'active' CHECK (state IN ('active','fenced')),
 reason varchar(24) CHECK (reason IN ('operator_fence','promotion_sealed')),
 fenced_db jsonb,
 promotion_id uuid,
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT dr_writer_fence_fenced_check CHECK ((state = 'active' AND reason IS NULL AND fenced_db IS NULL)
   OR (state = 'fenced' AND reason IS NOT NULL AND jsonb_typeof(fenced_db) = 'object')),
 CONSTRAINT dr_writer_fence_promotion_check CHECK (reason IS DISTINCT FROM 'promotion_sealed' OR promotion_id IS NOT NULL)
);
INSERT INTO dr_writer_fence (id, lineage_id) VALUES (1, gen_random_uuid());
--> statement-breakpoint
CREATE TABLE dr_fence_events (
 id bigserial PRIMARY KEY,
 lineage_id uuid NOT NULL,
 from_epoch bigint NOT NULL CHECK (from_epoch BETWEEN 1 AND 9007199254740991),
 to_epoch bigint NOT NULL CHECK (to_epoch BETWEEN 1 AND 9007199254740991),
 from_state varchar(8) NOT NULL CHECK (from_state IN ('active','fenced')),
 to_state varchar(8) NOT NULL CHECK (to_state IN ('active','fenced')),
 reason varchar(24) NOT NULL CHECK (reason IN ('operator_fence','promotion_sealed','promotion_activated')),
 db_identity jsonb NOT NULL CHECK (jsonb_typeof(db_identity) = 'object'),
 promotion_id uuid,
 operator varchar(120) NOT NULL CHECK (char_length(btrim(operator)) > 0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT dr_fence_events_transition_check CHECK (
   (reason = 'operator_fence' AND from_state = 'active' AND to_state = 'fenced' AND to_epoch = from_epoch)
   OR (reason = 'promotion_sealed' AND to_state = 'fenced' AND to_epoch = from_epoch AND promotion_id IS NOT NULL)
   OR (reason = 'promotion_activated' AND from_state = 'fenced' AND to_state = 'active' AND to_epoch = from_epoch + 1 AND promotion_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE dr_promotions (
 promotion_id uuid PRIMARY KEY,
 lineage_id uuid NOT NULL,
 from_epoch bigint NOT NULL CHECK (from_epoch BETWEEN 1 AND 9007199254740990),
 to_epoch bigint NOT NULL,
 state varchar(10) NOT NULL CHECK (state IN ('sealed','promoted')),
 plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
 plan_hash varchar(64) NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
 db_identity jsonb NOT NULL CHECK (jsonb_typeof(db_identity) = 'object'),
 seal_snapshot jsonb NOT NULL CHECK (jsonb_typeof(seal_snapshot) = 'object'),
 operator varchar(120) NOT NULL CHECK (char_length(btrim(operator)) > 0),
 sealed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 promoted_at timestamptz(3),
 CONSTRAINT dr_promotions_epoch_check CHECK (to_epoch = from_epoch + 1),
 CONSTRAINT dr_promotions_promoted_check CHECK ((state = 'promoted') = (promoted_at IS NOT NULL))
);
CREATE UNIQUE INDEX dr_promotions_lineage_epoch_idx ON dr_promotions (lineage_id, to_epoch);
--> statement-breakpoint
CREATE TABLE dr_promotion_evidence (
 id bigserial PRIMARY KEY,
 promotion_id uuid NOT NULL REFERENCES dr_promotions(promotion_id),
 kind varchar(32) NOT NULL CHECK (kind IN ('old_db_fenced','old_db_isolated','writer_process_stopped','provider_deadline',
   'independent_budget','external_effects_reconciled','http_hops_released')),
 subject varchar(200) NOT NULL CHECK (char_length(btrim(subject)) > 0),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 payload_hash varchar(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 operator varchar(120) NOT NULL CHECK (char_length(btrim(operator)) > 0),
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX dr_promotion_evidence_promotion_idx ON dr_promotion_evidence (promotion_id, kind, subject, id);
--> statement-breakpoint
CREATE TABLE dr_process_group_events (
 id bigserial PRIMARY KEY,
 owner_instance_id varchar(120) NOT NULL CHECK (char_length(btrim(owner_instance_id)) > 0),
 owner_boot_id uuid NOT NULL,
 kind varchar(16) NOT NULL CHECK (kind IN ('owner_opened','spawn_intent','spawned','group_exited')),
 seq integer NOT NULL CHECK (seq >= 0),
 run_id uuid,
 pid integer CHECK (pid IS NULL OR pid > 1),
 method varchar(32) CHECK (method IS NULL OR method = 'pgid_esrch_after_sigkill'),
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT dr_process_group_events_shape_check CHECK (
   (kind = 'owner_opened' AND seq = 0 AND run_id IS NULL AND pid IS NULL AND method IS NULL)
   OR (kind = 'spawn_intent' AND seq >= 1 AND run_id IS NOT NULL AND pid IS NULL AND method IS NULL)
   OR (kind = 'spawned' AND seq >= 1 AND run_id IS NOT NULL AND pid IS NOT NULL AND method IS NULL)
   OR (kind = 'group_exited' AND seq >= 1 AND run_id IS NOT NULL AND pid IS NOT NULL AND method IS NOT NULL))
);
CREATE UNIQUE INDEX dr_process_group_events_once_idx ON dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq);
--> statement-breakpoint
CREATE FUNCTION dr_evidence_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'dr_evidence_append_only' USING ERRCODE = '55000'; END $$;
--> statement-breakpoint
CREATE TRIGGER dr_fence_events_no_change BEFORE UPDATE OR DELETE ON dr_fence_events FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
CREATE TRIGGER dr_fence_events_no_truncate BEFORE TRUNCATE ON dr_fence_events FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
ALTER TABLE dr_fence_events ENABLE ALWAYS TRIGGER dr_fence_events_no_change;
ALTER TABLE dr_fence_events ENABLE ALWAYS TRIGGER dr_fence_events_no_truncate;
CREATE TRIGGER dr_promotion_evidence_no_change BEFORE UPDATE OR DELETE ON dr_promotion_evidence FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
CREATE TRIGGER dr_promotion_evidence_no_truncate BEFORE TRUNCATE ON dr_promotion_evidence FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
ALTER TABLE dr_promotion_evidence ENABLE ALWAYS TRIGGER dr_promotion_evidence_no_change;
ALTER TABLE dr_promotion_evidence ENABLE ALWAYS TRIGGER dr_promotion_evidence_no_truncate;
CREATE TRIGGER dr_process_group_events_no_change BEFORE UPDATE OR DELETE ON dr_process_group_events FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
CREATE TRIGGER dr_process_group_events_no_truncate BEFORE TRUNCATE ON dr_process_group_events FOR EACH STATEMENT EXECUTE FUNCTION dr_evidence_reject_change();
ALTER TABLE dr_process_group_events ENABLE ALWAYS TRIGGER dr_process_group_events_no_change;
ALTER TABLE dr_process_group_events ENABLE ALWAYS TRIGGER dr_process_group_events_no_truncate;
