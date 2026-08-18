CREATE TABLE "click_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "click_events_slug_time_idx" ON "click_events" USING btree ("slug","occurred_at" DESC NULLS LAST);