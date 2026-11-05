/** 0166 appends only the native publication API kind; all predecessor predicates remain untouched. */
export const publicationApiLogicalSql = `coalesce((
  class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('abcllm','local-direct')
  AND nmv_publication_classify_keys_valid(logical_member_keys)
  AND logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')
  AND (dispatch_binding IS NULL OR dispatch_binding->>'kind'='publication_classify_gateway')
  AND (terminal_evidence IS NULL OR terminal_evidence->>'kind' IN ('publication_classify_gateway_terminal','gateway_not_started')
    OR (state='withdrawn' AND terminal_evidence->>'kind'='operator_review'
      AND nmv_operator_review_evidence_valid(terminal_evidence)
      AND terminal_evidence->>'requestId'=request_id::text
      AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text)))
),false)`;
export const publicationApiDispatchSql = `coalesce((
  ${publicationApiLogicalSql}
  AND dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL
  AND state IN ('dispatched','indeterminate','settled') AND nmv_publication_classify_api_binding_valid(dispatch_binding)
  AND dispatch_binding->>'logicalWorkKey'=logical_work_key AND dispatch_binding->>'routeId'=route_id
  AND dispatch_binding->>'provider'=provider AND dispatch_binding->>'model'=model
  AND dispatch_binding->'publisherRole'->>'instanceId'=owner_instance_id AND dispatch_binding->'publisherRole'->>'bootId'=owner_boot_id::text
  AND logical_member_keys=nmv_publication_classify_member_keys(dispatch_binding->'members')
  AND work_key=logical_work_key || ':' || (dispatch_binding->>'inputHash')
),false)`;
export const publicationApiTerminalSql = `coalesce((
  terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NOT NULL AND state='settled'
  AND nmv_publication_classify_api_terminal_valid(terminal_evidence)
  AND terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,
    'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),'token',token::text,
    'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash)
),false)`;
export const publicationApiEventSql = `coalesce((
  kind='dispatch_settled' AND from_state IN ('dispatched','indeterminate') AND to_state='settled'
  AND nmv_publication_classify_api_terminal_valid(evidence) AND evidence->'dispatch'->>'requestId'=request_id::text
  AND evidence->'dispatch'->'epoch'=to_jsonb(epoch) AND evidence->'dispatch'->'revision'=to_jsonb(revision)
  AND evidence->'dispatch'->>'policyHash'=policy_hash
  AND (evidence->>'kind'<>'gateway_not_started' OR from_state='dispatched')
),false)`;
