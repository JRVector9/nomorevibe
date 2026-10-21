-- 남은 감사 모델 바꾸기(2026-10-21 사용자 지시) — 진행 중인 감사의 아직 답이 없는 항목을 다른 심사자(gpu3090 Qwen 직접, qwen-v2)로 묻는다.
-- 감사가 시작할 때 굳힌 제공자·모델(provider·model)은 그대로 둔다 — 그 감사가 무엇으로 시작했는지의 기록이다. 바꾼 뒤 새로 묻는 심사자는
-- current_* 에, 언제·누가 바꿨는지는 switched_* 에 적는다(작업 로그 operations_audit 에도 사유와 함께 한 줄). 이미 답한 항목은 그대로다.
-- 한 감사에 두 모델의 답이 섞이므로 답마다 누가 답했는지를 남긴다: 항목의 ai_provider·ai_model(답을 적을 때), 시도의 prompt_version.
-- 옛 행은 모두 비어 있다 — 비어 있으면 그 감사의 provider·model·prompt_version 이 답했다(이 열 전에는 감사 안에서 심사자가 바뀌지 않았다).
-- 그래서 옛 행을 채우지 않는다(수만 행을 다시 쓰며 잠금을 오래 쥐지 않는다). 읽는 곳이 coalesce(항목, 감사)로 읽는다.
--
-- 잠금: 0110 과 같은 까닭으로 세 표를 처음에 한 번에 ACCESS EXCLUSIVE 로 잡는다(0111 과 함께 돌면 0111 이 이미 같은 차례로 쥐고 있다) — 감사 쓰기(recordAuditResult)가 잡는 차례인
-- product_audit_items → product_audit_attempts, 보류 조건이 읽는 product_audit_items → product_audit_campaigns 순서다.
-- 기본값 없는 nullable 열 더하기는 표를 다시 쓰지 않는다(카탈로그만 바꾼다). 앞선 긴 트랜잭션이 셋 중 하나를 쥐고 있으면
-- scripts/migrate.mjs 의 lock_timeout(10s)이 끊고 마이그레이션이 실패한다 — 런북대로 소비자를 멈춘 뒤 돌리고, 실패하면 다시 돌린다.
LOCK TABLE "product_audit_items", "product_audit_attempts", "product_audit_campaigns" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "product_audit_campaigns" ADD COLUMN IF NOT EXISTS "current_provider" varchar(80);
--> statement-breakpoint
ALTER TABLE "product_audit_campaigns" ADD COLUMN IF NOT EXISTS "current_model" varchar(160);
--> statement-breakpoint
ALTER TABLE "product_audit_campaigns" ADD COLUMN IF NOT EXISTS "switched_at" timestamp;
--> statement-breakpoint
ALTER TABLE "product_audit_campaigns" ADD COLUMN IF NOT EXISTS "switched_by" varchar(120);
--> statement-breakpoint
-- 이 답을 낸 심사자 — 같은 모델에 두 번째 의견을 묻지 않는 규칙과 모델별 보류 규칙(second-opinion-rules.ts)이 읽는다
ALTER TABLE "product_audit_items" ADD COLUMN IF NOT EXISTS "ai_provider" varchar(80);
--> statement-breakpoint
ALTER TABLE "product_audit_items" ADD COLUMN IF NOT EXISTS "ai_model" varchar(160);
--> statement-breakpoint
-- 이 호출이 쓴 글의 판 — Qwen 직접 심사는 정책 글 뒤에 v2 덧붙임을 붙인다(QWEN_V2_PROMPT_VERSION)
ALTER TABLE "product_audit_attempts" ADD COLUMN IF NOT EXISTS "prompt_version" varchar(40);
