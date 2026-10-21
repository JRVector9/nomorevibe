-- Qwen-v2 두 번째 의견(2026-10-21) — gpu3090 Qwen 을 게이트웨이 없이 v2 덧붙임으로 묻는 자동 단계 둘(lib/crawl/audit-second-opinion-auto.ts).
-- 기본값 없는 nullable 열 더하기라 표를 다시 쓰지 않는다(카탈로그만 바꾼다). 두 표를 함께 읽는 쿼리가 없어 표마다 따로 잠가도 순환하지 않는다.
-- 잠금은 이 파일이 끝날 때까지 — 앞선 긴 트랜잭션이 표를 쥐고 있으면 scripts/migrate.mjs 의 lock_timeout(10s)이 끊는다. 런북대로 소비자를 멈춘 뒤 돌린다.
--
-- 감사 두 번째 의견에 그 의견을 받은 글의 판(qwen-direct-review.ts QWEN_V2_PROMPT_VERSION). grok 일괄은 비어 있다.
-- 같은 (항목, 모델)이라도 판이 바뀌면 다시 묻는다
ALTER TABLE "product_audit_second_opinions" ADD COLUMN "prompt_version" varchar(40);
--> statement-breakpoint
-- 공개분 2차의 사람 확인 행에 Qwen-v2 가 한 번 더 본 판단 — { by, model, promptVersion, decision, confidence, reason, inputHash, at }.
-- 승인이면 그 행을 사람의 '유지'와 같은 길로 닫고(resolved_by qwen-v2-auto), 거절·판단 보류면 행을 그대로 두고 판단만 적는다
ALTER TABLE "second_reviews" ADD COLUMN "auto_opinion" jsonb;
