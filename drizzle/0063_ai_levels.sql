-- AI 제작 근거 단계(2026-10-10 운영자 결정) — 저장소마다 1·2·3단계를 판정해 적고(repository_ai_levels), 공개 목록이 거를 수 있게
-- 제품에 그 단계를 옮겨 적는다(products.ai_level). 1 AI 에이전트 앱이 연 PR 이 기본 브랜치에 병합 · 2 AI 도구 서명이 있는 개발 커밋 ·
-- 3 AI 도구 전용 설정 파일. NULL 은 검사 전이거나 1~3단계 근거가 없다는 뜻이다(검사했는지는 repository_ai_levels 에 행이 있는지로 본다).
-- 표와 열만 만든다. 채우는 일은 ai-level-refresh 잡이 한다. 옛 웹·워커는 이 표와 열을 모르고 그대로 돈다
CREATE TABLE IF NOT EXISTS "repository_ai_levels" (
	"repository_key" varchar(200) PRIMARY KEY NOT NULL,
	"level" smallint,
	"clients" text[] DEFAULT '{}' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules_version" varchar(40) NOT NULL,
	"head_sha" varchar(64),
	"checked_at" timestamp NOT NULL,
	"next_check_at" timestamp NOT NULL,
	"last_error" varchar(60),
	CONSTRAINT "repository_ai_levels_level_check" CHECK ("level" IS NULL OR "level" BETWEEN 1 AND 3)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_ai_levels_due_idx" ON "repository_ai_levels" USING btree ("next_check_at");--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ai_level" smallint;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_ai_level_idx" ON "products" USING btree ("ai_level") WHERE "ai_level" IS NOT NULL;
