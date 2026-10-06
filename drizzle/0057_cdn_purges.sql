-- Cloudflare 에서 지울 제품: 공개 제품이 내려가거나 지워지면 같은 트랜잭션에서 적는다(발행 워커가 지운다)
CREATE TABLE "cdn_purges" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"reason" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"purged_at" timestamp,
	"confirmed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(300)
);--> statement-breakpoint
CREATE INDEX "cdn_purges_pending_idx" ON "cdn_purges" ("id") WHERE confirmed_at is null;--> statement-breakpoint
-- 내리는 길이 여럿이라(관리자 차단·내려달라는 요청·감사·재검토) 앱이 아니라 DB 가 적는다
CREATE FUNCTION "products_queue_cdn_purge"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('verified', 'seeded') AND (TG_OP = 'DELETE' OR NEW."status" NOT IN ('verified', 'seeded')) THEN
    INSERT INTO "cdn_purges" ("slug", "reason")
    VALUES (OLD."slug", CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE NEW."status" END);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "products_cdn_purge" AFTER UPDATE OF "status" OR DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "products_queue_cdn_purge"();
