-- 0153: 장비별 입장 설정(PR 1b-A). 장비(device) = 정책 route 의 groupId = model_capacity_requests.group_id.
-- 전역·공급자·풀 한도와 class 가중치 순환은 입장 판정에서 빠지고(1b-C), 칸 수·역할 순위·낮은 순위 상한·유휴 시간·예비 칸이 이 표에 산다.
-- 이 표는 정책 세대(epoch·revision·policy_hash)에 들어가지 않는다: 저장은 다음 grant 부터 적용되고 잡힌 행은 건드리지 않는다(DRAIN 불필요).
-- 행은 현재 정책의 groupLimits 로 심는다(cap = limit, 순위 없음) — 배포 직후 동작은 오늘의 그룹 한도와 같고, 운영자가 고치면 그때부터 바뀐다.
-- 기존 CHECK·트리거·인덱스·함수·장부 행은 바뀌지 않는다. indeterminate 행은 점유로 세지 않는다(소유자 결정 2026-10-30; PR #750).
CREATE TABLE model_capacity_devices (
  device_id varchar(120) PRIMARY KEY,
  limit_slots integer NOT NULL,
  secondary_cap integer NOT NULL,
  idle_ms integer NOT NULL DEFAULT 60000,
  reserve_slots integer NOT NULL DEFAULT 0,
  physical_limit integer,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_capacity_devices_id_check CHECK (char_length(device_id) > 0 AND device_id = btrim(device_id) AND device_id !~ '[[:cntrl:]]'),
  CONSTRAINT model_capacity_devices_limits_check CHECK (limit_slots BETWEEN 1 AND 256 AND secondary_cap BETWEEN 0 AND limit_slots
    AND reserve_slots BETWEEN 0 AND limit_slots - 1 AND idle_ms BETWEEN 0 AND 3600000),
  CONSTRAINT model_capacity_devices_physical_check CHECK (physical_limit IS NULL OR (physical_limit BETWEEN 1 AND 256 AND limit_slots <= physical_limit)),
  CONSTRAINT model_capacity_devices_version_check CHECK (version BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE model_capacity_device_roles (
  device_id varchar(120) NOT NULL,
  route_id varchar(120) NOT NULL,
  role_rank integer NOT NULL,
  CONSTRAINT model_capacity_device_roles_pkey PRIMARY KEY (device_id, route_id),
  CONSTRAINT model_capacity_device_roles_device_fk FOREIGN KEY (device_id) REFERENCES model_capacity_devices (device_id) ON DELETE CASCADE,
  CONSTRAINT model_capacity_device_roles_rank_check CHECK (role_rank BETWEEN 1 AND 64),
  CONSTRAINT model_capacity_device_roles_route_check CHECK (char_length(route_id) > 0 AND route_id = btrim(route_id) AND route_id !~ '[[:cntrl:]]')
);
--> statement-breakpoint
INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, idle_ms, reserve_slots, updated_by, note)
SELECT g.key, g.value::integer, g.value::integer, 60000, 0, 'migration:0153',
       'seeded from capacity policy groupLimits (epoch ' || c.epoch || ' revision ' || c.revision || ')'
FROM model_capacity_control c, jsonb_each_text(c.policy->'groupLimits') g
WHERE c.id = 1 AND c.policy IS NOT NULL AND jsonb_typeof(c.policy->'groupLimits') = 'object'
  AND g.value ~ '^[1-9][0-9]{0,2}$' AND g.value::integer BETWEEN 1 AND 256
  AND char_length(g.key) BETWEEN 1 AND 120 AND g.key = btrim(g.key) AND g.key !~ '[[:cntrl:]]'
ON CONFLICT (device_id) DO NOTHING;
