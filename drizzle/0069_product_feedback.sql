CREATE TABLE "product_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "author_user_id" integer NOT NULL REFERENCES "public_users"("id"),
  "request_id" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "normalized_body_hash" varchar(64) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "title" varchar(120) NOT NULL,
  "body" text NOT NULL,
  "service_disclosure_consent" boolean NOT NULL,
  "send_to_github" boolean DEFAULT false NOT NULL,
  "github_disclosure_consent" boolean DEFAULT false NOT NULL,
  "github_delivery_eligible" boolean DEFAULT false NOT NULL,
  "review_state" varchar(16) NOT NULL,
  "review_reason" varchar(1000),
  "reviewed_by" varchar(120),
  "reviewed_at" timestamp with time zone,
  "delivery_state" varchar(16) DEFAULT 'local_only' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_feedback_kind_check" CHECK ("kind" in ('bug', 'feature', 'question')),
  CONSTRAINT "product_feedback_review_check" CHECK ("review_state" in ('accepted', 'held', 'rejected')),
  CONSTRAINT "product_feedback_text_check" CHECK (char_length(btrim("title")) >= 1 and char_length("body") <= 5000 and char_length(btrim("body")) >= 1),
  CONSTRAINT "product_feedback_consent_check" CHECK ("service_disclosure_consent" and (not "send_to_github" or "github_disclosure_consent"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_feedback_author_request_idx" ON "product_feedback" ("author_user_id", "request_id");
--> statement-breakpoint
CREATE INDEX "product_feedback_public_idx" ON "product_feedback" ("product_id", "created_at") WHERE "review_state" = 'accepted';
--> statement-breakpoint
CREATE INDEX "product_feedback_author_created_idx" ON "product_feedback" ("author_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "product_feedback_repeat_idx" ON "product_feedback" ("author_user_id", "product_id", "normalized_body_hash", "created_at");
