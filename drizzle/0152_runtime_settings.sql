-- 0152: runtime_settings — 관리자 실시간 한도 문서. 경로 한도(limits/timeouts/deadlines)·번역 묶음·틱 예산을 한 행의 sparse JSON 으로 둔다.
-- 코드 기본값은 바뀌지 않는다: 저장된 키만 덮고 나머지는 코드 기본값이다. 워커는 30초 안에 다시 읽어 다음 틱부터 쓴다.
-- 감독 liveness 한도(heartbeat/progress/drain)와 장비 한도(PR 1b 의 별도 migration)는 여기 들어가지 않는다. 기존 표·CHECK·함수·트리거는 바뀌지 않는다.
CREATE TABLE runtime_settings (
  id integer PRIMARY KEY DEFAULT 1,
  values jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT runtime_settings_single_row_check CHECK (id = 1),
  CONSTRAINT runtime_settings_values_check CHECK (jsonb_typeof(values) = 'object' AND coalesce(values->>'version', '') = '1' AND pg_column_size(values) <= 65536),
  CONSTRAINT runtime_settings_revision_check CHECK (revision BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO runtime_settings (id, values, updated_by) VALUES (1, '{"version":1}'::jsonb, 'migration:0152') ON CONFLICT (id) DO NOTHING;
