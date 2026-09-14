ALTER TABLE "second_reviews" ADD COLUMN "first_attempt_id" integer;
--> statement-breakpoint
ALTER TABLE "second_reviews" ADD COLUMN "generation_key" varchar(64) DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
DROP INDEX "second_reviews_candidate_input_model_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "second_reviews_candidate_input_model_idx" ON "second_reviews" ("candidate_id", "input_hash", "model", "generation_key");
