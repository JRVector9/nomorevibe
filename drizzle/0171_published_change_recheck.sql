-- 0171: 공개분 변경 재검수(2026-11-09 운영자 결정) — 이미 공개된 제품의 수집 내용이 모델이 마지막으로 본 것과 뜻있게 달라지면 1차 순위 모델로
-- 다시 묻고, 거절은 감사 보류와 똑같이 다룬다. 감사 표(product_audit_*)를 그대로 쓴다: 늘 열린 줄 하나(product_audit_campaigns.status = 'rolling')와
-- 그 줄의 항목. 자세한 규칙은 lib/crawl/published-recheck.ts · lib/crawl/published-recheck-change.ts.
--
-- 모두 더하기만 한다. 옛 코드는 새 열을 읽지 않고(drizzle 은 아는 열만 고른다), 옛 감사 항목 쓰기는 round 기본값 0 이라 (감사, 제품) 하나에 항목
-- 하나라는 약속이 그대로다 — (campaign_id, product_id) 유일 색인을 (campaign_id, product_id, round) 로 넓힌다. rolling 행은 'running' 이 아니므로
-- "진행 중인 감사"(status = 'running')를 읽는 곳과 사람이 연 감사가 하나뿐임(product_audit_one_running_idx)은 바뀌지 않는다.
-- rolling 행은 이 migration 이 만들지 않는다 — 새 잡(published-recheck)이 처음 돌 때 만든다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE product_audit_items ADD COLUMN round integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE product_audit_items ADD COLUMN enrolled_at timestamp;
--> statement-breakpoint
ALTER TABLE product_audit_items ADD COLUMN change_summary jsonb;
--> statement-breakpoint
ALTER TABLE product_audit_items ADD COLUMN prompt_version varchar(40);
--> statement-breakpoint
ALTER TABLE product_audit_items ADD COLUMN rules_version varchar(40);
--> statement-breakpoint
CREATE UNIQUE INDEX product_audit_items_campaign_product_round_idx ON product_audit_items (campaign_id, product_id, round);
--> statement-breakpoint
DROP INDEX product_audit_items_campaign_product_idx;
--> statement-breakpoint
CREATE INDEX product_audit_items_rolling_enrolled_idx ON product_audit_items (campaign_id, enrolled_at) WHERE enrolled_at IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX product_audit_one_rolling_idx ON product_audit_campaigns ((true)) WHERE status = 'rolling';
--> statement-breakpoint
CREATE TABLE product_recheck_baselines (
  product_id integer PRIMARY KEY,
  source varchar(20) NOT NULL,
  attempt_id integer,
  item_id integer,
  content jsonb,
  content_hash varchar(64) NOT NULL,
  checked_hash varchar(64),
  judged_at timestamp,
  checked_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT product_recheck_baselines_source_check CHECK (source IN ('first_review', 'recheck', 'seeded')),
  CONSTRAINT product_recheck_baselines_ref_check CHECK ((source = 'first_review') = (attempt_id IS NOT NULL)
    AND (source = 'recheck') = (item_id IS NOT NULL) AND (source = 'first_review' OR content IS NOT NULL))
);
--> statement-breakpoint
COMMENT ON TABLE product_recheck_baselines IS '0171: 공개분 변경 재검수의 기준 — 모델이 마지막으로 본 내용(1차 승인 attempt 를 가리키거나 재검수 답의 내용)과 마지막으로 견준 해시';
