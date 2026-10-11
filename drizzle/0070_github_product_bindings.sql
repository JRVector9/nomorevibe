CREATE TABLE "github_product_bindings" (
  "product_id" integer PRIMARY KEY REFERENCES "products"("id") ON DELETE CASCADE,
  "repository_id" bigint NOT NULL,
  "repository_full_name" varchar(140) NOT NULL,
  "repository_url" text NOT NULL,
  "product_repo_url" text NOT NULL,
  "installation_id" bigint NOT NULL,
  "consented_by_user_id" integer NOT NULL REFERENCES "public_users"("id"),
  "revision" integer NOT NULL DEFAULT 1,
  "enabled" boolean NOT NULL DEFAULT false,
  "blocked_reason" varchar(80),
  "last_verified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "github_product_bindings_ids_check" CHECK (repository_id > 0 AND repository_id <= 9007199254740991 AND installation_id > 0 AND installation_id <= 9007199254740991 AND revision > 0)
);
--> statement-breakpoint
CREATE INDEX "github_product_bindings_installation_idx" ON "github_product_bindings" ("installation_id");
--> statement-breakpoint
CREATE TABLE "github_maker_auth_contexts" (
  "flow_id" uuid PRIMARY KEY REFERENCES "github_auth_flows"("id") ON DELETE CASCADE,
  "actor_user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "repository_id" bigint NOT NULL,
  "product_repo_url" text NOT NULL,
  "edit_token_hash" varchar(64) NOT NULL,
  "expected_revision" integer NOT NULL,
  "browser_nonce_hash" varchar(64) NOT NULL,
  "session_token_hash" varchar(64) NOT NULL,
  "setup_state_hash" varchar(64) UNIQUE,
  "encrypted_user_token" text,
  "state" varchar(20) NOT NULL DEFAULT 'authorizing',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "github_maker_auth_contexts_id_check" CHECK (repository_id > 0 AND repository_id <= 9007199254740991 AND expected_revision >= 0),
  CONSTRAINT "github_maker_auth_contexts_state_check" CHECK (state IN ('authorizing','awaiting_setup','verifying','completed','failed','expired'))
);
--> statement-breakpoint
CREATE INDEX "github_maker_auth_contexts_expiry_idx" ON "github_maker_auth_contexts" ("expires_at");
