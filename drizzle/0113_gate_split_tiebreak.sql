-- 2차 갈림 판가름(2026-10-21) — 두 모델 승인 관문에서 1차 승인·2차 반대로 사람에게 넘어온 후보(second_review_split)를
-- gpu3090 Qwen-v2 에 한 번 더 물은 기록(lib/crawl/gate-split-tiebreak.ts). 관문 세대·덧붙임 판마다 한 줄이라 같은 입력을 두 번 묻지 않는다.
-- 새 표 하나와 색인 둘뿐이다. 다른 표를 잠그지 않도록 crawl_candidates 외래 키는 걸지 않는다(second_reviews 와 같다).
-- 다른 가지와 번호가 겹치면 합칠 때 번호만 바꾼다 — IF NOT EXISTS 라 다시 돌려도 된다.
CREATE TABLE IF NOT EXISTS "gate_split_tiebreaks" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"repo" varchar(200) NOT NULL,
	"first_attempt_id" integer,
	"generation_key" varchar(64) NOT NULL,
	"input_hash" varchar(64),
	"source_revision_hash" varchar(64),
	"prompt_version" varchar(40) NOT NULL,
	"model" varchar(160) NOT NULL,
	"state" varchar(20) NOT NULL,
	"decision" varchar(20),
	"confidence" double precision,
	"reason" text,
	"applied" varchar(30),
	"decision_attempt_id" integer,
	"error_code" varchar(60),
	"error_detail" varchar(80),
	"failure_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"lease_token" varchar(80),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"retry_after" timestamp,
	CONSTRAINT "gate_split_tiebreaks_state_check" CHECK ("state" in ('running', 'succeeded', 'failed', 'ineligible')),
	CONSTRAINT "gate_split_tiebreaks_decision_check" CHECK ("decision" is null or "decision" in ('approve', 'reject', 'needs_review')),
	CONSTRAINT "gate_split_tiebreaks_reason_check" CHECK (char_length("reason") <= 2000)
);
--> statement-breakpoint
-- 한 후보·한 관문 세대·한 덧붙임 판에 한 줄 — 같은 입력을 다시 묻지 않는 근거다
CREATE UNIQUE INDEX IF NOT EXISTS "gate_split_tiebreaks_generation_idx" ON "gate_split_tiebreaks" ("candidate_id", "generation_key", "prompt_version");
--> statement-breakpoint
-- 마지막 결과(부르는 곳의 탈이면 잠깐 물러난다)와 심사 큐 머리의 '마지막 오류'
CREATE INDEX IF NOT EXISTS "gate_split_tiebreaks_completed_idx" ON "gate_split_tiebreaks" ("completed_at" DESC);
