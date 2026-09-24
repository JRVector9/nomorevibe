CREATE TABLE "product_intro_checks" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"checked_tagline" varchar(200) NOT NULL,
	"verdict" varchar(16),
	"problem" text DEFAULT '' NOT NULL,
	"corrected" varchar(200) DEFAULT '' NOT NULL,
	"outcome" varchar(16),
	"original_tagline" varchar(200),
	"original_source" varchar(12),
	"original_description" text,
	"model" varchar(160) DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_intro_checks" ADD CONSTRAINT "product_intro_checks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;