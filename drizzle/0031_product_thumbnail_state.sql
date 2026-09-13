CREATE TABLE "product_thumbnail_state" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"source_url" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" varchar(120)
);
--> statement-breakpoint
ALTER TABLE "product_thumbnail_state" ADD CONSTRAINT "product_thumbnail_state_slug_products_slug_fk" FOREIGN KEY ("slug") REFERENCES "public"."products"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_thumbnail_retry_idx" ON "product_thumbnail_state" USING btree ("next_attempt_at");