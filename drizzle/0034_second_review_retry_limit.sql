ALTER TABLE "second_reviews" ADD COLUMN "error_detail" varchar(80);
--> statement-breakpoint
ALTER TABLE "second_reviews" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;
