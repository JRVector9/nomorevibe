-- Repeated model choices are separate fallback ranks or workload positions.
-- Execution still requires the existing shared device admission and capacity ledger.
-- Keep rank/position uniqueness, member IDs, and independent AI2 vote checks.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE ai_task_models DROP CONSTRAINT ai_task_models_model_key;
--> statement-breakpoint
ALTER TABLE ai_task_pool_members DROP CONSTRAINT ai_task_pool_members_engine_key;
