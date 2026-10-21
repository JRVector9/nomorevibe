-- 2차 갈림 판가름의 DeepSeek 확인(2026-10-21, 사용자 결정 2안) — Qwen-v2 거부(확신 0.90 이상·다수·카탈로그 아님)만으로는 닫지 않고,
-- M3 DeepSeek 이 같은 관문 입력으로 따로 거부(원래 확신 0.70 이상)해야 닫는다(lib/crawl/gate-split-confirm.ts).
-- 첫 단계(2차 잡)는 Qwen-v2 의 답을 적고 applied = 'awaiting_deepseek' 로 둔다. 둘째 단계(사람 검토 잡 human-deepseek-review — M3 를 쓰는
-- 유일한 잡)가 DeepSeek 에 묻고 이 열들에 적는다.
-- 0113 이 만든 새 표에 기본값 없는 nullable 열(과 상수 기본값 열 하나) 더하기라 표를 다시 쓰지 않는다. 다시 돌려도 같다(IF NOT EXISTS).
-- 다른 표는 건드리지 않는다.
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "qwen_outcome" jsonb;
--> statement-breakpoint
-- DeepSeek 확인 — null(확인할 것이 아님) · waiting(차례를 기다림) · running(묻는 중) · succeeded(답을 받음) · failed(실패 — retry 뒤 다시)
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_state" varchar(20);
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_model" varchar(160);
--> statement-breakpoint
-- DeepSeek 의 원래 답(0.90 문턱을 걸기 전) — { decision, reason, evidenceIds, confidence }
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_outcome" jsonb;
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_error_code" varchar(60);
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_error_detail" varchar(80);
--> statement-breakpoint
-- 항목 탓 실패만 센다 — 부르는 곳이 탈 난 실패(시간 초과·연결·5xx)와 멈춤은 세지 않는다
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_failure_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_latency_ms" integer;
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_lease_token" varchar(80);
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_started_at" timestamp;
--> statement-breakpoint
-- 확인을 마친 때 — 하루 자동 거부 상한(KST 0시부터)도 이 시각으로 센다
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_completed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "gate_split_tiebreaks" ADD COLUMN IF NOT EXISTS "deepseek_retry_after" timestamp;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gate_split_tiebreaks" ADD CONSTRAINT "gate_split_tiebreaks_deepseek_state_check"
    CHECK ("deepseek_state" is null or "deepseek_state" in ('waiting', 'running', 'succeeded', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- 확인을 기다리는 줄(둘째 단계의 차례)과 오늘 자동 거부 수
CREATE INDEX IF NOT EXISTS "gate_split_tiebreaks_deepseek_idx" ON "gate_split_tiebreaks" ("deepseek_state", "deepseek_retry_after")
  WHERE "deepseek_state" is not null;
