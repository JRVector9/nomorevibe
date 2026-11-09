-- 0170: 장비 안 모델별 상한(운영자 결정 2026-11-09) — 장비(device = route groupId) 한 대를 서로 다른 서버·모델이 함께 쓸 때(예: m3-mlx 의
-- deepseek-v4.1-flash-1017 엔진 최대 1 · gpt-oss-120b 엔진 최대 4, 공유 칸 2) 공유 칸(limit_slots)과 따로 모델마다 최대 동시 칸을 둔다.
-- 새 열 하나만 더한다: model_capacity_devices.model_limits(모델 상한 jsonb 배열, 기본 []). 0169 와 같은 까닭으로 표가 아니라 열이다 —
-- 입장 TX(requestSlot → grantOne)와 감시자 관측(readModelCapacityDeviceStates)을 도는 Oracle 최소 권한 계정은 이 표에 표 단위 SELECT 가 이미 있다.
-- 상한이 없는 장비(model_limits = [])는 오늘과 같은 입장이다. 장부(model_capacity_requests·events)의 행 모양·상태·CHECK·트리거·색인은 바뀌지 않는다.
-- 모델은 장부 행의 model 문자열과 정확히 같은 것으로 맞춘다(공급자 무관 — 같은 모델이 abcllm·local-direct 둘로 와도 한 상한을 함께 쓴다).
-- 판정 SQL 의 단일 출처는 lib/llm/capacity-devices.ts(modelLimitCte·deviceCandidateSql·deviceModelQuotaGateSql)다. 저장은 정책 세대 밖(DRAIN 없음)이다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 한 원소 = {"model": 장부 model 문자열(1..200자, 앞뒤 공백·제어 문자 없음), "max_slots": 0..256, "engine_max": null | 1..256}. 모델은 겹치지 않고 64개까지.
-- engine_max 는 운영자가 적은 그 서버(엔진)의 실제 최대 동시 처리 수(null = 모름) — 표시·검증용이며 입장은 max_slots 만 본다. max_slots ≤ engine_max.
-- 공유 칸(limit_slots)보다 큰 상한은 거절하지 않는다(엔진 최대가 공유 칸보다 클 수 있다 — 그때는 공유 칸이 먼저 막는다; 저장은 경고만 한다).
CREATE FUNCTION model_capacity_model_limits_ok(limits jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  item jsonb;
  model_name text;
  max_value integer;
  seen text[] := '{}';
BEGIN
  IF limits IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(limits) <> 'array' OR jsonb_array_length(limits) > 64 THEN RETURN false; END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(limits) AS e(value) LOOP
    IF jsonb_typeof(item) <> 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) AS k) IS DISTINCT FROM ARRAY['engine_max', 'max_slots', 'model']::text[] THEN RETURN false; END IF;
    IF jsonb_typeof(item->'model') <> 'string' THEN RETURN false; END IF;
    model_name := item->>'model';
    IF char_length(model_name) NOT BETWEEN 1 AND 200 OR model_name <> btrim(model_name) OR model_name ~ '[[:cntrl:]]' OR model_name = ANY(seen) THEN RETURN false; END IF;
    seen := seen || model_name;
    IF jsonb_typeof(item->'max_slots') <> 'number' OR (item->>'max_slots') !~ '^(0|[1-9][0-9]{0,2})$' OR (item->>'max_slots')::integer > 256 THEN RETURN false; END IF;
    max_value := (item->>'max_slots')::integer;
    IF jsonb_typeof(item->'engine_max') = 'null' THEN
      NULL;
    ELSIF jsonb_typeof(item->'engine_max') = 'number' AND (item->>'engine_max') ~ '^[1-9][0-9]{0,2}$' AND (item->>'engine_max')::integer <= 256 THEN
      IF max_value > (item->>'engine_max')::integer THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE model_capacity_devices
  ADD COLUMN model_limits jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT model_capacity_devices_model_limits_check CHECK (model_capacity_model_limits_ok(model_limits));
