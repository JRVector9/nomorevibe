-- 0169: 장비 안 경로별 몫(step 2, 운영자 결정 2026-11-08) — 장비(device = route groupId) 한 대의 칸을 경로(route_id)마다 보장(min_slots)·상한(max_slots)으로 나눈다.
-- 새 열 두 개만 더한다: model_capacity_devices.lend_idle(유휴 보장 칸 빌려주기, 기본 켜짐)와 route_quotas(경로 몫 jsonb 배열, 기본 []).
-- 새 표가 아니라 열인 까닭: 입장 TX(requestSlot → grantOne)와 감시자 관측(readModelCapacityDeviceStates)이 Oracle 최소 권한 계정으로도 돈다 —
-- 그 계정들은 이 표에 표 단위 SELECT 가 이미 있어 새 열은 그대로 읽힌다. 새 표였다면 GRANT 를 Oracle 에 먼저 적용하기 전까지 그 입장이 권한 오류로 멈춘다.
-- 몫이 없는 장비(route_quotas = [])는 오늘과 같은 입장이다. 장부(model_capacity_requests·events)의 행 모양·상태·CHECK·트리거·색인은 바뀌지 않는다.
-- 판정 SQL 의 단일 출처는 lib/llm/capacity-devices.ts(deviceStateCte·deviceCandidateSql·deviceRouteQuotaGateSql)다. 저장은 정책 세대 밖(DRAIN 없음)이다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 한 원소 = {"route_id": 경로, "min_slots": 0..장비 칸, "max_slots": null | min..장비 칸}. 경로는 겹치지 않고 64개까지, 보장 합계 ≤ 장비 칸.
-- 장비 칸(limit_slots)과 같은 행에서 보므로 칸 수를 몫 아래로 줄이는 장비 저장도 DB 가 거절한다(앱은 먼저 model_capacity_device_invalid 로 거절한다).
CREATE FUNCTION model_capacity_route_quotas_ok(quotas jsonb, limit_slots integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  item jsonb;
  route text;
  min_value integer;
  max_value integer;
  total integer := 0;
  seen text[] := '{}';
BEGIN
  IF quotas IS NULL OR limit_slots IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(quotas) <> 'array' OR jsonb_array_length(quotas) > 64 THEN RETURN false; END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(quotas) AS e(value) LOOP
    IF jsonb_typeof(item) <> 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) AS k) IS DISTINCT FROM ARRAY['max_slots', 'min_slots', 'route_id']::text[] THEN RETURN false; END IF;
    IF jsonb_typeof(item->'route_id') <> 'string' THEN RETURN false; END IF;
    route := item->>'route_id';
    IF char_length(route) NOT BETWEEN 1 AND 120 OR route <> btrim(route) OR route ~ '[[:cntrl:]]' OR route = ANY(seen) THEN RETURN false; END IF;
    seen := seen || route;
    IF jsonb_typeof(item->'min_slots') <> 'number' OR (item->>'min_slots') !~ '^(0|[1-9][0-9]{0,2})$' THEN RETURN false; END IF;
    min_value := (item->>'min_slots')::integer;
    IF jsonb_typeof(item->'max_slots') = 'null' THEN
      max_value := NULL;
    ELSIF jsonb_typeof(item->'max_slots') = 'number' AND (item->>'max_slots') ~ '^(0|[1-9][0-9]{0,2})$' THEN
      max_value := (item->>'max_slots')::integer;
    ELSE
      RETURN false;
    END IF;
    IF min_value > limit_slots OR (max_value IS NOT NULL AND (max_value < min_value OR max_value > limit_slots)) THEN RETURN false; END IF;
    total := total + min_value;
  END LOOP;
  RETURN total <= limit_slots;
END;
$$;
--> statement-breakpoint
ALTER TABLE model_capacity_devices
  ADD COLUMN lend_idle boolean NOT NULL DEFAULT true,
  ADD COLUMN route_quotas jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT model_capacity_devices_route_quotas_check CHECK (model_capacity_route_quotas_ok(route_quotas, limit_slots));
