-- 공개 화면 읽기 조율(2026-10-06 동시 접속 작업 P2) — 복제본 EXPLAIN 실측 근거
-- JIT: 홈 집계 쿼리 비용이 켜지는 기준(100k)의 93%까지 왔다. 강제로 켜 보니 1.0s → 1.5s 로 오히려 느렸다. 이 DB 에서만 끈다
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$;--> statement-breakpoint
-- CONCURRENTLY 는 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션 전체를 한 트랜잭션으로 돌린다(0024 주석). 두 표 다 작아 잠금은 1초 안이다
-- 공개 목록·개수 열두 곳의 "닿지 않는 제품 빼기"(failures >= 3) — 3만3천 행을 훑던 것을 몇백 행 인덱스로
CREATE INDEX IF NOT EXISTS "product_health_down_slug_idx" ON "product_health" USING btree ("slug") WHERE "product_health"."failures" >= 3;--> statement-breakpoint
-- 홈 '새 버전 낸 프로젝트' 구간 찾기 — 기록만 쌓이는 표라 갱신 부담이 없다
CREATE INDEX IF NOT EXISTS "product_updates_public_released_idx" ON "product_updates" USING btree (coalesce("published_at", "observed_at"),"slug") WHERE "product_updates"."visible" and "product_updates"."maker_deleted_at" is null and "product_updates"."source_kind" in ('github_release', 'maker');
