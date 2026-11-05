-- 0166 native API publication classification only. No assignments, capacity policy, grants or domain rows change.
-- Preserve every old rule/ordinal; append exactly five typed branches. Shape/hash checks never issue native or publication authority.
-- Apply separately while DRAINING + active reserved/dispatched=0. Rule-table lock uses 5s lock timeout; no ledger table rewrite/scan.
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $publication_api_preflight$ DECLARE target record; BEGIN
  FOR target IN SELECT * FROM (VALUES ('model_capacity_requests','model_capacity_requests_members_check','1b09a23acfe2a676af7f382575d1e619816983d0889903b2aca9f5a95d9cff0b'),
    ('model_capacity_requests','model_capacity_requests_logical_check','1b09a23acfe2a676af7f382575d1e619816983d0889903b2aca9f5a95d9cff0b'),
    ('model_capacity_requests','model_capacity_requests_dispatch_check','082b92dff40a47e29b416099eab357ca68b386c65c809a148e0b80d0fd1f1849'),
    ('model_capacity_requests','model_capacity_requests_terminal_check','6f50477434793dfce09ac7f81afe7b54bcb4f0feb0a791d6affba0e4772a74d9'),
    ('model_capacity_events','model_capacity_events_terminal_check','f1aa072f64accdb0fac79a8a94a1fc4009844725386ae0b65a682f0eaeb4d36b')) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='0160_ledger_check_rules')<>1
      OR EXISTS(SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='0166_publication_classify_api') THEN
      RAISE EXCEPTION 'publication_api_rule_baseline_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END $publication_api_preflight$;
