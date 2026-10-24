/** 0125 adds only this fixed publisher CLI kind. The whole previous CHECK remains the left branch. */
export const publicationClassifyLogicalSql = `(
  class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('claude-cli','codex-cli')
  AND nmv_publication_classify_keys_valid(logical_member_keys)
  AND logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')
  AND (dispatch_binding IS NULL OR dispatch_binding->>'kind'='publication_classify_cli')
  AND (terminal_evidence IS NULL OR terminal_evidence->>'kind'='cli_model_terminal')
)`;
export const publicationClassifyDispatchSql = `(
  ${publicationClassifyLogicalSql}
  AND dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL
  AND state IN ('dispatched','indeterminate','settled','withdrawn') AND nmv_publication_classify_binding_valid(dispatch_binding)
  AND dispatch_binding->>'logicalWorkKey'=logical_work_key AND dispatch_binding->>'routeId'=route_id
  AND dispatch_binding->>'provider'=provider AND dispatch_binding->>'model'=model
  AND dispatch_binding->'publisherRole'->>'instanceId'=owner_instance_id AND dispatch_binding->'publisherRole'->>'bootId'=owner_boot_id::text
  AND logical_member_keys=nmv_publication_classify_member_keys(dispatch_binding->'members')
  AND work_key=logical_work_key || ':' || (dispatch_binding->>'inputHash')
)`;
export const publicationClassifyTerminalSql = `(
  terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NOT NULL AND state='settled'
  AND nmv_publication_classify_terminal_valid(terminal_evidence)
  AND terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,
    'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),'token',token::text,
    'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash)
)`;
export const publicationClassifyEventTerminalSql = `(
  kind='dispatch_settled' AND from_state IN ('dispatched','indeterminate') AND to_state='settled'
  AND nmv_publication_classify_terminal_valid(evidence) AND evidence->'dispatch'->>'requestId'=request_id::text
  AND evidence->'dispatch'->'epoch'=to_jsonb(epoch) AND evidence->'dispatch'->'revision'=to_jsonb(revision)
  AND evidence->'dispatch'->>'policyHash'=policy_hash
)`;
