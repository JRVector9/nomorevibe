-- 0172: 결과 미확정 점유(소유자 결정 2026-11-10) — indeterminate 행은 보낸 시각(dispatched_at, 없으면 미확정이 된 시각 updated_at)부터 유지 시간
-- (runtime_settings capacity.unknownHoldSeconds, 기본 600초) 동안 장비 칸·모델 상한·경로 몫·도우미 칸에 dispatched 처럼 센다(lib/llm/capacity-unknown-hold.ts).
-- 입장 TX 는 control 행 잠금 아래에서 장비마다 그 행을 센다. 예전 부분 색인(model_capacity_requests_active_idx)은 reserved·dispatched 만 담아
-- indeterminate 쪽은 장부 전체를 훑게 되므로, 그 판정 하나만 담는 부분 색인을 더한다: (group_id, 유지 기준 시각) WHERE state = 'indeterminate'.
-- 식 coalesce(dispatched_at, updated_at) 는 heldUnknownSql 의 글자와 같아야 범위 조건으로 쓰인다(기준 시각은 문장마다 한 번 계산하는 부분질의다).
--
-- 더하기만 한다: 열·CHECK·트리거·다른 색인·행은 그대로다(큰 CHECK 재구성 없음). 옛 코드는 이 색인을 쓰지 않고, 새 코드는 이 색인이 없어도 맞게 돌지만
-- 장부를 훑으므로 배포 순서는 migrate → 앱이다. CONCURRENTLY 는 쓸 수 없다(마이그레이터가 밀린 마이그레이션을 한 트랜잭션으로 돌린다 — 0058·0110 주석).
-- 잠금: CREATE INDEX 는 model_capacity_requests 에 SHARE 를 잡아 만드는 동안 장부 쓰기(입장·정산)를 기다리게 한다(읽기는 막지 않는다). 부분 색인이라
-- 담는 행은 미확정 행 수(수십~수백)뿐이지만 만들 때 표 전체를 한 번 훑는다. 장부 쓰기가 몇 초 멈춰도 되는 때(DRAIN 창 권장)에 돌린다 —
-- 앞선 긴 트랜잭션이 표를 쥐고 있으면 lock_timeout(5s)이 끊고 실패한다(다시 돌리면 된다, IF NOT EXISTS).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_capacity_requests_unknown_hold_idx ON model_capacity_requests (group_id, (coalesce(dispatched_at, updated_at))) WHERE state = 'indeterminate';
