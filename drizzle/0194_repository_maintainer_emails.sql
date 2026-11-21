-- 0194: 저장소 제작자 커밋 이메일 — 관리자 전용 비공개 표와 다시 모으지 않을 주소 목록(2026-11-15 요청 · 2026-11-21 소유자 결정 「프로젝트 제작자만 모아」).
-- 목적: 나중에 프로젝트 제작자에게 그 프로젝트의 지금 상황을 알려 주기 위함이다. 공개 화면·공개 API·탐색 캐시는 이 표들을 읽지 않는다.
--
-- repository_maintainer_emails: ai-level-refresh 잡(crawler)이 이미 읽는 최근 커밋 30개 가운데, 저장소 주인 계정의 GitHub 로그인과 같은
--   GitHub 사용자가 작성자인 커밋의 사람 주소만 남긴다(lib/domain/makers/maintainer-emails.ts). 조직 저장소는 모으지 않는다.
--   마지막 확인(last_seen_at) 뒤 1년이 지나면 보관 정리(db-retention 잡, maintenance)가 지운다.
-- maintainer_email_denials: 관리자가 지우고 다시 모으지 않게 한 주소. 주소는 남기지 않고, 정규화한 주소의 sha256(영역 구분 접두어를 붙인 것)만 둔다.
--
-- 새 표 둘과 그 인덱스만 만든다 — 기존 표를 잠그거나 CHECK 를 다시 짓지 않는다(DRAIN 불필요). 옛 웹·워커는 이 표를 모르고 그대로 돈다.
-- Oracle 최소 권한 계정에는 GRANT 하지 않는다(읽거나 쓸 일이 없다).
-- 번호: 0186 자리는 비어 있지만 끼워 넣지 않는다 — drizzle 은 적용된 마지막 when(0193)보다 큰 when 만 적용한다.
CREATE TABLE "repository_maintainer_emails" (
	"repository_key" varchar(200) NOT NULL,
	"email" varchar(254) NOT NULL,
	"author_name" varchar(200),
	"author_login" varchar(100),
	"commit_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamptz DEFAULT now() NOT NULL,
	"last_seen_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "repository_maintainer_emails_pkey" PRIMARY KEY ("repository_key", "email"),
	CONSTRAINT "repository_maintainer_emails_key_check" CHECK ("repository_key" ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
	CONSTRAINT "repository_maintainer_emails_email_check" CHECK ("email" = lower("email") AND position('@' in "email") > 1),
	CONSTRAINT "repository_maintainer_emails_count_check" CHECK ("commit_count" >= 0),
	CONSTRAINT "repository_maintainer_emails_seen_check" CHECK ("last_seen_at" >= "first_seen_at")
);
--> statement-breakpoint
CREATE INDEX "repository_maintainer_emails_email_idx" ON "repository_maintainer_emails" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "repository_maintainer_emails_last_seen_idx" ON "repository_maintainer_emails" USING btree ("last_seen_at");
--> statement-breakpoint
CREATE TABLE "maintainer_email_denials" (
	"email_hash" varchar(64) PRIMARY KEY NOT NULL,
	"denied_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "maintainer_email_denials_hash_check" CHECK ("email_hash" ~ '^[a-f0-9]{64}$')
);
