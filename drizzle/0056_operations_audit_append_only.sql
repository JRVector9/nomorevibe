-- 관리자 작업 로그: 누가(로그인 방식·접속 주소·브라우저) 무엇을 했고 성공했는지까지 남긴다
ALTER TABLE "operations_audit" ADD COLUMN "actor_kind" varchar(12);--> statement-breakpoint
ALTER TABLE "operations_audit" ADD COLUMN "ip" varchar(64);--> statement-breakpoint
ALTER TABLE "operations_audit" ADD COLUMN "user_agent" varchar(300);--> statement-breakpoint
ALTER TABLE "operations_audit" ADD COLUMN "ok" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "operations_audit" ADD COLUMN "error" varchar(300);--> statement-breakpoint
CREATE INDEX "operations_audit_action_created_idx" ON "operations_audit" ("action", "created_at" DESC);--> statement-breakpoint
-- 이미 처리한 내려달라는 요청을 처리 기록으로 옮긴다(덧붙이기만 하므로 아래 트리거 전에 넣는다)
INSERT INTO "operations_audit" ("actor", "actor_kind", "action", "target", "detail", "created_at")
SELECT coalesce("handled_by", 'unknown'), CASE WHEN "handled_by" = 'local' THEN 'local' ELSE 'github' END,
  CASE "outcome" WHEN 'removed' THEN 'takedown-remove' ELSE 'takedown-dismiss' END, "slug",
  jsonb_strip_nulls(jsonb_build_object('requestReason', "reason", 'requestedAt', "requested_at", 'requestCount', "request_count",
    'dismissReason', "dismiss_reason", 'note', "note", 'backfilled', true)),
  "handled_at"
FROM "takedown_requests" WHERE "handled_at" IS NOT NULL AND "outcome" IS NOT NULL;--> statement-breakpoint
-- 지우지 못하는 기록: 고치기·지우기·비우기를 DB가 거부한다. 앱에는 지우는 경로가 없다
CREATE FUNCTION "operations_audit_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operations_audit is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "operations_audit_no_change" BEFORE UPDATE OR DELETE ON "operations_audit"
  FOR EACH ROW EXECUTE FUNCTION "operations_audit_append_only"();--> statement-breakpoint
CREATE TRIGGER "operations_audit_no_truncate" BEFORE TRUNCATE ON "operations_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION "operations_audit_append_only"();
