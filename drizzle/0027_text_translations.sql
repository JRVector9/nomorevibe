CREATE TABLE "text_translations" (
	"source_hash" varchar(64) NOT NULL,
	"target_lang" varchar(8) DEFAULT 'ko' NOT NULL,
	"translated" text,
	"status" varchar(12) NOT NULL,
	"model" varchar(160),
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "text_translations_source_hash_target_lang_pk" PRIMARY KEY("source_hash","target_lang")
);
--> statement-breakpoint
CREATE INDEX "text_translations_updated_idx" ON "text_translations" USING btree ("status","updated_at" DESC NULLS LAST);