--> statement-breakpoint
CREATE FUNCTION nmv_publication_classify_api_binding_valid(b jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE t jsonb; r jsonb; j jsonb; m jsonb; k text; v jsonb; keys text[]; repos text[]:=ARRAY[]::text[]; members_json text; input_json text;
  sha text:='^[a-f0-9]{64}$'; uid text:='^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT b ?& ARRAY['kind','version','logicalWorkKey','inputHash','members','provider','model',
    'payloadHash','definitionsHash','configRevision','memberId','routeId','publisherRole','job','wireHash','servingContractHash','totalTokenBound','chargedTokens']
    OR b-ARRAY['kind','version','logicalWorkKey','inputHash','members','provider','model','payloadHash','definitionsHash','configRevision','memberId','routeId','publisherRole','job','wireHash','servingContractHash','totalTokenBound','chargedTokens']<>'{}'::jsonb
    OR b->'kind' IS DISTINCT FROM '"publication_classify_gateway"'::jsonb OR b->'version'<>'1'::jsonb OR b->'routeId' IS DISTINCT FROM '"crawl-publish-classify"'::jsonb
    OR jsonb_typeof(b->'provider') IS DISTINCT FROM 'string' OR b->>'provider' NOT IN ('abcllm','local-direct') THEN RETURN false; END IF;
  FOR k IN SELECT unnest(ARRAY['inputHash','payloadHash','definitionsHash','wireHash','servingContractHash']) LOOP
    IF jsonb_typeof(b->k) IS DISTINCT FROM 'string' OR b->>k !~ sha THEN RETURN false; END IF;
  END LOOP;
  FOR k IN SELECT unnest(ARRAY['configRevision','totalTokenBound','chargedTokens']) LOOP
    v:=b->k;
    IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR v::text !~ '^[0-9]+$' THEN RETURN false; END IF;
    IF v::text::numeric NOT BETWEEN 1 AND 9007199254740991 THEN RETURN false; END IF;
  END LOOP;
  IF b->'totalTokenBound'<>b->'chargedTokens' OR jsonb_typeof(b->'model') IS DISTINCT FROM 'string'
    OR char_length(b->>'model') NOT BETWEEN 1 AND 200 OR b->>'model'<>btrim(b->>'model') OR b->>'model' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  IF jsonb_typeof(b->'logicalWorkKey') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  keys:=nmv_publication_classify_member_keys(b->'members');
  IF NOT nmv_publication_classify_keys_valid(keys) THEN RETURN false; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(b->'members') LOOP
    IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR NOT m ?& ARRAY['candidateId','repo','sourceHash']
      OR m-ARRAY['candidateId','repo','sourceHash']<>'{}'::jsonb OR jsonb_typeof(m->'repo') IS DISTINCT FROM 'string'
      OR char_length(m->>'repo') NOT BETWEEN 1 AND 200 OR m->>'repo'<>btrim(m->>'repo') OR m->>'repo' ~ '[[:cntrl:]]'
      OR jsonb_typeof(m->'sourceHash') IS DISTINCT FROM 'string' OR m->>'sourceHash' !~ sha OR (m->>'repo')=ANY(repos) THEN RETURN false; END IF;
    repos:=array_append(repos,m->>'repo');
  END LOOP;
  IF b->>'logicalWorkKey'<>'bg:publication-classify:' || encode(sha256(convert_to(array_to_json(keys)::text,'UTF8')),'hex') THEN RETURN false; END IF;
  SELECT '[' || string_agg('{"candidateId":' || (value->'candidateId')::text || ',"repo":' || (value->'repo')::text
    || ',"sourceHash":' || (value->'sourceHash')::text || '}',',' ORDER BY (value->>'candidateId')::numeric) || ']'
    INTO members_json FROM jsonb_array_elements(b->'members');
  IF jsonb_typeof(b->'memberId') IS DISTINCT FROM 'string' OR b->>'memberId' !~ uid THEN RETURN false; END IF;
  input_json:='{"configRevision":' || (b->'configRevision')::text || ',"definitionsHash":' || (b->'definitionsHash')::text
    || ',"memberId":' || (b->'memberId')::text || ',"members":' || members_json || ',"model":' || (b->'model')::text
    || ',"payloadHash":' || (b->'payloadHash')::text || ',"provider":' || (b->'provider')::text || '}';
  IF b->>'inputHash'<>encode(sha256(convert_to(input_json,'UTF8')),'hex') THEN RETURN false; END IF;
  r:=b->'publisherRole'; j:=b->'job';
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT r ?& ARRAY['role','instanceId','bootId','release','epoch','kind']
    OR r-ARRAY['role','instanceId','bootId','release','epoch','kind','batchVersion','host','batchEpoch']<>'{}'::jsonb
    OR r->'role' IS DISTINCT FROM '"publisher"'::jsonb OR jsonb_typeof(r->'kind') IS DISTINCT FROM 'string' OR r->>'kind' NOT IN ('primary','standby') OR jsonb_typeof(r->'bootId') IS DISTINCT FROM 'string'
    OR r->>'bootId' !~ uid THEN RETURN false; END IF;
  FOR k IN SELECT unnest(ARRAY['instanceId','release']) LOOP
    IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR char_length(r->>k) NOT BETWEEN 1 AND (CASE WHEN k='release' THEN 200 ELSE 120 END)
      OR r->>k<>btrim(r->>k) OR r->>k ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(r->'epoch') IS DISTINCT FROM 'number' OR (r->'epoch')::text !~ '^[1-9][0-9]*$'
    OR (r->>'epoch')::numeric>9007199254740991 THEN RETURN false; END IF;
  IF r ? 'batchVersion' THEN
    IF r->'batchVersion'<>'1'::jsonb OR NOT r ?& ARRAY['host','batchEpoch'] OR jsonb_typeof(r->'host') IS DISTINCT FROM 'string' OR r->>'host' NOT IN ('m3','mini','oracle-osaka-smoke')
      OR jsonb_typeof(r->'batchEpoch') IS DISTINCT FROM 'number' OR (r->'batchEpoch')::text !~ '^[1-9][0-9]*$'
      OR (r->>'batchEpoch')::numeric>9007199254740991 THEN RETURN false; END IF;
  ELSIF r ?| ARRAY['host','batchEpoch'] THEN RETURN false; END IF;
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR NOT j ?& ARRAY['name','token','requestedVersion']
    OR j-ARRAY['name','token','requestedVersion']<>'{}'::jsonb OR j->'name' IS DISTINCT FROM '"crawl-publish"'::jsonb
    OR jsonb_typeof(j->'token') IS DISTINCT FROM 'string' OR j->>'token' !~ uid OR jsonb_typeof(j->'requestedVersion') IS DISTINCT FROM 'number'
    OR (j->'requestedVersion')::text !~ '^[0-9]+$' OR (j->>'requestedVersion')::numeric>9007199254740991 THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_publication_classify_api_terminal_valid(e jsonb) RETURNS boolean
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
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']
    OR d-ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']<>'{}'::jsonb
    OR NOT nmv_publication_classify_api_binding_valid(d->'binding') OR jsonb_typeof(d->'owner') IS DISTINCT FROM 'object'
    OR NOT (d->'owner') ?& ARRAY['instanceId','bootId'] OR (d->'owner')-ARRAY['instanceId','bootId']<>'{}'::jsonb
    OR d->'owner'->'instanceId'<>d->'binding'->'publisherRole'->'instanceId' OR d->'owner'->'bootId'<>d->'binding'->'publisherRole'->'bootId' THEN RETURN false; END IF;
  FOR k IN SELECT unnest(ARRAY['requestId','token']) LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k !~ uid THEN RETURN false; END IF; END LOOP;
  FOR k IN SELECT unnest(ARRAY['policyHash','bindingHash']) LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k !~ sha THEN RETURN false; END IF; END LOOP;
  FOR k IN SELECT unnest(ARRAY['epoch','revision']) LOOP
    IF jsonb_typeof(d->k) IS DISTINCT FROM 'number' OR (d->k)::text !~ '^[1-9][0-9]*$' OR (d->>k)::numeric>9007199254740991 THEN RETURN false; END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT 'model_capacity_requests','model_capacity_requests_members_check',coalesce(max(ordinal),0)+1,$branch$coalesce((
  class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('abcllm','local-direct')
  AND nmv_publication_classify_keys_valid(logical_member_keys)
  AND logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')
  AND (dispatch_binding IS NULL OR dispatch_binding->>'kind'='publication_classify_gateway')
  AND (terminal_evidence IS NULL OR terminal_evidence->>'kind' IN ('publication_classify_gateway_terminal','gateway_not_started')
    OR (state='withdrawn' AND terminal_evidence->>'kind'='operator_review'
      AND nmv_operator_review_evidence_valid(terminal_evidence)
      AND terminal_evidence->>'requestId'=request_id::text
      AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text)))
),false)$branch$,'0166_publication_classify_api'
  FROM model_capacity_check_rules WHERE table_name='model_capacity_requests' AND constraint_name='model_capacity_requests_members_check';
