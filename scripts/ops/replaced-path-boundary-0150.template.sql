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
  FROM (SELECT $owners$__OWNERS__$owners$::jsonb->owner_instance AS o, $providers$__PROVIDERS__$providers$::jsonb->budget AS p) x
$$;
