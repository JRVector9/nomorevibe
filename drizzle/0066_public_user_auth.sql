CREATE TABLE "public_users" (
  "id" serial PRIMARY KEY,
  "display_name" varchar(80) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "public_identities" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "subject" text NOT NULL,
  "verified_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "public_identities_provider_subject_idx" ON "public_identities" ("provider", "subject");
--> statement-breakpoint
CREATE INDEX "public_identities_user_idx" ON "public_identities" ("user_id");
--> statement-breakpoint
CREATE TABLE "public_sessions" (
  "token_hash" varchar(64) PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "public_sessions_hash_check" CHECK ("token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "public_sessions_user_idx" ON "public_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "public_sessions_expiry_idx" ON "public_sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE "email_login_challenges" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "code_hash" varchar(64) NOT NULL,
  "browser_nonce_hash" varchar(64) NOT NULL,
  "return_to" text NOT NULL DEFAULT '/',
  "attempts" integer NOT NULL DEFAULT 0,
  "delivery_state" varchar(16) NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "email_login_challenges_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5),
  CONSTRAINT "email_login_challenges_code_hash_check" CHECK ("code_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "email_login_challenges_email_idx" ON "email_login_challenges" ("email", "created_at");
--> statement-breakpoint
CREATE INDEX "email_login_challenges_expiry_idx" ON "email_login_challenges" ("expires_at");