--> statement-breakpoint
INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT 'model_capacity_requests','model_capacity_requests_logical_check',coalesce(max(ordinal),0)+1,$branch$coalesce((
  class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('abcllm','local-direct')
  AND nmv_publication_classify_keys_valid(logical_member_keys)
  AND logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')
  AND (dispatch_binding IS NULL OR dispatch_binding->>'kind'='publication_classify_gateway')
  AND (terminal_evidence IS NULL OR terminal_evidence->>'kind' IN ('publication_classify_gateway_terminal','gateway_not_started')
    OR (state='withdrawn' AND terminal_evidence->>'kind'='operator_review'
      AND nmv_operator_review_evidence_valid(terminal_evidence)
      AND terminal_evidence->>'requestId'=request_id::text
      AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text)))
),false)$branch$,'0166_publication_classify_api'
  FROM model_capacity_check_rules WHERE table_name='model_capacity_requests' AND constraint_name='model_capacity_requests_logical_check';
--> statement-breakpoint
INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT 'model_capacity_requests','model_capacity_requests_dispatch_check',coalesce(max(ordinal),0)+1,$branch$coalesce((
  coalesce((
  class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('abcllm','local-direct')
  AND nmv_publication_classify_keys_valid(logical_member_keys)
  AND logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')
  AND (dispatch_binding IS NULL OR dispatch_binding->>'kind'='publication_classify_gateway')
  AND (terminal_evidence IS NULL OR terminal_evidence->>'kind' IN ('publication_classify_gateway_terminal','gateway_not_started')
    OR (state='withdrawn' AND terminal_evidence->>'kind'='operator_review'
      AND nmv_operator_review_evidence_valid(terminal_evidence)
      AND terminal_evidence->>'requestId'=request_id::text
      AND terminal_evidence->'owner'=jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text)))
),false)
  AND dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL
  AND state IN ('dispatched','indeterminate','settled') AND nmv_publication_classify_api_binding_valid(dispatch_binding)
  AND dispatch_binding->>'logicalWorkKey'=logical_work_key AND dispatch_binding->>'routeId'=route_id
  AND dispatch_binding->>'provider'=provider AND dispatch_binding->>'model'=model
  AND dispatch_binding->'publisherRole'->>'instanceId'=owner_instance_id AND dispatch_binding->'publisherRole'->>'bootId'=owner_boot_id::text
  AND logical_member_keys=nmv_publication_classify_member_keys(dispatch_binding->'members')
  AND work_key=logical_work_key || ':' || (dispatch_binding->>'inputHash')
),false)$branch$,'0166_publication_classify_api'
  FROM model_capacity_check_rules WHERE table_name='model_capacity_requests' AND constraint_name='model_capacity_requests_dispatch_check';
