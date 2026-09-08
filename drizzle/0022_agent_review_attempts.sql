CREATE TABLE "crawl_review_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"kind" varchar(24) DEFAULT 'automatic' NOT NULL,
	"state" varchar(20) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"policy_hash" varchar(64) NOT NULL,
	"source_revision_hash" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"prompt_version" varchar(40) NOT NULL,
	"rules_version" varchar(40) NOT NULL,
	"provider" varchar(80),
	"model" varchar(160),
	"attempt_number" integer NOT NULL,
	"reused_from_attempt_id" integer,
	"outcome" jsonb,
	"error_code" varchar(120),
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"actor" varchar(120),
	"reason" varchar(2000),
	"lease_token" varchar(80),
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"retry_after" timestamp,
	"valid_until" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_review_attempts" ADD CONSTRAINT "crawl_review_attempts_candidate_id_crawl_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."crawl_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_review_one_active_idx" ON "crawl_review_attempts" USING btree ("candidate_id") WHERE "crawl_review_attempts"."state" = 'running';--> statement-breakpoint
CREATE INDEX "crawl_review_input_idx" ON "crawl_review_attempts" USING btree ("candidate_id","input_hash","source_revision_hash","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crawl_review_approval_idx" ON "crawl_review_attempts" USING btree ("candidate_id","policy_hash","valid_until") WHERE "crawl_review_attempts"."state" = 'succeeded' AND "crawl_review_attempts"."kind" = 'automatic';