-- 표본 비교 기록(2026-11-12 운영 콘솔 조각 3a). 새 표 하나 — 기존 표·장부·계약·정책은 바꾸지 않는다.
-- 관리자 요청 한 줄에 그 작업의 배경 잡이 기존 호출 경로·용량 장부로 부른 결과를 채운다. 운영 데이터(소개·번역 표)에는 쓰지 않는다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE model_sample_comparisons (
  id bigserial PRIMARY KEY,
  task varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  status_code varchar(120),
  candidate jsonb NOT NULL,
  current jsonb,
  sample_size integer NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  deferrals integer NOT NULL DEFAULT 0,
  requested_by varchar(120) NOT NULL,
  requested_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_sample_comparisons_task_check CHECK (task ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT model_sample_comparisons_status_check CHECK (status IN ('queued','running','done','failed','cancelled')),
  CONSTRAINT model_sample_comparisons_size_check CHECK (sample_size BETWEEN 1 AND 40),
  CONSTRAINT model_sample_comparisons_deferrals_check CHECK (deferrals BETWEEN 0 AND 1000),
  CONSTRAINT model_sample_comparisons_refs_check CHECK (jsonb_typeof(candidate) = 'object' AND (current IS NULL OR jsonb_typeof(current) = 'object')),
  CONSTRAINT model_sample_comparisons_items_check CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 40 AND pg_column_size(items) <= 262144)
);
--> statement-breakpoint
CREATE INDEX model_sample_comparisons_task_idx ON model_sample_comparisons (task, id);
--> statement-breakpoint
CREATE INDEX model_sample_comparisons_open_idx ON model_sample_comparisons (task, id) WHERE status IN ('queued','running');
