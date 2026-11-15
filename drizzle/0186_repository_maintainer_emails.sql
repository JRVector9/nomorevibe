-- 0186: 저장소 커밋 작성자 이메일 — 관리자 전용 비공개 표(2026-11-15 운영자 결정).
-- ai-level-refresh 잡(M3 crawler, 소유 계정)이 이미 읽는 최근 커밋 30개에서 사람 주소만 남긴다. 나중에 프로젝트 관리자에게 프로젝트 상황을 알리기 위함이다.
-- 공개 화면·공개 API·탐색 캐시는 이 표를 읽지 않는다. Oracle 최소 권한 계정에는 GRANT 하지 않는다(읽거나 쓸 일이 없다).
-- 새 표만 만든다. 옛 웹·워커는 이 표를 모르고 그대로 돈다(잡이 쓰기 전에는 비어 있다).
CREATE TABLE IF NOT EXISTS "repository_maintainer_emails" (
	"repository_key" varchar(200) NOT NULL,
	"email" varchar(254) NOT NULL,
	"author_name" varchar(200),
	"author_login" varchar(100),
	"commit_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repository_maintainer_emails_pkey" PRIMARY KEY ("repository_key", "email"),
	CONSTRAINT "repository_maintainer_emails_email_check" CHECK ("email" = lower("email") AND position('@' in "email") > 1),
	CONSTRAINT "repository_maintainer_emails_count_check" CHECK ("commit_count" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_maintainer_emails_email_idx" ON "repository_maintainer_emails" USING btree ("email");
