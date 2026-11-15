-- 0187 DB 보관 정리(2026-11-15 소유자 승인 「④⑤⑥ PR 만들어줘」) — 모델 장부(model_capacity_requests·events)의 보관 삭제 길.
--
-- 0078 부터 model_capacity_events 는 추가 전용이다(UPDATE·DELETE·TRUNCATE 문장 트리거가 ERRCODE 55000 으로 거절, ENABLE ALWAYS).
-- 이 마이그레이션은 DELETE 하나만, 같은 트랜잭션이 nmv.capacity_retention = 'on'(set_config(..., true) — 트랜잭션 안에서만)을 켰을 때만 연다.
-- UPDATE·TRUNCATE 는 그대로 거절하고, 설정이 없으면 DELETE 도 예전처럼 55000 'model_capacity_events_append_only' 다.
-- 열린 DELETE 는 문장 끝(AFTER ... FOR EACH STATEMENT, 전이 표)에서 지운 행을 모두 다시 본다 — 그 행의 요청이 끝난 지(settled 는 settled_at,
-- withdrawn 은 updated_at) 8일 넘었을 때만 통과한다. 8일은 관리자 설정(capacity.ledgerRetentionDays, 기본 14·최소 8)의 바닥이고,
-- LLM 보조 주간 상한이 UTC 한 주(7일) 안의 dispatched_at 을 세기 때문이다. 같은 검사를 요청 행 DELETE 에도 건다(설정이 켜졌을 때만).
-- 설정이 꺼진 DELETE(테스트 정리처럼 소유자가 트리거를 끄고 하는 것)는 이 검사를 건너뛴다 — 그 길은 예전 그대로다.
--
-- 표 잠금: 트리거 함수 바꾸기(CREATE OR REPLACE FUNCTION)는 표를 잠그지 않는다. AFTER 트리거 두 개를 만드는 CREATE TRIGGER 는 두 표에
-- SHARE ROW EXCLUSIVE 를 잠깐 잡는다 — 접수(OPEN) 중 장부 쓰기가 잠깐 기다리므로 DRAIN 안에서 적용한다(배포 창 순서는 PR 본문).
CREATE OR REPLACE FUNCTION nmv_model_capacity_retention_active() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('nmv.capacity_retention', true), '') = 'on' $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_model_capacity_retention_expired(state text, settled_at timestamptz, updated_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((state = 'settled' AND settled_at < clock_timestamp() - interval '8 days')
    OR (state = 'withdrawn' AND updated_at < clock_timestamp() - interval '8 days'), false)
$$;
--> statement-breakpoint
-- 0078 의 함수를 같은 이름으로 바꾼다 — 두 트리거(no_change: BEFORE UPDATE OR DELETE, no_truncate: BEFORE TRUNCATE)가 그대로 이 함수를 부른다.
CREATE OR REPLACE FUNCTION "model_capacity_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND nmv_model_capacity_retention_active() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'model_capacity_events_append_only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION nmv_model_capacity_events_retention_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT nmv_model_capacity_retention_active() THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM retention_old_events o LEFT JOIN model_capacity_requests r ON r.request_id = o.request_id
             WHERE r.request_id IS NULL OR NOT nmv_model_capacity_retention_expired(r.state, r.settled_at, r.updated_at)) THEN
    RAISE EXCEPTION 'model_capacity_retention_not_expired' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION nmv_model_capacity_requests_retention_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT nmv_model_capacity_retention_active() THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM retention_old_requests o WHERE NOT nmv_model_capacity_retention_expired(o.state, o.settled_at, o.updated_at)) THEN
    RAISE EXCEPTION 'model_capacity_retention_not_expired' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_capacity_events_retention_check" AFTER DELETE ON "model_capacity_events"
REFERENCING OLD TABLE AS retention_old_events FOR EACH STATEMENT EXECUTE FUNCTION nmv_model_capacity_events_retention_check();
--> statement-breakpoint
ALTER TABLE "model_capacity_events" ENABLE ALWAYS TRIGGER "model_capacity_events_retention_check";
--> statement-breakpoint
CREATE TRIGGER "model_capacity_requests_retention_check" AFTER DELETE ON "model_capacity_requests"
REFERENCING OLD TABLE AS retention_old_requests FOR EACH STATEMENT EXECUTE FUNCTION nmv_model_capacity_requests_retention_check();
--> statement-breakpoint
ALTER TABLE "model_capacity_requests" ENABLE ALWAYS TRIGGER "model_capacity_requests_retention_check";
