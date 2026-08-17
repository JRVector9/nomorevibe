CREATE TABLE "crawl_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"values" jsonb NOT NULL,
	"updated_by" varchar(120),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
