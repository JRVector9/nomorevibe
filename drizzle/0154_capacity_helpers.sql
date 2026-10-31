-- 0154: 도우미 장비 · Oracle 감시자 표(PR 2a, Layer B). 계획서는 0155 를 적었지만 1b-C 가 migration 을 더하지 않아 0154 를 쓴다(2b 의 장부 CHECK 확장이 0155).
-- 배포 직후 동작은 바뀌지 않는다: 감시자 control 행은 enabled=false, 도우미 배정 행은 없다(관리자가 OPEN 전에 mode 'off' 로 만든다).
-- 감시자 신호는 선택적 도우미 경로를 *열거나* 빌려주기를 *줄일* 뿐 우선 역할 일을 막지 못한다. 신호가 없거나·만료됐거나·다른 epoch·다른 판·다른 계정이면
-- 도우미는 닫힌다(fail-closed). 신선도 판정은 입장 TX 안에서 DB 시계(clock_timestamp())로만 한다 — 단일 출처 lib/llm/capacity-helpers.ts.
-- 이 파일은 새 표·CHECK·색인·seed 행과 새 표의 트리거 둘(신호 도장 model_signal_stamp, 자동 정지 append-only)을 만들고,
-- 0107 의 oracle_consumer_observation_scope() 에 감시자 계정 갈래 하나를 더한다(기존 두 갈래는 글자 그대로). 기존 표·CHECK·트리거·장부 행은 바뀌지 않는다.
CREATE TABLE model_supervisor_control (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  signal_principal varchar(63) NOT NULL DEFAULT 'nomorevibe_oracle_capacity_supervisor',
  signal_ttl_ms integer NOT NULL DEFAULT 45000,
  loop_ms integer NOT NULL DEFAULT 15000,
  owner_instance_id varchar(120),
  owner_boot_id uuid,
  epoch bigint NOT NULL DEFAULT 0,
  lease_until timestamptz(3),
  heartbeat_at timestamptz(3),
  loop_seq bigint NOT NULL DEFAULT 0,
  release varchar(80),
  updated_by varchar(120) NOT NULL DEFAULT 'migration:0154',
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_supervisor_control_id_check CHECK (id = 1),
  CONSTRAINT model_supervisor_control_principal_check CHECK (signal_principal ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CONSTRAINT model_supervisor_control_ttl_check CHECK (signal_ttl_ms BETWEEN 15000 AND 300000),
  CONSTRAINT model_supervisor_control_loop_check CHECK (loop_ms BETWEEN 5000 AND 60000 AND loop_ms * 2 <= signal_ttl_ms),
  CONSTRAINT model_supervisor_control_epoch_check CHECK (epoch BETWEEN 0 AND 9007199254740991 AND loop_seq >= 0)
);
--> statement-breakpoint
INSERT INTO model_supervisor_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE TABLE model_helper_assignments (
  assignment_id varchar(120) PRIMARY KEY,
  stage varchar(8) NOT NULL,
  device_id varchar(120) NOT NULL,
  model varchar(200) NOT NULL,
  shadow_route_id varchar(120) NOT NULL,
  live_route_id varchar(120) NOT NULL,
  live_provider varchar(60) NOT NULL,
  mode varchar(8) NOT NULL DEFAULT 'off',
  max_slots integer NOT NULL DEFAULT 1,
  per_tick integer NOT NULL DEFAULT 2,
  shadow_per_hour integer NOT NULL DEFAULT 30,
  min_shadow_samples integer NOT NULL DEFAULT 200,
  min_agreement numeric(4,3) NOT NULL DEFAULT 0.950,
  max_wrong_approval numeric(4,3) NOT NULL DEFAULT 0.010,
  max_wrong_rejection numeric(4,3) NOT NULL DEFAULT 0.020,
  max_unknown_rate numeric(4,3) NOT NULL DEFAULT 0.020,
  max_failure_rate numeric(4,3) NOT NULL DEFAULT 0.100,
  max_live_disagreement numeric(4,3) NOT NULL DEFAULT 0.100,
  enter_samples integer NOT NULL DEFAULT 2,
  exit_samples integer NOT NULL DEFAULT 4,
  min_help_ms integer NOT NULL DEFAULT 120000,
  reenter_cooldown_ms integer NOT NULL DEFAULT 60000,
  evidence_key varchar(64) NOT NULL,
  promoted_evidence jsonb,
  promoted_at timestamptz(3),
  promoted_by varchar(120),
  version bigint NOT NULL DEFAULT 1,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_helper_assignments_device_fk FOREIGN KEY (device_id) REFERENCES model_capacity_devices (device_id),
  CONSTRAINT model_helper_assignments_id_check CHECK (assignment_id ~ '^[a-z0-9][a-z0-9:-]{0,119}$'),
  CONSTRAINT model_helper_assignments_stage_check CHECK (stage IN ('ai1','ai2')),
  CONSTRAINT model_helper_assignments_mode_check CHECK (mode IN ('off','shadow','live')),
  CONSTRAINT model_helper_assignments_identity_check CHECK (char_length(model) > 0 AND model = btrim(model) AND model !~ '[[:cntrl:]]'
    AND char_length(shadow_route_id) > 0 AND shadow_route_id = btrim(shadow_route_id) AND shadow_route_id !~ '[[:cntrl:]]'
    AND char_length(live_route_id) > 0 AND live_route_id = btrim(live_route_id) AND live_route_id !~ '[[:cntrl:]]'
    AND char_length(live_provider) > 0 AND live_provider = btrim(live_provider) AND live_provider !~ '[[:cntrl:]]'
    AND shadow_route_id <> live_route_id),
  CONSTRAINT model_helper_assignments_slots_check CHECK (max_slots BETWEEN 1 AND 256 AND per_tick BETWEEN 1 AND 16
    AND shadow_per_hour BETWEEN 0 AND 600 AND min_shadow_samples BETWEEN 20 AND 10000),
  CONSTRAINT model_helper_assignments_hysteresis_check CHECK (enter_samples BETWEEN 1 AND 20 AND exit_samples BETWEEN 1 AND 40
    AND min_help_ms BETWEEN 0 AND 3600000 AND reenter_cooldown_ms BETWEEN 0 AND 3600000),
  CONSTRAINT model_helper_assignments_thresholds_check CHECK (min_agreement BETWEEN 0.5 AND 1 AND max_wrong_approval BETWEEN 0 AND 0.5
    AND max_wrong_rejection BETWEEN 0 AND 0.5 AND max_unknown_rate BETWEEN 0 AND 0.5 AND max_failure_rate BETWEEN 0 AND 0.9
    AND max_live_disagreement BETWEEN 0 AND 0.9),
  CONSTRAINT model_helper_assignments_evidence_check CHECK (evidence_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT model_helper_assignments_live_check CHECK (mode <> 'live' OR (promoted_at IS NOT NULL AND promoted_evidence IS NOT NULL)),
  CONSTRAINT model_helper_assignments_promoted_check CHECK (promoted_evidence IS NULL OR (jsonb_typeof(promoted_evidence) = 'object' AND pg_column_size(promoted_evidence) <= 16384)),
  CONSTRAINT model_helper_assignments_version_check CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT model_helper_assignments_stage_device_key UNIQUE (stage, device_id),
  CONSTRAINT model_helper_assignments_live_route_key UNIQUE (device_id, live_route_id, live_provider, model),
  CONSTRAINT model_helper_assignments_shadow_route_key UNIQUE (device_id, shadow_route_id, model)
);
--> statement-breakpoint
CREATE TABLE model_helper_signals (
  assignment_id varchar(120) PRIMARY KEY,
  assignment_version bigint NOT NULL,
  supervisor_epoch bigint NOT NULL,
  verdict varchar(12) NOT NULL,
  reason varchar(40) NOT NULL,
  streak integer NOT NULL DEFAULT 0,
  state_since timestamptz(3) NOT NULL,
  last_exit_at timestamptz(3),
  metrics jsonb NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  valid_until timestamptz(3) NOT NULL,
  written_by varchar(63) NOT NULL,
  CONSTRAINT model_helper_signals_assignment_fk FOREIGN KEY (assignment_id) REFERENCES model_helper_assignments (assignment_id) ON DELETE CASCADE,
  CONSTRAINT model_helper_signals_verdict_check CHECK (verdict IN ('help','shadow_only','hold')),
  CONSTRAINT model_helper_signals_reason_check CHECK (reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT model_helper_signals_streak_check CHECK (streak >= 0),
  CONSTRAINT model_helper_signals_metrics_check CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 8192),
  CONSTRAINT model_helper_signals_ttl_check CHECK (valid_until > observed_at AND valid_until <= observed_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE model_device_signals (
  device_id varchar(120) PRIMARY KEY,
  supervisor_epoch bigint NOT NULL,
  primary_demand boolean NOT NULL,
  backlog integer NOT NULL,
  metrics jsonb NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  valid_until timestamptz(3) NOT NULL,
  written_by varchar(63) NOT NULL,
  CONSTRAINT model_device_signals_backlog_check CHECK (backlog >= 0),
  CONSTRAINT model_device_signals_metrics_check CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 8192),
  CONSTRAINT model_device_signals_ttl_check CHECK (valid_until > observed_at AND valid_until <= observed_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE model_role_demand (
  role_id varchar(60) PRIMARY KEY,
  device_id varchar(120) NOT NULL,
  backlog integer NOT NULL,
  oldest_age_ms bigint,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz(3) NOT NULL,
  valid_until timestamptz(3) NOT NULL,
  written_by varchar(63) NOT NULL,
  CONSTRAINT model_role_demand_backlog_check CHECK (backlog >= 0 AND (oldest_age_ms IS NULL OR oldest_age_ms >= 0)),
  CONSTRAINT model_role_demand_metrics_check CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 8192),
  CONSTRAINT model_role_demand_ttl_check CHECK (valid_until > observed_at AND valid_until <= observed_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE model_helper_stops (
  id bigserial PRIMARY KEY,
  assignment_id varchar(120) NOT NULL,
  assignment_version bigint NOT NULL,
  effect varchar(20) NOT NULL,
  reason varchar(40) NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  written_by varchar(63) NOT NULL DEFAULT current_user,
  CONSTRAINT model_helper_stops_assignment_fk FOREIGN KEY (assignment_id) REFERENCES model_helper_assignments (assignment_id) ON DELETE CASCADE,
  CONSTRAINT model_helper_stops_effect_check CHECK (effect IN ('stop','demote_to_shadow')),
  CONSTRAINT model_helper_stops_reason_check CHECK (reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT model_helper_stops_evidence_check CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 8192)
);
--> statement-breakpoint
CREATE INDEX model_helper_stops_assignment_idx ON model_helper_stops (assignment_id, assignment_version);
--> statement-breakpoint
CREATE TABLE model_helper_shadow_runs (
  id bigserial PRIMARY KEY,
  assignment_id varchar(120) NOT NULL,
  evidence_key varchar(64) NOT NULL,
  stage varchar(8) NOT NULL,
  candidate_id integer NOT NULL,
  second_review_id integer,
  primary_ref bigint NOT NULL,
  primary_model varchar(200) NOT NULL,
  primary_decision varchar(16) NOT NULL,
  primary_confidence double precision,
  input_hash varchar(64) NOT NULL,
  source_revision_hash varchar(64) NOT NULL,
  policy_hash varchar(64) NOT NULL,
  prompt_version varchar(40) NOT NULL,
  rules_version varchar(40) NOT NULL,
  state varchar(10) NOT NULL,
  helper_decision varchar(16),
  helper_confidence double precision,
  helper_outcome jsonb,
  agreement varchar(32),
  error_code varchar(40),
  request_id uuid,
  latency_ms integer,
  job_token uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz(3),
  CONSTRAINT model_helper_shadow_runs_assignment_fk FOREIGN KEY (assignment_id) REFERENCES model_helper_assignments (assignment_id) ON DELETE CASCADE,
  CONSTRAINT model_helper_shadow_runs_stage_check CHECK (stage IN ('ai1','ai2')),
  CONSTRAINT model_helper_shadow_runs_state_check CHECK (state IN ('claimed','succeeded','failed','unknown','cancelled')),
  CONSTRAINT model_helper_shadow_runs_outcome_check CHECK (helper_outcome IS NULL OR pg_column_size(helper_outcome) <= 16384),
  CONSTRAINT model_helper_shadow_runs_agreement_check CHECK (agreement IN ('same','helper_approve_primary_reject','helper_reject_primary_approve','helper_abstain','primary_abstain','other')),
  CONSTRAINT model_helper_shadow_runs_sample_key UNIQUE (assignment_id, evidence_key, candidate_id, input_hash)
);
--> statement-breakpoint
CREATE INDEX model_helper_shadow_runs_evidence_idx ON model_helper_shadow_runs (assignment_id, evidence_key, created_at DESC);
--> statement-breakpoint
CREATE TABLE model_helper_live_outputs (
  id bigserial PRIMARY KEY,
  assignment_id varchar(120) NOT NULL,
  assignment_version bigint NOT NULL,
  evidence_key varchar(64) NOT NULL,
  stage varchar(8) NOT NULL,
  candidate_id integer NOT NULL,
  attempt_id integer,
  second_review_id integer,
  helper_decision varchar(16),
  downstream varchar(20),
  downstream_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_helper_live_outputs_stage_check CHECK (stage IN ('ai1','ai2')),
  CONSTRAINT model_helper_live_outputs_downstream_check CHECK (downstream IN ('ai2_agreed','ai2_disagreed','human_overturned','none')),
  CONSTRAINT model_helper_live_outputs_ref_check CHECK ((attempt_id IS NULL) <> (second_review_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX model_helper_live_outputs_assignment_idx ON model_helper_live_outputs (assignment_id, created_at DESC);
--> statement-breakpoint
-- 신호 도장(pr2-plan §1.1): 쓰는 계정(written_by)과 관측 시각(observed_at)은 DB 가 찍는다 — 쓰는 쪽이 계정을 꾸미거나 시각을 거꾸로 적을 수 없고,
-- TTL CHECK(valid_until ≤ observed_at + 5분)가 도장 찍힌 시각으로 valid_until 을 묶는다. 입장은 written_by = control.signal_principal 일 때만
-- 신호를 쓴다(lib/llm/capacity-helpers.ts helperGateCte). SECURITY INVOKER 일반(origin) 트리거라 논리 복제 적용(replica)에서는 돌지 않는다 — 원본이 이미 찍었다.
CREATE FUNCTION model_signal_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.written_by := current_user;
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_helper_signals_stamp BEFORE INSERT OR UPDATE ON model_helper_signals
 FOR EACH ROW EXECUTE FUNCTION model_signal_stamp();
--> statement-breakpoint
CREATE TRIGGER model_device_signals_stamp BEFORE INSERT OR UPDATE ON model_device_signals
 FOR EACH ROW EXECUTE FUNCTION model_signal_stamp();
--> statement-breakpoint
CREATE TRIGGER model_role_demand_stamp BEFORE INSERT OR UPDATE ON model_role_demand
 FOR EACH ROW EXECUTE FUNCTION model_signal_stamp();
--> statement-breakpoint
-- 자동 정지·강등 기록은 넣기만 한다(operations_audit 0056 과 같은 방식): 고치기·지우기·비우기를 DB 가 거부한다(42501). 넣을 때는 쓴 계정과 시각을 DB 가 찍는다.
-- 정지는 (배정, 그 version) 에만 걸리므로 관리자가 다시 저장(version + 1)하면 지우지 않고도 풀린다. 정지 기록이 있는 배정은 지울 수 없다(FK cascade 도
-- 이 트리거에 걸린다) — 그만 쓰는 배정은 mode 'off' 로 둔다.
CREATE FUNCTION model_helper_stops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.written_by := current_user;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'model_helper_stops is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_helper_stops_stamp BEFORE INSERT ON model_helper_stops
 FOR EACH ROW EXECUTE FUNCTION model_helper_stops_append_only();
--> statement-breakpoint
CREATE TRIGGER model_helper_stops_no_change BEFORE UPDATE OR DELETE ON model_helper_stops
 FOR EACH ROW EXECUTE FUNCTION model_helper_stops_append_only();
--> statement-breakpoint
CREATE TRIGGER model_helper_stops_no_truncate BEFORE TRUNCATE ON model_helper_stops
 FOR EACH STATEMENT EXECUTE FUNCTION model_helper_stops_append_only();
--> statement-breakpoint
-- 0107 의 관측 키 범위에 감시자 계정(nomorevibe_oracle_capacity_supervisor) 갈래를 더한다. 이 계정은 자기 consumer 의 관측 키만 만들고 고친다:
-- capacity-supervisor:<인스턴스>(consumer 관측), service:maintenance:<인스턴스>(감독 생존). 인스턴스는 consumer 접두 capacity-supervisor-consumer-
-- (29자)로 시작하고 SERVICE_INSTANCE_ID 48자 안이라 꼬리는 1~19자다(0107 의 uptime 32·agent-scan 28 과 같은 계산). 앞의 두 갈래는 0107 과 글자 그대로다.
CREATE OR REPLACE FUNCTION oracle_consumer_observation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user::text = 'nomorevibe_oracle_uptime'
    AND NEW.key !~ '^(uptime-consumer|service:maintenance):uptime-consumer-[A-Za-z0-9._-]{1,32}$' THEN
    RAISE EXCEPTION 'oracle_consumer_observation_key' USING ERRCODE = '42501';
  ELSIF current_user::text = 'nomorevibe_oracle_agent_scan'
    AND NEW.key !~ '^(agent-scan|service:crawler):agent-scan-consumer-[A-Za-z0-9._-]{1,28}$'
    AND NEW.key <> 'defer:agent-scan' AND NEW.key !~ '^host-slot:oracle-osaka-smoke(:|$)' THEN
    RAISE EXCEPTION 'oracle_consumer_observation_key' USING ERRCODE = '42501';
  ELSIF current_user::text = 'nomorevibe_oracle_capacity_supervisor'
    AND NEW.key !~ '^(capacity-supervisor|service:maintenance):capacity-supervisor-consumer-[A-Za-z0-9._-]{1,19}$' THEN
    RAISE EXCEPTION 'oracle_consumer_observation_key' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
