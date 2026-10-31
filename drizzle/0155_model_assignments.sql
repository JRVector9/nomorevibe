-- 0155: 배정 표 열(PR 3b-A) — model_helper_assignments 를 「단계 × 장비 × 모델」 배정 표로 넓힌다. 도우미 행(role 'helper', PR 2a)은 그대로다.
-- 번호 주의: PR 3a-C 도 idx 155 / when 1794086401066(0155_split_composite_jobs)을 쓴다 — 둘 중 나중에 병합되는 쪽을 통합 때 다시 번호 매긴다.
-- 새 열: registry_key(관리자 모델 등록부 key, 새 배정 행은 필수) · transport(gateway·direct·local-direct·cli) · rank(단계 안 순위, 1 = 먼저 고른다)
-- · role(primary = 배정 표 행, helper = PR 2a 도우미 행) · vote(2차 rank 1 투표자). 기존 행은 기본값(role 'helper', rank 1, vote false, transport 'gateway',
-- registry_key NULL)을 받는다 — 도우미 행에서 새 열은 뜻이 없고 PR 2a 의 열(live_route_id·live_provider·shadow_route_id)이 그대로 경로를 정한다.
-- 배포 직후 동작은 바뀌지 않는다: primary 행은 아직 없고(저장 함수 saveModelAssignment 만 만든다) 입장·감시자는 role 'helper' 행만 읽는다.
-- 단계 CHECK 는 배정 단계 열일곱으로 넓힌다(repo 는 예약만). 도우미 행은 여전히 ai1·ai2 만(role_stage CHECK), 단계 × 장비 하나(부분 유일 색인).
-- 섀도·실전 결과 표(model_helper_shadow_runs·model_helper_live_outputs)의 단계 CHECK 와 pipeline_stage_modes·pipeline_item_leases 의 단계
-- (fetch·ai1·ai2 — 다른 어휘)는 바꾸지 않는다.
ALTER TABLE model_helper_assignments ADD COLUMN IF NOT EXISTS registry_key text;
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'gateway';
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'helper';
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD COLUMN IF NOT EXISTS vote boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- 'audit-second-opinion' 은 20자다(0154 의 varchar(8) 로는 들어가지 않는다). varchar 넓히기는 표를 다시 쓰지 않는다.
ALTER TABLE model_helper_assignments ALTER COLUMN stage TYPE varchar(24);
--> statement-breakpoint
ALTER TABLE model_helper_assignments DROP CONSTRAINT IF EXISTS model_helper_assignments_stage_check;
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_stage_check CHECK (stage IN ('ai1','ai2','human','audit',
  'audit-second-opinion','intro','screen','assist','assist-audit','reason','tagline','profile','verify','ko','translate','publish-classify','repo'));
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_registry_key_check CHECK (char_length(registry_key) BETWEEN 1 AND 200);
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_transport_check CHECK (transport IN ('gateway','direct','local-direct','cli'));
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_rank_check CHECK (rank >= 1);
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_role_check CHECK (role IN ('primary','helper'));
--> statement-breakpoint
-- 투표는 2차 rank 1 배정만. 도우미 행은 1·2차만. 배정 표 행은 등록부 key 가 있어야 한다.
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_vote_check CHECK (NOT vote OR (stage = 'ai2' AND rank = 1));
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_role_stage_check CHECK (role = 'primary' OR stage IN ('ai1','ai2'));
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_primary_registry_check CHECK (role = 'helper' OR registry_key IS NOT NULL);
--> statement-breakpoint
-- 실전 승격 기록은 도우미 행에만 필요하다(PR 2c 의 promote). 배정 표 행의 'live' 는 「이 배정을 쓴다」이다.
ALTER TABLE model_helper_assignments DROP CONSTRAINT IF EXISTS model_helper_assignments_live_check;
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_live_check CHECK (mode <> 'live' OR role = 'primary'
  OR (promoted_at IS NOT NULL AND promoted_evidence IS NOT NULL));
--> statement-breakpoint
-- 유일: 단계 × 장비 × 모델 하나. PR 2a 의 「도우미는 단계 × 장비 하나」는 도우미 행에만 부분 유일 색인으로 남긴다(저장 코드는 ON CONFLICT 를 쓰지 않는다).
-- (device_id, live_route_id, live_provider, model)·(device_id, shadow_route_id, model) 유일은 그대로다.
ALTER TABLE model_helper_assignments DROP CONSTRAINT IF EXISTS model_helper_assignments_stage_device_key;
--> statement-breakpoint
ALTER TABLE model_helper_assignments ADD CONSTRAINT model_helper_assignments_stage_device_model_key UNIQUE (stage, device_id, model);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS model_helper_assignments_helper_stage_device_idx ON model_helper_assignments (stage, device_id) WHERE role = 'helper';
