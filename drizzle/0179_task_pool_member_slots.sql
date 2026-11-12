-- 0179 (2026-11-12, 운영 콘솔 개편 2b 「동시에」): 작업 분산(workload_pool) 구성원별 칸 수와 예비 순위.
-- ai_task_pool_members.max_slots: 이 단계에 이 구성원이 내줄 칸 수(이 단계의 동시 호출 상한, 1~8). NULL = 정하지 않음 — 예전 작업 분산 그대로
--   (단계 동시 수를 구성원끼리 나눠 씀). 칸 수를 적은 묶음만 칸 수의 합만큼 함께 돈다(lib/llm/ai-task-resolver.ts TextTaskRanks).
-- ai_task_execution_configs.reserve_ranks: 묶음이 모두 설 때 이 작업의 순위(ai_task_models 1·2·3)를 예비로 쓴다. 기본 false(예비 없음).
-- 두 칸 모두 기본값이 지금 동작이다(NULL·false) — 기존 행은 그대로 돈다. 장부·계약·정책·순위 행은 건드리지 않는다.
-- 잠금: 작은 설정 표 둘의 ACCESS EXCLUSIVE(ADD COLUMN — NULL 칸과 상수 기본값이라 다시 쓰지 않는다, CHECK 검증은 몇 행), lock_timeout 5초.
-- 옛 코드는 새 칸을 읽지 않으므로 이 마이그레이션이 먼저 들어가도 그대로 돈다. 새 코드의 실행 스냅숏은 칸이 없어도 읽힌다(to_jsonb).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE ai_task_pool_members ADD COLUMN max_slots integer;
--> statement-breakpoint
ALTER TABLE ai_task_pool_members ADD CONSTRAINT ai_task_pool_members_max_slots_check CHECK (max_slots IS NULL OR max_slots BETWEEN 1 AND 8);
--> statement-breakpoint
ALTER TABLE ai_task_execution_configs ADD COLUMN reserve_ranks boolean NOT NULL DEFAULT false;
