-- 0174 (2026-11-11): gateway_http_rejected. A text-route gateway dispatch (the seven direct HTTP routes: product-search-profile, reason-translate,
-- product-translate, product-tagline-ko, crawl-tagline, product-search-verify, search-query-translate) that received a complete HTTP response whose
-- status says the provider rejected the request without processing it (429 rate limit, 401/403 auth) settles dispatched -> settled with
-- {version, kind:"gateway_http_rejected", dispatch, status, retryAfterMs} evidence equal to the row's own handle and binding (C unchanged, no usage).
-- Until now such a response stayed indeterminate (transport_unknown) and held its device slot for capacity.unknownHoldSeconds (600 s): one EXAONE 429
-- blocked the limit-1 device for ten minutes (production 2026-11-11). Timeouts, resets, aborted bodies and every 5xx stay indeterminate.
-- 0160 moved the composed ledger CHECKs to model_capacity_check_rules rows + nmv_<table>_check_guard() triggers, so this file does not ALTER TABLE:
-- it inserts one branch (lib/llm/gateway-http-rejected-sql.ts, byte for byte) as the next ordinal of the requests terminal and events terminal
-- constraints and calls nmv_model_capacity_check_guard_rebuild for both tables. The dispatch/logical/members/events-kind/reason CHECKs already accept a
-- settled text row and a dispatch_settled event with reason NULL. Idempotent: a constraint that already has a 0174 row (or has no 0160 row) is skipped.
-- Locks: SHARE ROW EXCLUSIVE on the small model_capacity_check_rules table (5 s lock_timeout) and CREATE OR REPLACE FUNCTION of the two guard trigger
-- functions (same OIDs, triggers unchanged). No lock, scan or rewrite of model_capacity_requests/events; no ledger row, grant, index or column.
-- The branches only widen what the guards accept and old code never writes this kind, so it is safe to apply while old code runs. Deploy the writers
-- only after it: before it, the new settlement fails the guard (23514) and the caller marks the row commit_unknown.
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO model_capacity_check_rules (table_name, constraint_name, ordinal, predicate, source)
SELECT 'model_capacity_requests', 'model_capacity_requests_terminal_check', COALESCE(MAX(ordinal), 0) + 1, $branch$coalesce(((state='settled' AND terminal_evidence IS NOT NULL AND terminal_evidence_hash IS NOT NULL AND settled_at IS NOT NULL) AND (terminal_evidence_hash ~ '^[a-f0-9]{64}$') AND (dispatch_binding IS NOT NULL AND dispatch_binding_hash IS NOT NULL AND dispatched_at IS NOT NULL) AND (jsonb_typeof(dispatch_binding)='object') AND (dispatch_binding->'version'='1'::jsonb) AND (dispatch_binding->>'kind' IN ('text_profile_gateway','reason_translation_gateway','product_translation_gateway','product_tagline_ko_gateway','crawl_tagline_gateway','search_verify_gateway','websearch_query_gateway')) AND (CASE WHEN jsonb_typeof(terminal_evidence)='object' THEN terminal_evidence ?& ARRAY['version','kind','dispatch','status','retryAfterMs'] AND terminal_evidence - ARRAY['version','kind','dispatch','status','retryAfterMs']='{}'::jsonb ELSE false END) AND (terminal_evidence->'version'='1'::jsonb) AND (terminal_evidence->'kind'='"gateway_http_rejected"'::jsonb) AND (terminal_evidence->'status' IN ('401'::jsonb,'403'::jsonb,'429'::jsonb)) AND (CASE WHEN terminal_evidence->'retryAfterMs'='null'::jsonb THEN true WHEN jsonb_typeof(terminal_evidence->'retryAfterMs')='number' AND (terminal_evidence->>'retryAfterMs') ~ '^(0|[1-9][0-9]{0,6})$' THEN (terminal_evidence->>'retryAfterMs')::integer <= 3600000 ELSE false END) AND (terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),'token',token::text,'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash))),false)$branch$, '0174_gateway_http_rejected'
  FROM model_capacity_check_rules
 WHERE table_name = 'model_capacity_requests' AND constraint_name = 'model_capacity_requests_terminal_check'
HAVING COUNT(*) FILTER (WHERE source = '0160_ledger_check_rules') >= 1
   AND COUNT(*) FILTER (WHERE source = '0174_gateway_http_rejected') = 0;

--> statement-breakpoint
INSERT INTO model_capacity_check_rules (table_name, constraint_name, ordinal, predicate, source)
SELECT 'model_capacity_events', 'model_capacity_events_terminal_check', COALESCE(MAX(ordinal), 0) + 1, $branch$coalesce(((kind='dispatch_settled' AND evidence IS NOT NULL AND from_state='dispatched' AND to_state='settled') AND (CASE WHEN jsonb_typeof(evidence)='object' THEN evidence ?& ARRAY['version','kind','dispatch','status','retryAfterMs'] AND evidence - ARRAY['version','kind','dispatch','status','retryAfterMs']='{}'::jsonb ELSE false END) AND (evidence->'version'='1'::jsonb) AND (evidence->'kind'='"gateway_http_rejected"'::jsonb) AND (evidence->'status' IN ('401'::jsonb,'403'::jsonb,'429'::jsonb)) AND (CASE WHEN evidence->'retryAfterMs'='null'::jsonb THEN true WHEN jsonb_typeof(evidence->'retryAfterMs')='number' AND (evidence->>'retryAfterMs') ~ '^(0|[1-9][0-9]{0,6})$' THEN (evidence->>'retryAfterMs')::integer <= 3600000 ELSE false END) AND (CASE WHEN jsonb_typeof(evidence->'dispatch')='object' THEN (evidence->'dispatch') ?& ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash'] AND (evidence->'dispatch') - ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']='{}'::jsonb ELSE false END) AND (CASE WHEN jsonb_typeof(evidence->'dispatch'->'owner')='object' THEN (evidence->'dispatch'->'owner') ?& ARRAY['instanceId','bootId'] AND (evidence->'dispatch'->'owner') - ARRAY['instanceId','bootId']='{}'::jsonb ELSE false END) AND (jsonb_typeof(evidence->'dispatch'->'owner'->'instanceId')='string') AND (jsonb_typeof(evidence->'dispatch'->'owner'->'bootId')='string' AND (evidence->'dispatch'->'owner'->>'bootId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND (jsonb_typeof(evidence->'dispatch'->'token')='string' AND (evidence->'dispatch'->>'token') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND (jsonb_typeof(evidence->'dispatch'->'bindingHash')='string' AND (evidence->'dispatch'->>'bindingHash') ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(evidence->'dispatch'->'binding')='object') AND (evidence->'dispatch'->'binding'->'version'='1'::jsonb) AND (evidence->'dispatch'->'binding'->>'kind' IN ('text_profile_gateway','reason_translation_gateway','product_translation_gateway','product_tagline_ko_gateway','crawl_tagline_gateway','search_verify_gateway','websearch_query_gateway')) AND (evidence->'dispatch'->>'requestId'=request_id::text) AND (evidence->'dispatch'->'epoch'=to_jsonb(epoch)) AND (evidence->'dispatch'->'revision'=to_jsonb(revision)) AND (evidence->'dispatch'->>'policyHash'=policy_hash)),false)$branch$, '0174_gateway_http_rejected'
  FROM model_capacity_check_rules
 WHERE table_name = 'model_capacity_events' AND constraint_name = 'model_capacity_events_terminal_check'
HAVING COUNT(*) FILTER (WHERE source = '0160_ledger_check_rules') >= 1
   AND COUNT(*) FILTER (WHERE source = '0174_gateway_http_rejected') = 0;

--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');

--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');
