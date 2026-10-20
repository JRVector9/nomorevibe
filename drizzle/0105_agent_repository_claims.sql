-- E2(PR2): 제작 근거 스캔을 저장소 단위로 여러 서버가 나눠 맡는 claim 기반. 새 표 2개와 제어 행 1개만 더한다.
-- 기존 표·열·CHECK·권한은 그대로다. 제어 행은 legacy(epoch 1, contract 0)로 시작해 이 migration 만으로는 동작이 바뀌지 않는다.
-- 시각: 스캔 표(agent_repository_scans)와 같은 시간대 없는 UTC timestamp 다. 쓰고 비교할 때 clock_timestamp() AT TIME ZONE 'UTC' 로
-- 세션 시간대와 무관하게 맞춘다.
CREATE TABLE agent_scan_control (
 id integer PRIMARY KEY DEFAULT 1 CONSTRAINT agent_scan_control_id CHECK (id = 1),
 mode varchar(10) NOT NULL DEFAULT 'legacy' CONSTRAINT agent_scan_control_mode CHECK (mode IN ('legacy','draining','items')),
 draining_from varchar(8),
 epoch bigint NOT NULL DEFAULT 1 CONSTRAINT agent_scan_control_epoch CHECK (epoch BETWEEN 1 AND 9007199254740991),
 writer_contract_version integer NOT NULL DEFAULT 0 CONSTRAINT agent_scan_control_contract CHECK (writer_contract_version >= 0),
 updated_at timestamp NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 CONSTRAINT agent_scan_control_draining CHECK ((mode = 'draining' AND draining_from IS NOT NULL AND draining_from IN ('legacy','items'))
   OR (mode <> 'draining' AND draining_from IS NULL))
);
--> statement-breakpoint
INSERT INTO agent_scan_control (id) VALUES (1);
--> statement-breakpoint
-- 저장소 키(소문자 owner/repo)당 1행. 행은 큐 채우기(컨트롤러)만 만든다. consumer 는 claim(token·epoch+1) → 기록 또는 포기로 token 을 비운다.
-- 소유 열(token·instance_id·boot_id·claimed_at·lease_until·control_epoch·binding_hash)은 함께 있거나 함께 없다.
CREATE TABLE agent_repository_claims (
 repository_key varchar(200) PRIMARY KEY,
 state varchar(8) NOT NULL DEFAULT 'active',
 priority smallint NOT NULL,
 requires_daily boolean NOT NULL,
 due_at timestamp NOT NULL,
 retry_after timestamp,
 failure_streak integer NOT NULL DEFAULT 0,
 first_failure_at timestamp,
 last_error_code varchar(60),
 last_outcome varchar(20),
 last_finished_at timestamp,
 epoch bigint NOT NULL DEFAULT 0,
 control_epoch bigint,
 binding_hash varchar(64),
 instance_id varchar(120),
 boot_id uuid,
 token uuid,
 claimed_at timestamp,
 lease_until timestamp,
 updated_at timestamp NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 CONSTRAINT agent_repository_claims_key CHECK (repository_key ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
   AND split_part(repository_key, '/', 1) NOT IN ('.','..') AND split_part(repository_key, '/', 2) NOT IN ('.','..')),
 CONSTRAINT agent_repository_claims_state CHECK (state IN ('active','gone')),
 CONSTRAINT agent_repository_claims_priority CHECK (priority BETWEEN 0 AND 9),
 CONSTRAINT agent_repository_claims_outcome CHECK (last_outcome IS NULL OR last_outcome IN ('complete','partial','failed','cached','abandoned')),
 CONSTRAINT agent_repository_claims_failure CHECK ((failure_streak = 0 AND first_failure_at IS NULL AND last_error_code IS NULL)
   OR (failure_streak BETWEEN 1 AND 1000000 AND first_failure_at IS NOT NULL AND char_length(btrim(last_error_code)) > 0)),
 CONSTRAINT agent_repository_claims_owner CHECK (
   (token IS NULL AND instance_id IS NULL AND boot_id IS NULL AND claimed_at IS NULL AND lease_until IS NULL
     AND control_epoch IS NULL AND binding_hash IS NULL)
   OR (token IS NOT NULL AND instance_id IS NOT NULL AND char_length(btrim(instance_id)) > 0 AND boot_id IS NOT NULL
     AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > claimed_at
     AND control_epoch IS NOT NULL AND binding_hash IS NOT NULL AND epoch >= 1)),
 CONSTRAINT agent_repository_claims_epochs CHECK (epoch BETWEEN 0 AND 9007199254740991
   AND (control_epoch IS NULL OR control_epoch BETWEEN 1 AND 9007199254740991)),
 CONSTRAINT agent_repository_claims_hash CHECK (binding_hash IS NULL OR binding_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
-- claim 순서(priority → due_at → 키)와 굶김 방지 순서(due_at → 키). gone 은 고르지 않는다.
CREATE INDEX agent_repository_claims_queue_idx ON agent_repository_claims (priority, due_at, repository_key) WHERE state = 'active';
--> statement-breakpoint
CREATE INDEX agent_repository_claims_due_idx ON agent_repository_claims (due_at, repository_key) WHERE state = 'active';
--> statement-breakpoint
-- 전환 완료·batch 완료·DR seal 의 live claim 검사.
CREATE INDEX agent_repository_claims_live_idx ON agent_repository_claims (lease_until) WHERE token IS NOT NULL;
