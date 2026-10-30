/**
 * 사람 검토 완료(operator_review) 정산의 CHECK 가지(0151). lib/db/operations-schema.ts 가 이전 CHECK 전체에 `OR (가지)` 로 붙이고,
 * drizzle/0151_indeterminate_no_hold.sql 은 같은 문자열을 `$ai2_local$…$ai2_local$` 안에 둔다(tests/local-model-capacity-schema.test.ts 가
 * 두 쪽이 같음을 검사한다). 모양 검증은 SQL 함수 하나에 모아 세 CHECK 가 같은 판정을 쓴다.
 */
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const ISO_MILLIS = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const KEYS = "ARRAY['version','kind','requestId','owner','fromState','operator','note','reviewedAt']";

/** `nmv_operator_review_evidence_valid(jsonb)` — evidence 모양만 본다(행과의 일치는 CHECK 가지가 본다). */
export const operatorReviewFunctionSql = `CREATE OR REPLACE FUNCTION nmv_operator_review_evidence_valid(evidence jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(evidence)='object' AND evidence ?& ${KEYS} AND evidence - ${KEYS}='{}'::jsonb
    AND evidence->'version'='1'::jsonb AND evidence->'kind'='"operator_review"'::jsonb AND evidence->'fromState'='"indeterminate"'::jsonb
    AND jsonb_typeof(evidence->'requestId')='string' AND (evidence->>'requestId') ~ '${UUID}'
    AND jsonb_typeof(evidence->'owner')='object' AND (evidence->'owner') ?& ARRAY['instanceId','bootId'] AND (evidence->'owner') - ARRAY['instanceId','bootId']='{}'::jsonb
    AND jsonb_typeof(evidence->'owner'->'instanceId')='string' AND char_length(evidence->'owner'->>'instanceId') BETWEEN 1 AND 120
    AND jsonb_typeof(evidence->'owner'->'bootId')='string' AND (evidence->'owner'->>'bootId') ~ '${UUID}'
    AND jsonb_typeof(evidence->'operator')='string' AND char_length(evidence->>'operator') BETWEEN 1 AND 120
    AND jsonb_typeof(evidence->'note')='string' AND char_length(evidence->>'note') BETWEEN 1 AND 400
    AND jsonb_typeof(evidence->'reviewedAt')='string' AND (evidence->>'reviewedAt') ~ '${ISO_MILLIS}', false)
$$;`;

/** 행과 근거의 일치: 요청·owner 가 같고, 검토는 indeterminate 에서만 나온다. */
const rowMatch = "terminal_evidence->>'requestId'=request_id::text AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text)";

/** model_capacity_requests_dispatch_check 가지: binding 을 가진 행이 검토로 withdrawn 이 될 수 있다(binding·C 그대로). */
export const operatorReviewDispatchSql = `coalesce(state='withdrawn' AND dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL AND terminal_evidence IS NOT NULL AND terminal_evidence->>'kind'='operator_review' AND nmv_operator_review_evidence_valid(terminal_evidence) AND ${rowMatch},false)`;
/** model_capacity_requests_terminal_check 가지: withdrawn + operator_review 근거(해시 있음, settled_at 없음). */
export const operatorReviewTerminalSql = `coalesce(state='withdrawn' AND terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NULL AND token IS NOT NULL AND terminal_evidence->>'kind'='operator_review' AND nmv_operator_review_evidence_valid(terminal_evidence) AND ${rowMatch},false)`;
/** model_capacity_events_kind_check 가지: dispatch_reviewed indeterminate→withdrawn, reason 없음, 같은 근거. */
export const operatorReviewEventSql = "coalesce(kind='dispatch_reviewed' AND from_state='indeterminate' AND to_state='withdrawn' AND reason IS NULL AND nmv_operator_review_evidence_valid(evidence) AND evidence->>'requestId'=request_id::text,false)";
