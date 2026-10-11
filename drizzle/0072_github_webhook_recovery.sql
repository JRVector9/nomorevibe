CREATE TABLE "github_webhook_events" (
  "delivery_id" uuid PRIMARY KEY,
  "app" varchar(16) NOT NULL,
  "event" varchar(50) NOT NULL,
  "action" varchar(64) NOT NULL,
  "installation_id" bigint,
  "repository_id" bigint,
  "github_user_id" bigint,
  "issue_id" bigint,
  "issue_number" integer,
  "removed_repository_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "issues_permission" varchar(16),
  "repository_selection" varchar(16),
  "suspended" boolean,
  "payload_hash" varchar(64) NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "github_webhook_events_app_check" CHECK (app IN ('star','feedback')),
  CONSTRAINT "github_webhook_events_ids_check" CHECK ((installation_id IS NULL OR installation_id BETWEEN 1 AND 9007199254740991) AND (repository_id IS NULL OR repository_id BETWEEN 1 AND 9007199254740991) AND (github_user_id IS NULL OR github_user_id BETWEEN 1 AND 9007199254740991) AND (issue_id IS NULL OR issue_id BETWEEN 1 AND 9007199254740991) AND (issue_number IS NULL OR issue_number > 0))
);
--> statement-breakpoint
CREATE INDEX "github_webhook_events_pending_idx" ON "github_webhook_events" ("received_at") WHERE processed_at IS NULL;
--> statement-breakpoint
CREATE TABLE "github_integration_actions" (
  "request_id" uuid PRIMARY KEY,
  "outbox_id" uuid NOT NULL REFERENCES "github_issue_outbox"("id") ON DELETE CASCADE,
  "action" varchar(16) NOT NULL,
  "previous_dispatch_id" uuid NOT NULL,
  "previous_state" varchar(16) NOT NULL,
  "repository_id" bigint NOT NULL,
  "installation_id" bigint NOT NULL,
  "binding_revision" integer NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "admin_login" varchar(120) NOT NULL,
  "reason" text NOT NULL,
  "duplicate_risk_acknowledged" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "github_integration_actions_check" CHECK (action IN ('requery','retransmit') AND (action <> 'retransmit' OR duplicate_risk_acknowledged) AND char_length(btrim(reason)) BETWEEN 1 AND 1000 AND repository_id BETWEEN 1 AND 9007199254740991 AND installation_id BETWEEN 1 AND 9007199254740991 AND binding_revision > 0)
);
--> statement-breakpoint
CREATE INDEX "github_integration_actions_outbox_idx" ON "github_integration_actions" ("outbox_id", "created_at");
--> statement-breakpoint
ALTER TABLE "github_maker_auth_contexts" ADD COLUMN "github_user_id" bigint;
--> statement-breakpoint
ALTER TABLE "github_maker_auth_contexts" ADD CONSTRAINT "github_maker_auth_contexts_user_id_check" CHECK (github_user_id IS NULL OR github_user_id BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE "github_product_bindings" ADD COLUMN "verification_retry_at" timestamptz;
--> statement-breakpoint
CREATE INDEX "github_webhook_events_lifecycle_idx" ON "github_webhook_events" ("installation_id", "received_at") WHERE app = 'feedback';
