/** Generate 0166 without DB/environment reads. Existing ledger rules are never replaced. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicationApiLogicalSql, publicationApiDispatchSql, publicationApiTerminalSql, publicationApiEventSql } from '../../lib/llm/publication-classify-api-sql';
const tag = '0166_publication_classify_api';
const original = readFileSync(new URL('../../drizzle/0125_publication_classify_cli.sql', import.meta.url), 'utf8');
const start = original.indexOf('CREATE FUNCTION nmv_publication_classify_binding_valid');
const end = original.indexOf('--> statement-breakpoint', start);
if (start < 0 || end < start) throw new Error('publication_cli_baseline_missing');
let binding = original.slice(start, end).trim().replaceAll('nmv_publication_classify_binding_valid', 'nmv_publication_classify_api_binding_valid')
  .replaceAll('publication_classify_cli', 'publication_classify_gateway').replaceAll("('claude-cli','codex-cli')", "('abcllm','local-direct')")
  .replaceAll("'job','transport','totalTokenBound'", "'job','wireHash','servingContractHash','totalTokenBound'")
  .replace("ARRAY['inputHash','payloadHash','definitionsHash','configHash']", "ARRAY['inputHash','payloadHash','definitionsHash','configHash','wireHash','servingContractHash']");
binding = binding.replaceAll("'configHash','generation','configVersion'", "'configRevision','memberId'")
  .replaceAll("'configHash','generation',\n      'configVersion'", "'configRevision','memberId'")
  .replace("ARRAY['inputHash','payloadHash','definitionsHash','configHash','wireHash','servingContractHash']", "ARRAY['inputHash','payloadHash','definitionsHash','wireHash','servingContractHash']")
  .replace("ARRAY['generation','configVersion','totalTokenBound','chargedTokens']", "ARRAY['configRevision','totalTokenBound','chargedTokens']")
  .replace("(CASE WHEN k='generation' THEN 0 ELSE 1 END)", "1");
const inputStart = binding.indexOf("  input_json:='");
const inputEnd = binding.indexOf("  IF b->>'inputHash'", inputStart);
if (inputStart < 0 || inputEnd < 0) throw new Error('publication_api_input_hash_baseline_missing');
binding = binding.slice(0,inputStart) + `  IF jsonb_typeof(b->'memberId') IS DISTINCT FROM 'string' OR b->>'memberId' !~ uid THEN RETURN false; END IF;
  input_json:='{"configRevision":' || (b->'configRevision')::text || ',"definitionsHash":' || (b->'definitionsHash')::text
    || ',"memberId":' || (b->'memberId')::text || ',"members":' || members_json || ',"model":' || (b->'model')::text
    || ',"payloadHash":' || (b->'payloadHash')::text || ',"provider":' || (b->'provider')::text || '}';
` + binding.slice(inputEnd);
const transportStart = binding.indexOf("  t:=b->'transport';");
const transportEnd = binding.indexOf("  IF jsonb_typeof(r) IS DISTINCT", transportStart);
if (transportStart < 0 || transportEnd < 0) throw new Error('publication_cli_transport_baseline_missing');
binding = binding.slice(0, transportStart) + "  r:=b->'publisherRole'; j:=b->'job';\n" + binding.slice(transportEnd);
if (binding.includes("'transport'") || binding.includes("'configHash'") || binding.includes("'generation'") || binding.includes("'configVersion'") || !binding.includes("'wireHash','servingContractHash'")) throw new Error('publication_api_shape_unexpected');
const oldTerminalStart = original.indexOf('CREATE FUNCTION nmv_publication_classify_terminal_valid');
const oldTerminalEnd = original.indexOf('--> statement-breakpoint', oldTerminalStart);
const oldTerminal = original.slice(oldTerminalStart, oldTerminalEnd);
const handleStart = oldTerminal.indexOf("  IF jsonb_typeof(d)");
const handleEnd = oldTerminal.indexOf("  IF jsonb_typeof(p)");
const handle = oldTerminal.slice(handleStart, handleEnd).replaceAll('nmv_publication_classify_binding_valid', 'nmv_publication_classify_api_binding_valid');
if (!handle.includes("ARRAY['epoch','revision']")) throw new Error('publication_api_handle_baseline_missing');
const terminal = `CREATE FUNCTION nmv_publication_classify_api_terminal_valid(e jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE d jsonb; u jsonb; k text;
  sha text:='^[a-f0-9]{64}$'; uid text:='^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  IF e->>'kind'='gateway_not_started' THEN
    IF NOT e ?& ARRAY['version','kind','dispatch'] OR e-ARRAY['version','kind','dispatch']<>'{}'::jsonb THEN RETURN false; END IF;
  ELSIF e->>'kind'='publication_classify_gateway_terminal' THEN
    IF NOT e ?& ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance']
      OR e-ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance']<>'{}'::jsonb
      OR jsonb_typeof(e->'finishReason') IS DISTINCT FROM 'string'
      OR e->>'finishReason' NOT IN ('stop','length','tool_calls','function_call','content_filter')
      OR jsonb_typeof(e->'responseHash') IS DISTINCT FROM 'string' OR e->>'responseHash' !~ sha THEN RETURN false; END IF;
    u:=e->'actualUsage';
    IF u='null'::jsonb THEN
      IF e->>'provenance' IS DISTINCT FROM 'unknown' THEN RETURN false; END IF;
    ELSE
      IF jsonb_typeof(u) IS DISTINCT FROM 'object' OR NOT u ?& ARRAY['inputTokens','outputTokens','totalTokens']
        OR u-ARRAY['inputTokens','outputTokens','totalTokens']<>'{}'::jsonb OR e->>'provenance' IS DISTINCT FROM 'upstream_reported' THEN RETURN false; END IF;
      FOR k IN SELECT unnest(ARRAY['inputTokens','outputTokens','totalTokens']) LOOP
        IF jsonb_typeof(u->k) IS DISTINCT FROM 'number' OR (u->k)::text !~ '^[0-9]+$' OR (u->>k)::numeric>9007199254740991 THEN RETURN false; END IF;
      END LOOP;
      IF (u->>'inputTokens')::numeric+(u->>'outputTokens')::numeric<>(u->>'totalTokens')::numeric
        OR (u->>'totalTokens')::numeric>(e->'dispatch'->'binding'->>'totalTokenBound')::numeric THEN RETURN false; END IF;
    END IF;
  ELSE RETURN false;
  END IF;
  d:=e->'dispatch';
${handle}
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;`;
const targets = [
  ['model_capacity_requests','model_capacity_requests_members_check',publicationApiLogicalSql],
  ['model_capacity_requests','model_capacity_requests_logical_check',publicationApiLogicalSql],
  ['model_capacity_requests','model_capacity_requests_dispatch_check',publicationApiDispatchSql],
  ['model_capacity_requests','model_capacity_requests_terminal_check',publicationApiTerminalSql],
  ['model_capacity_events','model_capacity_events_terminal_check',publicationApiEventSql],
];
const list = targets.map(([table,name,predicate]) => `('${table}','${name}','${createHash('sha256').update(predicate).digest('hex')}')`).join(',\n    ');
const preflight = `DO $publication_api_preflight$ DECLARE target record; BEGIN
  FOR target IN SELECT * FROM (VALUES ${list}) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='0160_ledger_check_rules')<>1
      OR EXISTS(SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='${tag}') THEN
      RAISE EXCEPTION 'publication_api_rule_baseline_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END $publication_api_preflight$;`;
const postflight = `DO $publication_api_postflight$ DECLARE target record; BEGIN
  FOR target IN SELECT * FROM (VALUES ${list}) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='${tag}')<>1
      OR NOT EXISTS(SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='${tag}'
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.predicate_hash) THEN
      RAISE EXCEPTION 'publication_api_rule_append_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END $publication_api_postflight$;`;
const inserts = targets.map(([table,name,predicate]) => `INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT '${table}','${name}',coalesce(max(ordinal),0)+1,$branch$${predicate}$branch$,'${tag}'
  FROM model_capacity_check_rules WHERE table_name='${table}' AND constraint_name='${name}';`);
writeFileSync(new URL(`../../drizzle/${tag}.sql`, import.meta.url), [
  `-- 0166 native API publication classification only. No assignments, capacity policy, grants or domain rows change.
-- Preserve every old rule/ordinal; append exactly five typed branches. Shape/hash checks never issue native or publication authority.
-- Apply separately while DRAINING + active reserved/dispatched=0. Rule-table lock uses 5s lock timeout; no ledger table rewrite/scan.
SET LOCAL lock_timeout='5s';`,
  'LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;', preflight, binding, terminal, ...inserts, postflight,
  "SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');", "SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');",
].join('\n--> statement-breakpoint\n')+'\n');
