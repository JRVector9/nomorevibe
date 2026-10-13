CREATE TABLE "product_translations" (
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "locale" varchar(16) NOT NULL,
  "field" varchar(16) NOT NULL,
  "source_hash" varchar(64) NOT NULL,
  "source_locale" varchar(16),
  "text" text,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "provenance" jsonb NOT NULL,
  "model" varchar(160) NOT NULL DEFAULT '',
  "attempts" integer NOT NULL DEFAULT 0,
  "error_code" varchar(60),
  "retry_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "product_translations_product_id_locale_field_pk" PRIMARY KEY ("product_id", "locale", "field"),
  CONSTRAINT "product_translations_locale_check" CHECK (locale IN ('en', 'zh-Hans', 'zh-Hant')),
  CONSTRAINT "product_translations_field_check" CHECK (field IN ('tagline', 'description')),
  CONSTRAINT "product_translations_status_check" CHECK (status IN ('pending', 'ready', 'failed', 'reviewed')),
  CONSTRAINT "product_translations_source_locale_check" CHECK (source_locale IS NULL OR source_locale IN ('ko', 'en', 'zh-Hans', 'zh-Hant')),
  CONSTRAINT "product_translations_value_check" CHECK (source_hash ~ '^[0-9a-f]{64}$' AND attempts >= 0
    AND ((status IN ('ready', 'reviewed') AND text IS NOT NULL AND length(btrim(text)) > 0 AND error_code IS NULL)
      OR (status IN ('pending', 'failed') AND text IS NULL)))
);
--> statement-breakpoint
CREATE INDEX "product_translations_pending_idx" ON "product_translations" ("retry_at", "updated_at", "product_id")
WHERE status IN ('pending', 'failed');
