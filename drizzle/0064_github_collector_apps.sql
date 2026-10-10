-- GitHub App 수집 자격(2026-10-10 운영자 결정) — 개인 토큰(github_collector_accounts)은 계정마다 한도 하나라 같은 계정의 토큰을 더해도
-- 늘지 않는다. App 은 설치(installation)마다 따로 한도가 있어 같은 계정에서 한도를 더할 수 있다. 개인 키는 수집 비밀키로 암호화해 둔다.
-- 표만 만든다 — 관리자 'GitHub 수집 계정'에서 등록한다. 옛 워커·웹은 이 표를 모르고 그대로 돈다
CREATE TABLE IF NOT EXISTS "github_collector_apps" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"app_slug" varchar(100) NOT NULL,
	"account_login" varchar(100) NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"core_quota" jsonb,
	"quota_observed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
