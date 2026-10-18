-- INT2: Oracle consumer 계정이 열 권한 안에서 닿던 남은 행을 좁힌다(review-uptime F3·F11, impl-fx-u "못 고친 것").
-- 기존 열·CHECK·권한은 그대로다. 조건은 current_user 이름만 본다 — 표 소유 역할(M3·mini 웹·워커·migration 계정), 소유자가 아닌 앱 계정,
-- Oracle 역할 계정 6개(nomorevibe_oracle_translation 등)에는 아무것도 바뀌지 않는다(그 계정들은 두 표 중 uptime_claims 권한이 없고,
-- 관측 키 조건은 consumer 계정 둘에만 건다). 계정은 NOINHERIT·current_user = session_user 를 preflight 가 확인한다.
-- RLS 가 아니라 트리거다: operations_observations 는 재생(replay) handler 표라 RLS 를 켜면 handler profile 이 거절하고, RLS 를 켠 표는
-- 논리 DR 계획에서 row_security_requires_review 로 막힌다(0105). 트리거 함수는 SECURITY INVOKER 다(handler profile 이 SECURITY DEFINER
-- 트리거를 거절한다). 일반(origin) 트리거라 논리 복제 적용(session_replication_role=replica)에서는 돌지 않는다 — 원본이 이미 검사했다.
-- 거절은 SQLSTATE 42501(권한 없음)이다.
--
-- 1) uptime_claims: Oracle 계정이 쓰는 claim 행은 언제나 Oracle host·probe 다(split-v1 policy 의 Oracle 은 probe 만, F3 적용기 수정과 같은 뜻).
--    열 권한(host·host_class UPDATE)으로는 home(m3·mini)으로 적힌 제출 행을 만들거나 home 행을 고칠 수 있었다.
CREATE FUNCTION oracle_uptime_claim_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF starts_with(current_user::text, 'nomorevibe_oracle_')
    AND (NEW.host IS DISTINCT FROM 'oracle-osaka-smoke' OR NEW.host_class IS DISTINCT FROM 'probe') THEN
    RAISE EXCEPTION 'oracle_uptime_claim_host' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER uptime_claims_oracle_scope BEFORE INSERT OR UPDATE ON uptime_claims
 FOR EACH ROW EXECUTE FUNCTION oracle_uptime_claim_scope();
--> statement-breakpoint
-- 2) operations_observations: consumer 계정은 자기 consumer 의 관측 키만 만들고 고친다(INSERT·ON CONFLICT·UPDATE 모두 새 키를 본다).
--    다른 키(service:maintenance:<home>·candidate:·job: 등)를 덮어 생존·진행 경보를 가릴 수 없다. 인스턴스는 consumer 접두
--    (lib/runtime/consumer-registry.ts consumerInstancePrefix, SERVICE_INSTANCE_ID 48자 안)로 시작한다.
--    - uptime: uptime-consumer:<인스턴스>(consumer 관측), service:maintenance:<인스턴스>(감독 생존)
--    - agent-scan: agent-scan:<인스턴스>, service:crawler:<인스턴스>, defer:agent-scan(미룬 이유, M3 consumer 와 같은 키),
--      host-slot:oracle-osaka-smoke[:…](HOST_BUDGET_ENFORCEMENT 를 켰을 때 이 host 자기 장부)
CREATE FUNCTION oracle_consumer_observation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user::text = 'nomorevibe_oracle_uptime'
    AND NEW.key !~ '^(uptime-consumer|service:maintenance):uptime-consumer-[A-Za-z0-9._-]{1,32}$' THEN
    RAISE EXCEPTION 'oracle_consumer_observation_key' USING ERRCODE = '42501';
  ELSIF current_user::text = 'nomorevibe_oracle_agent_scan'
    AND NEW.key !~ '^(agent-scan|service:crawler):agent-scan-consumer-[A-Za-z0-9._-]{1,28}$'
    AND NEW.key <> 'defer:agent-scan' AND NEW.key !~ '^host-slot:oracle-osaka-smoke(:|$)' THEN
    RAISE EXCEPTION 'oracle_consumer_observation_key' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_observations_oracle_consumer_scope BEFORE INSERT OR UPDATE ON operations_observations
 FOR EACH ROW EXECUTE FUNCTION oracle_consumer_observation_scope();
