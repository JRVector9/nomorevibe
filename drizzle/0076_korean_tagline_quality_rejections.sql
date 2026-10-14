ALTER TABLE "product_korean_taglines" ADD COLUMN "quality_rejections" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Older rows retain only the last error and total attempts. This conservative
-- baseline preserves legacy exhaustion; it cannot reconstruct mixed histories.
UPDATE "product_korean_taglines"
SET "quality_rejections" = least("attempts", 4)
WHERE "error_code" LIKE 'rejected:%';
