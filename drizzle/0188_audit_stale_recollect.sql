-- 0188 감사 거절의 원본 다시 받기(2026-11-17) — 입력 기한(min(수집, 스캔) + 24시간)이 지나 두 번째 의견(qwen-v2-auto)을 묻지 못하는
-- 감사 거절 항목마다 한 줄(lib/crawl/audit-stale-recollect.ts). 기존 수집 경로(crawl_frontier → crawl-fetch, 스캔 claim)로 원본을 다시 받게 하고
-- 그 결과(끝남·실패 사유·근거가 바뀐 칸)를 남긴다. 새 표만 만든다 — 옛 코드는 이 표를 읽지 않는다. 기존 표의 CHECK·열을 바꾸지 않아 DRAIN 이 필요 없다
-- (product_audit_items 로의 외래 키는 그 표에 SHARE ROW EXCLUSIVE 를 잠깐 잡는다 — lock_timeout 5s).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE product_audit_recollects (
  item_id integer PRIMARY KEY REFERENCES product_audit_items(id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  repo varchar(200) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'waiting',
  requests integer NOT NULL DEFAULT 1,
  requested_at timestamp(3) NOT NULL DEFAULT clock_timestamp(),
  before_fetched_at timestamp(3),
  before_scan_completed_at timestamp(3),
  before_digest jsonb,
  after_fetched_at timestamp(3),
  after_digest jsonb,
  changed_fields jsonb,
  source_changed boolean,
  readme_refreshed boolean,
  failure_code varchar(40),
  failure_detail varchar(400),
  settled_at timestamp(3),
  CONSTRAINT product_audit_recollects_state_check CHECK (state IN ('waiting', 'done', 'failed', 'dropped')),
  CONSTRAINT product_audit_recollects_failure_check CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX product_audit_recollects_waiting_idx ON product_audit_recollects (requested_at) WHERE state = 'waiting';
--> statement-breakpoint
COMMENT ON TABLE product_audit_recollects IS '0188: 입력 기한이 지난 감사 거절의 원본 다시 받기 — 항목마다 한 줄(waiting·done·failed·dropped), 근거가 바뀐 칸을 남긴다';
