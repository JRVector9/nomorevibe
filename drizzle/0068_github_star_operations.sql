CREATE TABLE "github_star_operations" (
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "repository_id" bigint NOT NULL,
  "product_id" integer NOT NULL,
  "product_repo_url" varchar(512) NOT NULL,
  "state" varchar(24) NOT NULL DEFAULT 'unknown',
  "revision" integer NOT NULL DEFAULT 0,
  "operation_id" uuid,
  "desired_starred" boolean,
  "lease_owner" uuid,
  "lease_expires_at" timestamptz,
  "dispatched_at" timestamptz,
  "reconcile_after" timestamptz,
  "observed_at" timestamptz,
  PRIMARY KEY ("user_id", "repository_id"),
  CONSTRAINT "github_star_operations_state_check" CHECK ("state" in ('starred', 'unstarred', 'unknown', 'needs_reconnect')),
  CONSTRAINT "github_star_operations_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX "github_star_operations_product_idx" ON "github_star_operations" ("user_id", "product_id");
--> statement-breakpoint
CREATE TABLE "github_star_operation_receipts" (
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "repository_id" bigint NOT NULL,
  "product_id" integer NOT NULL,
  "starred" boolean NOT NULL,
  "expected_revision" integer NOT NULL,
  "response" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "operation_id")
);
--> statement-breakpoint
CREATE INDEX "github_star_operation_receipts_created_idx" ON "github_star_operation_receipts" ("created_at");
