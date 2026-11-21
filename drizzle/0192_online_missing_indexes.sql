-- 0192 빠진 인덱스 다섯(2026-11-21 전수 점검 W0-3 · W1-2).
--
-- 운영 적용은 두 걸음이다. ① scripts/ops/online-index.ts 가 이 파일의 인덱스 문을 트랜잭션 밖에서 CONCURRENTLY 로 먼저 만든다. ② 그 뒤의 migrate 는 기록만 한다.
-- 마이그레이터는 밀린 마이그레이션 전체를 한 트랜잭션으로 돌려 CONCURRENTLY 를 쓸 수 없고(0058·0109 주석), 보통 인덱스 만들기는 SHARE 잠금으로
-- 빌드 내내 그 표의 쓰기를 막는다. 네 표 모두 운영에서 7만~51만 행이다(장부 model_capacity_requests 는 2.4GB).
--
-- 인덱스 정의의 원천은 아래 본문의 인덱스 문 다섯 줄이다 — 도구가 그 문장을 그대로 읽어 CONCURRENTLY 만 끼운다. 이름·표·식을 바꾸면 두 가드의 목록과
-- lib/db 스키마 선언도 함께 바꾼다(tests/online-index-migration.test.ts 가 셋을 맞춰 본다).
--
-- 맨 앞 가드: 인덱스가 아직 없는데 표가 크면(통계 5만 행 이상 또는 본문 32MB 이상) 멈춘다 — 누가 도구 없이 migrate 해도 쓰기 잠금을 오래 쥐지 않게.
-- 본문: 인덱스가 이미 있으면 인덱스 문을 아예 실행하지 않는다. IF NOT EXISTS 만으로는 이름을 보기 전에 표의 SHARE 잠금부터 잡는다(실측) — 진행 중인
--   쓰기 트랜잭션을 기다리고, 잡은 뒤에는 이 트랜잭션이 끝날 때까지 새 쓰기를 막는다. 빈 DB·시험 DB 에서는 그대로 만든다(표가 작다).
-- 끝 가드: 다섯 인덱스가 제 표에 유효하게 있어야 한다 — CONCURRENTLY 가 실패해 남은 INVALID 인덱스를 «있음» 으로 기록하고 지나가지 않게.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $guard$
DECLARE
  pending text;
BEGIN
  SELECT string_agg(v.idx, ', ' ORDER BY v.idx) INTO pending
  FROM (VALUES
    ('second_reviews', 'second_reviews_first_attempt_idx'),
    ('second_reviews', 'second_reviews_fallback_for_idx'),
    ('model_capacity_requests', 'model_capacity_requests_logical_key_idx'),
    ('pipeline_item_leases', 'pipeline_item_leases_ai2_candidate_idx'),
    ('agent_repository_scans', 'agent_scans_repository_latest_idx')) AS v(tbl, idx)
  WHERE to_regclass(v.idx) IS NULL
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass(v.tbl)
      AND (c.reltuples >= 50000 OR pg_relation_size(c.oid) >= 33554432));
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION '0192 stopped: large table without its index (%). Build the indexes of this migration online first with scripts/ops/online-index.ts (execute mode), then migrate again', pending
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guard$;
--> statement-breakpoint
DO $build$
BEGIN
  -- 발행 관문(second-review-workload.ts secondReviewPoolApprovedSql · agent-review-repository.ts secondApproved)과 2차 심사 claim·기록의 행 잠금
  -- (second-review-input.ts lockSecondReviewRows)이 「이 1차 시도의 2차 표」를 찾는다. 1차 시도 하나에 표는 몇 줄뿐이다
  IF to_regclass('second_reviews_first_attempt_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "second_reviews_first_attempt_idx" ON "second_reviews" ("first_attempt_id") WHERE "first_attempt_id" IS NOT NULL;
  END IF;
  -- 대체 표 사슬: claim 의 chainIsBusy(second-review-ownership.ts)와 정리 쿼리의 child.fallback_for_id = 뿌리 id(second-review.ts closeSettledSecondReviews)
  IF to_regclass('second_reviews_fallback_for_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "second_reviews_fallback_for_idx" ON "second_reviews" ("fallback_for_id") WHERE "fallback_for_id" IS NOT NULL;
  END IF;
  -- 장부 fence 의 「같은 단계를 이미 보냄」 가지(capacity-repository.ts crawlTaglineFence·searchVerifyFence: logical_work_key = … AND state IN 보낸 상태).
  -- model_capacity_requests_logical_active_idx 는 reserved·dispatched 만 담아 이 가지를 받치지 못한다 — OR 의 한 가지에 길이 없으면 문장 전체가 표를 읽는다
  IF to_regclass('model_capacity_requests_logical_key_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "model_capacity_requests_logical_key_idx" ON "model_capacity_requests" ("logical_work_key") WHERE "logical_work_key" IS NOT NULL;
  END IF;
  -- 2차 표 아이템 점검(second-review.ts candidateItemsBusy 등): stage = 'ai2' AND (binding->>'candidateId' = … OR work_key IN (…)).
  -- 식과 술어는 쿼리와 글자 그대로 맞아야 한다
  IF to_regclass('pipeline_item_leases_ai2_candidate_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "pipeline_item_leases_ai2_candidate_idx" ON "pipeline_item_leases" (("binding"->>'candidateId')) WHERE "stage" = 'ai2';
  END IF;
  -- 저장소의 최신 스캔 한 줄(agent-review-repository.ts currentReviewSource 의 LATERAL · agents/claims.ts latestScanSql):
  -- repository_key = … AND scope = '' ORDER BY started_at DESC, id DESC LIMIT 1 — 정렬 없이 첫 항목 하나만 읽는다
  IF to_regclass('agent_scans_repository_latest_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "agent_scans_repository_latest_idx" ON "agent_repository_scans" ("repository_key", "scope", "started_at" DESC, "id" DESC);
  END IF;
END
$build$;
--> statement-breakpoint
DO $guard$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(v.idx, ', ' ORDER BY v.idx) INTO broken
  FROM (VALUES
    ('second_reviews', 'second_reviews_first_attempt_idx'),
    ('second_reviews', 'second_reviews_fallback_for_idx'),
    ('model_capacity_requests', 'model_capacity_requests_logical_key_idx'),
    ('pipeline_item_leases', 'pipeline_item_leases_ai2_candidate_idx'),
    ('agent_repository_scans', 'agent_scans_repository_latest_idx')) AS v(tbl, idx)
  WHERE NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass(v.idx) AND i.indrelid = to_regclass(v.tbl)
    AND i.indisvalid AND i.indisready AND i.indislive);
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '0192 stopped: index missing or INVALID (%). Run scripts/ops/online-index.ts for this migration (execute mode drops an INVALID remnant and rebuilds it), then migrate again', broken
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guard$;
