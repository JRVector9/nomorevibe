-- 0181: 사람 확인 묶음의 표본 관문과 일괄 결정 기록(2026-11-12 운영 콘솔 개편 조각 3b).
-- 운영자가 묶음(두 모델 모두 승인 · 두 모델 모두 거절 · 저장소가 없어짐)에서 무작위 표본을 한 건씩 보고 「맞음/아님」을 누른 기록과,
-- 표본이 모두 맞을 때만 여는 일괄 결정의 결과(결정 기록 id 목록)·묶음째 되돌림을 한 줄에 둔다.
-- 결정 자체는 기존 경로가 남긴다(overrideCandidate → crawl_review_attempts admin_override, operations_audit). 이 표는 묶음 id 와 관문 상태만 든다.
-- members 는 표본을 뽑을 때 고정한 대상(후보 id·저장소·입력·원본·후보 해시)이다 — 그 뒤에 묶음에 들어온 후보는 이번 일괄에 들지 않고,
-- 그 사이 바뀐 후보는 overrideCandidate 가 해시로 거절한다.
-- 새 표만 만든다. 옛 코드는 이 표를 읽지 않는다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE human_batch_gates (
  id serial PRIMARY KEY,
  batch_key varchar(32) NOT NULL,
  actor varchar(120) NOT NULL,
  members jsonb NOT NULL,
  snapshot_hash varchar(64) NOT NULL,
  sample_ids integer[] NOT NULL,
  verdicts jsonb NOT NULL DEFAULT '{}'::jsonb,
  excluded integer[] NOT NULL DEFAULT '{}'::integer[],
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  executed_at timestamp,
  decision varchar(16),
  result jsonb,
  undone_at timestamp,
  undone_by varchar(120),
  undo_result jsonb,
  CONSTRAINT human_batch_gates_key_check CHECK (batch_key IN ('agreed_approve', 'agreed_reject', 'repo_deleted')),
  CONSTRAINT human_batch_gates_members_check CHECK (jsonb_typeof(members) = 'array' AND jsonb_array_length(members) BETWEEN 1 AND 50),
  CONSTRAINT human_batch_gates_sample_check CHECK (cardinality(sample_ids) BETWEEN 1 AND 5),
  CONSTRAINT human_batch_gates_verdicts_check CHECK (jsonb_typeof(verdicts) = 'object'),
  CONSTRAINT human_batch_gates_decision_check CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  CONSTRAINT human_batch_gates_executed_check CHECK ((executed_at IS NULL) = (decision IS NULL)),
  CONSTRAINT human_batch_gates_undo_check CHECK ((undone_at IS NULL OR (executed_at IS NOT NULL AND result IS NOT NULL)) AND (undone_at IS NULL) = (undone_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX human_batch_gates_actor_key_idx ON human_batch_gates (actor, batch_key, id);
--> statement-breakpoint
CREATE INDEX human_batch_gates_executed_idx ON human_batch_gates (executed_at) WHERE executed_at IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE human_batch_gates IS '0181: 사람 확인 묶음 — 운영자별 표본 관문(고정 대상·표본·맞음/아님)과 일괄 결정 결과·묶음째 되돌림. 결정 기록은 crawl_review_attempts·operations_audit';
