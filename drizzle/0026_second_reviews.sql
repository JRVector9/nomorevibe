CREATE TABLE "second_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"repo" varchar(200) NOT NULL,
	"published_slug" varchar(80),
	"trigger" varchar(20) NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_decision" varchar(20) NOT NULL,
	"first_confidence" double precision,
	"input_hash" varchar(64) NOT NULL,
	"model" varchar(160),
	"second_decision" varchar(20),
	"second_confidence" double precision,
	"second_reason" text,
	"error_code" varchar(60),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_by" varchar(120),
	"resolution" varchar(40),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "second_reviews_candidate_input_idx" ON "second_reviews" USING btree ("candidate_id","input_hash");--> statement-breakpoint
CREATE INDEX "second_reviews_status_idx" ON "second_reviews" USING btree ("status","created_at" DESC NULLS LAST);