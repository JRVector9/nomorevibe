CREATE TABLE "github_collector_accounts" (
  "user_id" bigint PRIMARY KEY,
  "login" varchar(100) NOT NULL,
  "encrypted_token" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "core_quota" jsonb,
  "quota_observed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
