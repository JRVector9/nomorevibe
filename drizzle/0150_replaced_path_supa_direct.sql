-- 0150: the release topology gains the 'supa-direct' provider budget. Capacity rev12 (2026-10-30) routed Supa under that alias group
-- while rev10 rows still held the 'supa' group; both are the same Supa vLLM path. Only nmv_replaced_path_required_hops changes;
-- the validator, CHECKs, triggers and rows are untouched.
DO $$
BEGIN
  IF to_regprocedure('public.nmv_replaced_path_required_hops(text,text)') IS NULL
    THEN RAISE EXCEPTION 'replaced_path_predecessor_0145_missing'; END IF;
END $$;
--> statement-breakpoint
-- Topology authority, generated from lib/llm/replaced-path-boundary-contract.ts. A changed path needs a new migration.
CREATE OR REPLACE FUNCTION nmv_replaced_path_required_hops(owner_instance text, budget text) RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN o IS NULL OR p IS NULL THEN NULL ELSE jsonb_build_array(o)||p END
  FROM (SELECT $owners${"m3-reviewer":{"role":"owner","host":"m3ultra","kind":"container","service":"app-copy-primary-hard-drive-b5fhzd"},"m3-text":{"role":"owner","host":"m3ultra","kind":"container","service":"nomorevibe-text-m3-ebmybu"}}$owners$::jsonb->owner_instance AS o, $providers${"abcllm-supa":[{"role":"gateway-m3","host":"m3ultra","kind":"container","service":"app-reboot-optical-matrix-3bl2a4"},{"role":"gateway-mini","host":"9mini","kind":"container","service":"app-hack-optical-monitor-v1ioak"},{"role":"provider","host":"supa","kind":"systemd","service":"vllm.service"}],"abcllm-m3-mlx":[{"role":"gateway-m3","host":"m3ultra","kind":"container","service":"app-reboot-optical-matrix-3bl2a4"},{"role":"gateway-mini","host":"9mini","kind":"container","service":"app-hack-optical-monitor-v1ioak"},{"role":"provider","host":"m3ultra","kind":"launchd","service":"gui/501/com.jr.deepseek"}],"abcllm-m1-qwen":[{"role":"gateway-m3","host":"m3ultra","kind":"container","service":"app-reboot-optical-matrix-3bl2a4"},{"role":"gateway-mini","host":"9mini","kind":"container","service":"app-hack-optical-monitor-v1ioak"},{"role":"relay","host":"m1studio","kind":"launchd","service":"system/bot.brut.nmv-llm-relay"},{"role":"provider","host":"m1studio","kind":"listener","service":"tcp:127.0.0.1:8000"}],"supa-direct":[{"role":"gateway-m3","host":"m3ultra","kind":"container","service":"app-reboot-optical-matrix-3bl2a4"},{"role":"gateway-mini","host":"9mini","kind":"container","service":"app-hack-optical-monitor-v1ioak"},{"role":"provider","host":"supa","kind":"systemd","service":"vllm.service"}]}$providers$::jsonb->budget AS p) x
$$;
