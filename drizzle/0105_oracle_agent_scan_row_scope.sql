-- FX-E: Oracle 계정(nomorevibe_oracle_*)이 닿는 행을 좁히고, 제작 근거 consumer 가 jobs 권한 없이 잡 멈춤을 읽게 한다.
-- 기존 열·CHECK·권한은 그대로다. 표 소유 역할(M3·mini 웹·워커가 쓰는 계정, migration 계정)은 RLS 를 우회하고, 소유자가 아닌 계정도
-- 모든 행 허용 정책(true)을 받는다. RESTRICTIVE 정책은 이름이 nomorevibe_oracle_ 로 시작하는 계정에만 조건을 건다(계정은 NOINHERIT·
-- current_user = session_user 를 preflight 가 확인한다). 정책은 다른 표를 읽지 않는다 — 읽으면 모든 계정에 그 표 SELECT 가 필요해진다.
-- 역할 계정 6개와 uptime consumer 는 두 표 권한이 없어 바뀌는 것이 없다.
-- RLS 를 켠 두 표는 논리 DR 계획(scripts/ops/oracle-dr)에서 row_security_requires_review 로 막힌다 — 구독 owner·복제 계정이
-- RLS 를 우회하는지 사람이 확인한다(oracle 활성화 runbook).
--
-- 1) rate_limits: Oracle 계정은 GitHub 수집 키(github:quota:·github:auth:, lib/crawl/github-quota.ts)만 읽고 쓴다.
--    관리자 로그인 제한(admin-password:login)·등록·검증·IP 키는 읽지도 만들지도 기한을 미루지도 못한다.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rate_limits_all_rows ON rate_limits AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY rate_limits_oracle_github_keys ON rate_limits AS RESTRICTIVE FOR ALL TO PUBLIC
 USING (NOT starts_with(current_user::text, 'nomorevibe_oracle_') OR key LIKE 'github:quota:%' OR key LIKE 'github:auth:%')
 WITH CHECK (NOT starts_with(current_user::text, 'nomorevibe_oracle_') OR key LIKE 'github:quota:%' OR key LIKE 'github:auth:%');
--> statement-breakpoint
-- 2) github_collector_apps: Oracle 계정은 oracle_principals 에 자기 계정 이름이 든 설치만 본다(개인 키 암호문 포함). 비어 있으면 어떤
--    Oracle 계정도 읽지 못한다. 운영자가 Oracle 계정을 만들 때 그 설치에 넣는다(runbook). Oracle 계정은 이 열을 바꿀 권한이 없다.
--    관리자 화면의 등록(upsert)은 이 열을 건드리지 않고, 설치를 지우면 함께 사라진다.
ALTER TABLE github_collector_apps ADD COLUMN oracle_principals text[] NOT NULL DEFAULT '{}'
 CONSTRAINT github_collector_apps_oracle_principals CHECK (cardinality(oracle_principals) <= 8 AND array_position(oracle_principals, NULL) IS NULL);
--> statement-breakpoint
ALTER TABLE github_collector_apps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY github_collector_apps_all_rows ON github_collector_apps AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY github_collector_apps_oracle_principals ON github_collector_apps AS RESTRICTIVE FOR ALL TO PUBLIC
 USING (NOT starts_with(current_user::text, 'nomorevibe_oracle_') OR current_user::text = ANY (oracle_principals))
 WITH CHECK (NOT starts_with(current_user::text, 'nomorevibe_oracle_') OR current_user::text = ANY (oracle_principals));
--> statement-breakpoint
-- 3) 제작 근거 consumer 의 claim 이 잡 멈춤(jobs.not_before 먼 미래, 운영자 정지)을 따른다. consumer 계정은 jobs 권한이 없으므로
--    그 잡의 not_before 하나만 보이는 보기를 둔다(보기 소유자 권한으로 읽는다).
CREATE VIEW agent_scan_job_schedule WITH (security_barrier) AS
 SELECT not_before FROM jobs WHERE name = 'agent-evidence-refresh';
