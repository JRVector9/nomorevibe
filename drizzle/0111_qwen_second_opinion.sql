-- Qwen-v2 두 번째 의견(2026-10-21) — gpu3090 Qwen 을 게이트웨이 없이 v2 덧붙임으로 묻는 자동 단계 둘(lib/crawl/audit-second-opinion-auto.ts).
-- 기본값 없는 nullable 열 더하기라 표를 다시 쓰지 않는다(카탈로그만 바꾼다). 다시 돌려도 같다(IF NOT EXISTS).
--
-- 잠금: 0110·0112 와 같은 차례로 감사 표들을 처음에 한 번에 ACCESS EXCLUSIVE 로 잡는다 — 감사 읽기가 잡는 차례인 product_audit_items 가 먼저다.
-- 마이그레이터가 밀린 마이그레이션을 한 트랜잭션으로 돌려 0112 와 함께 돌면 잠금이 그 끝까지 이어진다. 의견 표를 항목보다 먼저 쥐면
-- 항목을 쥔 채 의견을 기다리는 감사 화면 쿼리(listAuditFindings 등)와 엇갈려 교착이 날 수 있다. 0112 가 잡는 시도·감사 표도 같은 줄에 둔다.
-- second_reviews 는 감사 표와 한 쿼리에서 함께 읽히지 않아 따로 잡는다(ALTER 가 잡는다).
-- 앞선 긴 트랜잭션이 표를 쥐고 있으면 scripts/migrate.mjs 의 lock_timeout(10s)이 끊는다 — 런북대로 소비자를 멈춘 뒤 돌리고, 실패하면 다시 돌린다.
LOCK TABLE "product_audit_items", "product_audit_attempts", "product_audit_campaigns", "product_audit_second_opinions" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- 감사 두 번째 의견에 그 의견을 받은 글의 판(qwen-direct-review.ts QWEN_V2_PROMPT_VERSION). grok 일괄은 비어 있다.
-- 같은 (항목, 모델)이라도 판이 바뀌면 다시 묻는다
ALTER TABLE "product_audit_second_opinions" ADD COLUMN IF NOT EXISTS "prompt_version" varchar(40);
--> statement-breakpoint
-- 공개분 2차의 사람 확인 행에 Qwen-v2 가 한 번 더 본 판단 — { by, model, promptVersion, decision, confidence, reason, inputHash, at }.
-- 승인이면 그 행을 사람의 '유지'와 같은 길로 닫고(resolved_by qwen-v2-auto), 거절·판단 보류면 행을 그대로 두고 판단만 적는다
ALTER TABLE "second_reviews" ADD COLUMN IF NOT EXISTS "auto_opinion" jsonb;
