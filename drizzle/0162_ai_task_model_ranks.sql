-- 0162: 작업 ↔ AI 모델 1~3순위(2026-11-02 소유자 결정, PR A). 「AI 연결」(API 주소 또는 CLI)과 「작업마다 1·2·3순위」 두 표를 만든다.
-- 앞으로 모든 AI 호출은 코드 기본값·환경변수 없이 이 두 표(주소·키·모델)나 CLI 로만 정한다. 이 판(PR A)은 표를 만들고 관리 화면이 쓰고 보일 뿐이다 —
-- 잡은 아직 이 표를 읽지 않는다(PR B 부터 읽는다). 그래서 배포 직후 동작은 바뀌지 않는다. 기존 표·CHECK·트리거·함수는 건드리지 않는다.
-- ai_connections: 연결 하나 = 엔진 하나(OpenAI 호환 /v1 주소) 또는 CLI 도구 하나. 키는 secret-box(NMV_SECRET_BOX_KEY) 암호문만 둔다(AAD = 행 id).
--   models = 마지막 GET {base_url}/models 결과([{id, maxModelLen}]), CLI 는 /models 가 없어 운영자가 적은 cli_models 를 쓴다.
--   device_id = 용량 장비(model_capacity_devices.device_id, 정책 route 의 groupId). 장비 행이 없을 수 있어 FK 를 두지 않는다 — 순위 저장이 없으면 만든다.
--   options = 연결별 덧붙임(PR A: /models 가 최대 길이를 주지 않는 엔진의 운영자 입력 상한 contextTokens). 서버 목록은 코드에 없다.
-- ai_task_models: (작업, 칸, 순위) 하나에 (연결, 모델) 하나. 작업 이름은 코드 목록(lib/llm/ai-tasks.ts)이 검사한다 — 새 작업은 표를 바꾸지 않고 코드에만 더한다.
--   slot = 같은 작업 안의 나란한 칸(2차 투표자 1·2·3), 다른 작업은 1. rank = 1·2·3(1 을 먼저 쓰고, 쓸 수 없으면 다음). 빈 순위·건너뛴 순위는 코드가 막는다.
--   options = 순위별 덧붙임(예: 분류 CLI 의 effort). 임베딩·재정렬의 「2·3순위도 1순위와 같은 모델」 규칙은 코드 검사다.
CREATE TABLE ai_connections (
  id uuid PRIMARY KEY,
  label varchar(80) NOT NULL,
  kind varchar(8) NOT NULL,
  base_url varchar(400),
  api_key_ciphertext text,
  cli_tool varchar(16),
  cli_models text[] NOT NULL DEFAULT '{}'::text[],
  models jsonb,
  models_read_at timestamptz(3),
  models_error varchar(200),
  device_id varchar(120) NOT NULL,
  capacity_slots integer NOT NULL DEFAULT 1,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_connections_kind_check CHECK (kind IN ('api','cli')),
  CONSTRAINT ai_connections_label_check CHECK (char_length(label) BETWEEN 1 AND 80 AND label = btrim(label) AND label !~ '[[:cntrl:]]'),
  CONSTRAINT ai_connections_api_check CHECK (kind <> 'api' OR (base_url IS NOT NULL AND cli_tool IS NULL AND cardinality(cli_models) = 0)),
  CONSTRAINT ai_connections_cli_check CHECK (kind <> 'cli' OR (base_url IS NULL AND api_key_ciphertext IS NULL AND cli_tool IN ('claude','codex','grok')
    AND cardinality(cli_models) BETWEEN 1 AND 32 AND array_position(cli_models, NULL) IS NULL
    AND models IS NULL AND models_read_at IS NULL AND models_error IS NULL)),
  CONSTRAINT ai_connections_base_url_check CHECK (base_url IS NULL OR base_url ~ '^https?://[^/?#@[:space:][:cntrl:]]+/v1$'),
  CONSTRAINT ai_connections_models_check CHECK (models IS NULL OR (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) <= 512
    AND pg_column_size(models) <= 131072)),
  CONSTRAINT ai_connections_device_check CHECK (char_length(device_id) BETWEEN 1 AND 120 AND device_id = btrim(device_id) AND device_id !~ '[[:cntrl:]]'),
  CONSTRAINT ai_connections_slots_check CHECK (capacity_slots BETWEEN 1 AND 256),
  CONSTRAINT ai_connections_options_check CHECK (jsonb_typeof(options) = 'object' AND pg_column_size(options) <= 8192),
  CONSTRAINT ai_connections_version_check CHECK (version BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_connections_label_idx ON ai_connections (lower(label));
--> statement-breakpoint
CREATE UNIQUE INDEX ai_connections_base_url_idx ON ai_connections (base_url) WHERE base_url IS NOT NULL;
--> statement-breakpoint
CREATE TABLE ai_task_models (
  id bigserial PRIMARY KEY,
  task varchar(64) NOT NULL,
  slot integer NOT NULL DEFAULT 1,
  rank integer NOT NULL,
  connection_id uuid NOT NULL,
  model varchar(200) NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_task_models_connection_fk FOREIGN KEY (connection_id) REFERENCES ai_connections (id) ON DELETE RESTRICT,
  CONSTRAINT ai_task_models_task_check CHECK (task ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT ai_task_models_slot_check CHECK (slot BETWEEN 1 AND 8),
  CONSTRAINT ai_task_models_rank_check CHECK (rank BETWEEN 1 AND 3),
  CONSTRAINT ai_task_models_model_check CHECK (char_length(model) BETWEEN 1 AND 200 AND model = btrim(model) AND model !~ '[[:cntrl:]]'),
  CONSTRAINT ai_task_models_options_check CHECK (jsonb_typeof(options) = 'object' AND pg_column_size(options) <= 4096),
  CONSTRAINT ai_task_models_rank_key UNIQUE (task, slot, rank),
  CONSTRAINT ai_task_models_model_key UNIQUE (task, slot, connection_id, model)
);
--> statement-breakpoint
CREATE INDEX ai_task_models_connection_idx ON ai_task_models (connection_id);
