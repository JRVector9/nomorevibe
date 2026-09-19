CREATE TABLE "crawl_taglines" (
	"repo" varchar(200) PRIMARY KEY NOT NULL,
	"tagline" varchar(200) DEFAULT '' NOT NULL,
	"source" varchar(8) NOT NULL,
	"model" varchar(160) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"document_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tagline_source" varchar(12) DEFAULT 'maker' NOT NULL;