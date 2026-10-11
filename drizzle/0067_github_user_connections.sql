CREATE TABLE "github_user_connections" (
  "user_id" integer PRIMARY KEY REFERENCES "public_users"("id") ON DELETE CASCADE,
  "github_user_id" bigint NOT NULL,
  "github_login" varchar(100) NOT NULL,
  "state" varchar(24) NOT NULL,
  "encrypted_access_token" text,
  "encrypted_refresh_token" text,
  "access_expires_at" timestamptz,
  "refresh_expires_at" timestamptz,
  "revision" integer NOT NULL DEFAULT 1,
  "refresh_lease_owner" uuid,
  "refresh_lease_expires_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "github_user_connections_state_check" CHECK ("state" in ('active', 'needs_reconnect', 'revoked')),
  CONSTRAINT "github_user_connections_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_user_connections_github_id_idx" ON "github_user_connections" ("github_user_id");
--> statement-breakpoint
CREATE TABLE "github_auth_flows" (
  "id" uuid PRIMARY KEY,
  "purpose" varchar(16) NOT NULL,
  "actor_user_id" integer REFERENCES "public_users"("id") ON DELETE CASCADE,
  "product_id" integer,
  "state_hash" varchar(64) NOT NULL,
  "browser_nonce_hash" varchar(64) NOT NULL,
  "encrypted_pkce_verifier" text NOT NULL,
  "return_to" text NOT NULL DEFAULT '/',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "github_auth_flows_purpose_check" CHECK ("purpose" in ('star', 'maker') AND ("purpose" <> 'maker' OR ("actor_user_id" IS NOT NULL AND "product_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_auth_flows_state_idx" ON "github_auth_flows" ("state_hash");
--> statement-breakpoint
CREATE INDEX "github_auth_flows_expiry_idx" ON "github_auth_flows" ("expires_at");
