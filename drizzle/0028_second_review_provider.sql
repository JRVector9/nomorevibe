DROP INDEX "second_reviews_candidate_input_idx";--> statement-breakpoint
ALTER TABLE "second_reviews" ADD COLUMN "provider" varchar(20);--> statement-breakpoint
--> 지금까지의 2차는 모두 Claude CLI 였다. 새 유일 색인이 모델을 포함하므로, 아직 안 본 행의
--> 빈 model 을 지금 설정값으로 채운다 — 비워 두면 NULL 이 서로 달라 같은 후보가 다시 올라온다.
UPDATE "second_reviews" SET "provider" = 'claude-cli' WHERE "provider" IS NULL;--> statement-breakpoint
UPDATE "second_reviews" SET "model" = coalesce((SELECT "values"->'secondReview'->>'model' FROM "crawl_settings" LIMIT 1), 'opus') WHERE "model" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "second_reviews_candidate_input_model_idx" ON "second_reviews" USING btree ("candidate_id","input_hash","model");
