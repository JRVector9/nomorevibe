ALTER TABLE "click_events" ADD COLUMN "visitor_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "product_click_daily" ADD COLUMN "unique_visitors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "visit_collection_state" (
	"id" integer DEFAULT 1 PRIMARY KEY NOT NULL,
	"unique_visitor_started_at" timestamp
);--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "unique_visitors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "recent_unique_visitors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD COLUMN "previous_unique_visitors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "click_events_slug_visitor_time_idx" ON "click_events" USING btree ("slug","visitor_hash","occurred_at" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "visit_collection_state" ("id", "unique_visitor_started_at")
VALUES (1, NULL)
ON CONFLICT ("id") DO NOTHING;