--> statement-breakpoint
INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT 'model_capacity_requests','model_capacity_requests_terminal_check',coalesce(max(ordinal),0)+1,$branch$coalesce((
  terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NOT NULL AND state='settled'
  AND nmv_publication_classify_api_terminal_valid(terminal_evidence)
  AND terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,
    'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),'token',token::text,
    'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash)
),false)$branch$,'0166_publication_classify_api'
  FROM model_capacity_check_rules WHERE table_name='model_capacity_requests' AND constraint_name='model_capacity_requests_terminal_check';
--> statement-breakpoint
INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
  SELECT 'model_capacity_events','model_capacity_events_terminal_check',coalesce(max(ordinal),0)+1,$branch$coalesce((
  kind='dispatch_settled' AND from_state IN ('dispatched','indeterminate') AND to_state='settled'
  AND nmv_publication_classify_api_terminal_valid(evidence) AND evidence->'dispatch'->>'requestId'=request_id::text
  AND evidence->'dispatch'->'epoch'=to_jsonb(epoch) AND evidence->'dispatch'->'revision'=to_jsonb(revision)
  AND evidence->'dispatch'->>'policyHash'=policy_hash
  AND (evidence->>'kind'<>'gateway_not_started' OR from_state='dispatched')
),false)$branch$,'0166_publication_classify_api'
  FROM model_capacity_check_rules WHERE table_name='model_capacity_events' AND constraint_name='model_capacity_events_terminal_check';
--> statement-breakpoint
DO $publication_api_postflight$ DECLARE target record; BEGIN
  FOR target IN SELECT * FROM (VALUES ('model_capacity_requests','model_capacity_requests_members_check','1b09a23acfe2a676af7f382575d1e619816983d0889903b2aca9f5a95d9cff0b'),
    ('model_capacity_requests','model_capacity_requests_logical_check','1b09a23acfe2a676af7f382575d1e619816983d0889903b2aca9f5a95d9cff0b'),
    ('model_capacity_requests','model_capacity_requests_dispatch_check','082b92dff40a47e29b416099eab357ca68b386c65c809a148e0b80d0fd1f1849'),
    ('model_capacity_requests','model_capacity_requests_terminal_check','6f50477434793dfce09ac7f81afe7b54bcb4f0feb0a791d6affba0e4772a74d9'),
    ('model_capacity_events','model_capacity_events_terminal_check','f1aa072f64accdb0fac79a8a94a1fc4009844725386ae0b65a682f0eaeb4d36b')) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='0166_publication_classify_api')<>1
      OR NOT EXISTS(SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='0166_publication_classify_api'
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.predicate_hash) THEN
      RAISE EXCEPTION 'publication_api_rule_append_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END $publication_api_postflight$;
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');
