CREATE TABLE "news_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_key" varchar(60) NOT NULL,
	"url" varchar(1000) NOT NULL,
	"title" varchar(300) NOT NULL,
	"summary" text,
	"published_at" timestamp NOT NULL,
	"state" varchar(20) NOT NULL,
	"decided_by" varchar(120) NOT NULL,
	"decided_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_items_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE INDEX "news_items_state_published_idx" ON "news_items" USING btree ("state","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "news_items_source_published_idx" ON "news_items" USING btree ("source_key","published_at" DESC NULLS LAST);