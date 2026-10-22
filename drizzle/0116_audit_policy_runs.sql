-- 감사 정책 처리(2026-10-22) — 운영자 한 사람이 감사 거절 적체(7,450건, 사람 결정 0)를 한 건씩 누르지 않고 정책으로 닫는다:
-- 거르기를 만들고 → 미리 보고(수·갈래별·표본·건너뛸 것과 까닭) → 수를 적어 적용하고 → 필요하면 그 실행만 되돌린다.
-- 실행 한 번이 product_audit_policy_runs 한 행이고, 그 실행이 손댈 항목마다 product_audit_policy_run_items 한 행이다.
-- 항목 행은 손대기 전 상태(before)와 손댄 뒤 값(after)을 담는다 — 되돌리기는 그 뒤에 바뀌지 않은 항목만 그 상태로 되돌리고 나머지는 까닭을 남긴다.
-- 적용·되돌리기는 항목마다 한 트랜잭션으로 몇십 건씩 나눠 돈다(lib/crawl/audit-policy.ts) — 긴 요청이 끊겨도 반만 적용된 채 숨지 않는다.
--
-- 잠금: 새 표 둘만 만든다. 기존 표(product_audit_items·products)는 잠그지 않는다 — 그래서 run_items 는 product_audit_items 로
-- 외래 키를 걸지 않는다(외래 키를 더하면 감사 잡이 쉬지 않고 쓰는 그 표에 SHARE ROW EXCLUSIVE 를 잡는다). 감사 항목은 지우지 않는 표다.
-- 되돌리기(rollback, 코드를 이전 이미지로 돌린 뒤): DROP TABLE "product_audit_policy_run_items", "product_audit_policy_runs";
-- 다른 표는 이 둘을 읽지 않는다. 이미 적용한 사람 결정·차단·보류는 감사 항목·제품에 남는다(손으로 누른 결정과 같다).
CREATE TABLE IF NOT EXISTS "product_audit_policy_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(20) NOT NULL,
	"action" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"planned" integer DEFAULT 0 NOT NULL,
	"note" varchar(500),
	"created_by" varchar(120) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"applied_at" timestamp,
	"undo_by" varchar(120),
	"undo_started_at" timestamp,
	"undone_at" timestamp,
	CONSTRAINT "product_audit_policy_runs_kind_check" CHECK ("kind" in ('close', 'import', 'extend')),
	CONSTRAINT "product_audit_policy_runs_action_check" CHECK ("action" in ('remove', 'keep', 'release', 'import', 'extend')),
	CONSTRAINT "product_audit_policy_runs_status_check"
		CHECK ("status" in ('staging', 'staged', 'applying', 'applied', 'undoing', 'undone', 'discarded'))
);
--> statement-breakpoint
-- 한 번에 하나만 적용·되돌리기 중이다 — 두 정책이 같은 항목을 엇갈려 쥐지 않고, 두 번 누른 적용이 실행을 둘 만들지 않는다
CREATE UNIQUE INDEX IF NOT EXISTS "product_audit_policy_runs_one_active_idx" ON "product_audit_policy_runs" ((true))
	WHERE "status" in ('applying', 'undoing');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_audit_policy_run_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL REFERENCES "product_audit_policy_runs"("id") ON DELETE cascade,
	"item_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"slug" varchar(80) NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"reason" varchar(60),
	"payload" jsonb,
	"before" jsonb,
	"after" jsonb,
	"applied_at" timestamp,
	"undone_at" timestamp,
	CONSTRAINT "product_audit_policy_run_items_state_check"
		CHECK ("state" in ('pending', 'applied', 'skipped', 'cancelled', 'undone', 'undo_blocked'))
);
--> statement-breakpoint
-- 한 실행에 한 항목은 한 줄 — 같은 항목을 두 번 적용하지 않는다
CREATE UNIQUE INDEX IF NOT EXISTS "product_audit_policy_run_items_run_item_idx" ON "product_audit_policy_run_items" ("run_id", "item_id");
--> statement-breakpoint
-- 나눠 돌기: 그 실행의 남은 것(pending)·되돌릴 것(applied)을 id 순서로
CREATE INDEX IF NOT EXISTS "product_audit_policy_run_items_state_idx" ON "product_audit_policy_run_items" ("run_id", "state", "id");
