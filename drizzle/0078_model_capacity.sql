-- Inactive, additive model capacity ledger. No caller, active policy, or provider change.
CREATE TABLE "model_capacity_control" (
  "id" integer DEFAULT 1 PRIMARY KEY NOT NULL,
  "mode" varchar(10) DEFAULT 'disabled' NOT NULL,
  "epoch" bigint DEFAULT 1 NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "policy" jsonb,
  "policy_hash" varchar(64),
  "cursor" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "model_capacity_control_id_check" CHECK ("id" = 1),
  CONSTRAINT "model_capacity_control_mode_check" CHECK ("mode" in ('disabled','open','draining')),
  CONSTRAINT "model_capacity_control_epoch_check" CHECK ("epoch" between 1 and 9007199254740991 and "revision" between 1 and 9007199254740991),
  CONSTRAINT "model_capacity_control_policy_check" CHECK (
    ("policy" is null and "policy_hash" is null and "mode" = 'disabled') or
    ("policy" is not null and jsonb_typeof("policy") = 'object' and "policy_hash" is not null and "policy_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "model_capacity_control_cursor_check" CHECK ("cursor" between 0 and 95)
);
--> statement-breakpoint
CREATE TABLE "model_capacity_requests" (
  "request_id" uuid PRIMARY KEY NOT NULL,
  "queue_ordinal" bigserial NOT NULL,
  "work_key" varchar(160) NOT NULL,
  "owner_instance_id" varchar(120) NOT NULL,
  "owner_boot_id" uuid NOT NULL,
  "class" varchar(10) NOT NULL,
  "pool" varchar(8) NOT NULL,
  "route_id" varchar(120) NOT NULL,
  "provider" varchar(60) NOT NULL,
  "model" varchar(200) NOT NULL,
  "provider_budget_id" varchar(120) NOT NULL,
  "group_id" varchar(120) NOT NULL,
  "epoch" bigint NOT NULL,
  "revision" bigint NOT NULL,
  "policy_hash" varchar(64) NOT NULL,
  "state" varchar(13) NOT NULL,
  "token" uuid,
  "reserved_until" timestamp(3) with time zone,
  "queued_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  "queue_until" timestamp(3) with time zone NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "model_capacity_requests_queue_ordinal_unique" UNIQUE ("queue_ordinal"),
  CONSTRAINT "model_capacity_requests_ordinal_check" CHECK ("queue_ordinal" between 1 and 9007199254740991),
  CONSTRAINT "model_capacity_requests_epoch_check" CHECK ("epoch" between 1 and 9007199254740991 and "revision" between 1 and 9007199254740991),
  CONSTRAINT "model_capacity_requests_class_check" CHECK ("class" in ('first','second','background')),
  CONSTRAINT "model_capacity_requests_pool_check" CHECK ("pool" in ('reviewer','text') and ("class" = 'background' or "pool" = 'reviewer')),
  CONSTRAINT "model_capacity_requests_identity_check" CHECK (
    char_length("work_key") > 0 and "work_key" = btrim("work_key") and "work_key" !~ '[[:cntrl:]]' and
    char_length("owner_instance_id") > 0 and "owner_instance_id" = btrim("owner_instance_id") and "owner_instance_id" !~ '[[:cntrl:]]' and
    char_length("route_id") > 0 and "route_id" = btrim("route_id") and "route_id" !~ '[[:cntrl:]]' and
    char_length("provider") > 0 and "provider" = btrim("provider") and "provider" !~ '[[:cntrl:]]' and
    char_length("model") > 0 and "model" = btrim("model") and "model" !~ '[[:cntrl:]]' and
    char_length("provider_budget_id") > 0 and "provider_budget_id" = btrim("provider_budget_id") and "provider_budget_id" !~ '[[:cntrl:]]' and
    char_length("group_id") > 0 and "group_id" = btrim("group_id") and "group_id" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "model_capacity_requests_hash_check" CHECK ("policy_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "model_capacity_requests_state_check" CHECK ("state" in ('waiting','reserved','dispatched','indeterminate','withdrawn')),
  CONSTRAINT "model_capacity_requests_token_check" CHECK (
    ("token" is null and "reserved_until" is null and "state" in ('waiting','withdrawn')) or
    ("token" is not null and "reserved_until" is not null and "state" in ('reserved','dispatched','indeterminate','withdrawn'))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_capacity_requests_live_work_idx" ON "model_capacity_requests" ("owner_instance_id","owner_boot_id","work_key") WHERE "state" in ('waiting','reserved','dispatched','indeterminate');
--> statement-breakpoint
CREATE INDEX "model_capacity_requests_waiting_idx" ON "model_capacity_requests" ("class","queue_ordinal") WHERE "state" = 'waiting';
--> statement-breakpoint
CREATE INDEX "model_capacity_requests_active_idx" ON "model_capacity_requests" ("provider_budget_id","group_id","pool") WHERE "state" in ('reserved','dispatched','indeterminate');
--> statement-breakpoint
CREATE TABLE "model_capacity_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "request_id" uuid NOT NULL,
  "kind" varchar(32) NOT NULL,
  "epoch" bigint NOT NULL,
  "revision" bigint NOT NULL,
  "policy_hash" varchar(64) NOT NULL,
  "from_state" varchar(13),
  "to_state" varchar(13),
  "reason" varchar(32),
  "created_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "model_capacity_events_request_fk" FOREIGN KEY ("request_id") REFERENCES "model_capacity_requests"("request_id"),
  CONSTRAINT "model_capacity_events_id_check" CHECK ("id" between 1 and 9007199254740991),
  CONSTRAINT "model_capacity_events_epoch_check" CHECK ("epoch" between 1 and 9007199254740991 and "revision" between 1 and 9007199254740991),
  CONSTRAINT "model_capacity_events_hash_check" CHECK ("policy_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "model_capacity_events_kind_check" CHECK ("kind" in ('queued','reserved','dispatch_started','reservation_cancelled','reservation_expired','wait_expired','policy_changed','dispatch_indeterminate')),
  CONSTRAINT "model_capacity_events_state_check" CHECK (
    ("from_state" is null or "from_state" in ('waiting','reserved','dispatched','indeterminate','withdrawn')) and
    ("to_state" is null or "to_state" in ('waiting','reserved','dispatched','indeterminate','withdrawn'))
  ),
  CONSTRAINT "model_capacity_events_reason_check" CHECK ("reason" is null or "reason" in ('transport_unknown','local_abort','process_exit','commit_unknown'))
);
--> statement-breakpoint
CREATE INDEX "model_capacity_events_request_idx" ON "model_capacity_events" ("request_id","id");
--> statement-breakpoint
CREATE FUNCTION "model_capacity_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model_capacity_events_append_only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_capacity_events_no_change"
BEFORE UPDATE OR DELETE ON "model_capacity_events"
FOR EACH STATEMENT EXECUTE FUNCTION "model_capacity_events_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "model_capacity_events_no_truncate"
BEFORE TRUNCATE ON "model_capacity_events"
FOR EACH STATEMENT EXECUTE FUNCTION "model_capacity_events_reject_change"();
--> statement-breakpoint
ALTER TABLE "model_capacity_events" ENABLE ALWAYS TRIGGER "model_capacity_events_no_change";
--> statement-breakpoint
ALTER TABLE "model_capacity_events" ENABLE ALWAYS TRIGGER "model_capacity_events_no_truncate";
--> statement-breakpoint
-- No operational policy or serving/account alias is seeded.
INSERT INTO "model_capacity_control" ("id") VALUES (1);
