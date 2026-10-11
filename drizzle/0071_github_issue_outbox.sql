CREATE TABLE "github_issue_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "feedback_id" uuid NOT NULL REFERENCES "product_feedback"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "repository_id" bigint NOT NULL,
  "repository_full_name" varchar(160) NOT NULL,
  "repository_url" text NOT NULL,
  "installation_id" bigint NOT NULL,
  "binding_revision" integer NOT NULL,
  "feedback_request_hash" varchar(64) NOT NULL,
  "payload_title" varchar(120) NOT NULL,
  "payload_body" text NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "dispatch_id" uuid NOT NULL,
  "state" varchar(16) DEFAULT 'queued' NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "attempt_id" uuid,
  "attempts" integer DEFAULT 0 NOT NULL,
  "dispatched_at" timestamp with time zone,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error_code" varchar(100),
  "github_issue_id" bigint,
  "github_issue_number" integer,
  "github_issue_url" text,
  "external_issue_state" varchar(16) DEFAULT 'unknown' NOT NULL,
  "last_checked_at" timestamp with time zone,
  "reconcile_page" integer DEFAULT 1 NOT NULL,
  "reconcile_matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_issue_outbox_state_check" CHECK ("state" in ('queued','sending','delivered','retry_wait','uncertain','blocked','cancelled')),
  CONSTRAINT "github_issue_outbox_target_check" CHECK ("repository_id" between 1 and 9007199254740991 and "installation_id" between 1 and 9007199254740991 and "binding_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_issue_outbox_feedback_idx" ON "github_issue_outbox" ("feedback_id");
--> statement-breakpoint
CREATE INDEX "github_issue_outbox_due_idx" ON "github_issue_outbox" ("state", "available_at");
--> statement-breakpoint
CREATE INDEX "github_issue_outbox_target_idx" ON "github_issue_outbox" ("repository_id", "created_at");
