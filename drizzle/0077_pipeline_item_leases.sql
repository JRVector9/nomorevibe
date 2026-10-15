-- Additive ownership foundation only. Existing workers remain on the legacy path.
CREATE TABLE "pipeline_stage_modes" (
  "stage" varchar(8) PRIMARY KEY NOT NULL,
  "mode" varchar(10) DEFAULT 'legacy' NOT NULL,
  "draining_from" varchar(8),
  "epoch" bigint DEFAULT 1 NOT NULL,
  "writer_contract_version" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "pipeline_stage_modes_stage_check" CHECK ("stage" in ('fetch','ai1','ai2')),
  CONSTRAINT "pipeline_stage_modes_mode_check" CHECK ("mode" in ('legacy','draining','items')),
  CONSTRAINT "pipeline_stage_modes_draining_check" CHECK (
    ("mode" = 'draining' and "draining_from" is not null and "draining_from" in ('legacy','items')) or
    ("mode" <> 'draining' and "draining_from" is null)
  ),
  CONSTRAINT "pipeline_stage_modes_epoch_check" CHECK ("epoch" between 1 and 9007199254740991),
  CONSTRAINT "pipeline_stage_modes_contract_check" CHECK ("writer_contract_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pipeline_item_leases" (
  "stage" varchar(8) NOT NULL,
  "work_key" varchar(80) NOT NULL,
  "binding" jsonb NOT NULL,
  "binding_hash" varchar(64) NOT NULL,
  "owner_instance_id" varchar(120),
  "owner_boot_id" uuid,
  "token" uuid,
  "stage_epoch" bigint DEFAULT 1 NOT NULL,
  "item_epoch" bigint DEFAULT 0 NOT NULL,
  "lease_until" timestamp(3) with time zone,
  "created_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT clock_timestamp() NOT NULL,
  PRIMARY KEY ("stage","work_key"),
  CONSTRAINT "pipeline_item_leases_stage_pipeline_stage_modes_stage_fk" FOREIGN KEY ("stage") REFERENCES "pipeline_stage_modes"("stage"),
  CONSTRAINT "pipeline_item_leases_stage_check" CHECK ("stage" in ('fetch','ai1','ai2')),
  CONSTRAINT "pipeline_item_leases_binding_check" CHECK (coalesce(
    jsonb_typeof("binding") = 'object' and "binding"->>'stage' = "stage" and
    "work_key" = "stage" || ':' || case "stage"
      when 'fetch' then "binding"->>'frontierId'
      when 'ai1' then "binding"->>'candidateId'
      when 'ai2' then "binding"->>'secondReviewId'
    end, false)),
  CONSTRAINT "pipeline_item_leases_hash_check" CHECK ("binding_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "pipeline_item_leases_owner_check" CHECK (
    ("owner_instance_id" is null and "owner_boot_id" is null and "token" is null and "lease_until" is null) or
    ("owner_instance_id" is not null and char_length(btrim("owner_instance_id")) > 0 and "owner_boot_id" is not null and
      "token" is not null and "lease_until" is not null and "item_epoch" >= 1)
  ),
  CONSTRAINT "pipeline_item_leases_epoch_check" CHECK (
    "stage_epoch" between 1 and 9007199254740991 and "item_epoch" between 0 and 9007199254740991
  )
);
--> statement-breakpoint
CREATE INDEX "pipeline_item_leases_expiry_idx" ON "pipeline_item_leases" ("stage","lease_until","work_key") WHERE "token" is not null;
--> statement-breakpoint
-- PR02 exposes no API to raise this version or enable a production consumer.
INSERT INTO "pipeline_stage_modes" ("stage") VALUES ('fetch'),('ai1'),('ai2');
