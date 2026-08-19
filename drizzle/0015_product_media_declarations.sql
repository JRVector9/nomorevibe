CREATE TABLE "product_media_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"source_url" varchar(1000) NOT NULL,
	"alt_text" varchar(500) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_declarations_slug_source_idx" ON "product_media_declarations" USING btree ("slug","source_url");--> statement-breakpoint
CREATE INDEX "product_media_declarations_due_idx" ON "product_media_declarations" USING btree ("next_attempt_at","slug");