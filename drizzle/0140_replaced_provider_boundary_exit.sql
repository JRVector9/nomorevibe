CREATE FUNCTION nmv_replaced_provider_shape_valid(v jsonb, s jsonb, depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text; x jsonb; n numeric; matched integer; i integer;
BEGIN
  IF depth>16 OR v IS NULL THEN RETURN false; END IF;
  IF s ? 'const' AND v IS DISTINCT FROM s->'const' THEN RETURN false; END IF;
  IF s ? 'enum' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'enum') a WHERE a=v) THEN RETURN false; END IF;
  IF s ? 'allOf' THEN
    RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'allOf') a WHERE NOT nmv_replaced_provider_shape_valid(v,jsonb_build_object('type',s->'type')||a,depth+1));
  END IF;
  IF s ? 'anyOf' THEN
    RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(s->'anyOf') a WHERE nmv_replaced_provider_shape_valid(v,a,depth+1));
  END IF;
  IF s ? 'oneOf' THEN
    SELECT count(*) INTO matched FROM jsonb_array_elements(s->'oneOf') a WHERE nmv_replaced_provider_shape_valid(v,a,depth+1);
    RETURN matched=1;
  END IF;
  IF s->>'type'='object' THEN
    IF jsonb_typeof(v)<>'object' OR NOT nmv_boundary_keys(v,ARRAY(SELECT jsonb_array_elements_text(s->'required'))) THEN RETURN false; END IF;
    FOR k,x IN SELECT * FROM jsonb_each(s->'properties') LOOP IF NOT nmv_replaced_provider_shape_valid(v->k,x,depth+1) THEN RETURN false; END IF; END LOOP;
  ELSIF s->>'type'='array' THEN
    IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)<(s->>'minItems')::int OR jsonb_array_length(v)>(s->>'maxItems')::int THEN RETURN false; END IF;
    FOR i IN 0..jsonb_array_length(v)-1 LOOP
      IF s ? 'prefixItems' THEN
        IF NOT nmv_replaced_provider_shape_valid(v->i,s->'prefixItems'->i,depth+1) THEN RETURN false; END IF;
      ELSIF NOT nmv_replaced_provider_shape_valid(v->i,s->'items',depth+1) THEN RETURN false; END IF;
    END LOOP;
  ELSIF s->>'type'='string' THEN
    IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF;
    k:=v#>>'{}';
    IF s ? 'minLength' AND char_length(k)<(s->>'minLength')::int OR s ? 'maxLength' AND char_length(k)>(s->>'maxLength')::int
      OR s ? 'pattern' AND k !~ (s->>'pattern') THEN RETURN false; END IF;
  ELSIF s->>'type'='integer' OR s->>'type'='number' THEN
    IF jsonb_typeof(v)<>'number' THEN RETURN false; END IF;
    n:=(v#>>'{}')::numeric;
    IF s->>'type'='integer' AND trunc(n)<>n OR s ? 'minimum' AND n<(s->>'minimum')::numeric
      OR s ? 'exclusiveMinimum' AND n<=(s->>'exclusiveMinimum')::numeric OR s ? 'maximum' AND n>(s->>'maximum')::numeric THEN RETURN false; END IF;
  ELSIF s->>'type'='null' THEN IF v<>'null'::jsonb THEN RETURN false; END IF;
  ELSIF s->>'type'='boolean' THEN IF jsonb_typeof(v)<>'boolean' THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

--> statement-breakpoint
-- Reviewed replacement evidence; no stop/restart, usage refund, success or TTL release.
CREATE FUNCTION nmv_replaced_provider_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE p jsonb:=e->'plan'; q jsonb:=p->'request'; r jsonb:=e->'receipt'; relay jsonb:=r->'relay'; c jsonb; original jsonb; forwarded jsonb; i integer; t text;
BEGIN
  IF NOT nmv_replaced_provider_shape_valid(e,$shape${"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":1},"kind":{"type":"string","const":"replaced_provider_boundary_exit"},"requestId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"owner":{"type":"object","properties":{"instanceId":{"type":"string","minLength":1,"maxLength":120},"bootId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["instanceId","bootId"],"additionalProperties":false},"fromState":{"type":"string","const":"indeterminate"},"dispatchAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"bindingHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"notBefore":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"evaluatedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"operator":{"type":"string","minLength":1,"maxLength":120},"reference":{"type":"string","minLength":1,"maxLength":400},"plan":{"type":"object","properties":{"version":{"type":"number","const":1},"kind":{"type":"string","const":"replaced_provider_boundary_plan"},"createdAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"reviewReference":{"type":"string","minLength":1,"maxLength":400},"request":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"owner":{"type":"object","properties":{"instanceId":{"type":"string","minLength":1,"maxLength":120},"bootId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}},"required":["instanceId","bootId"],"additionalProperties":false},"state":{"type":"string","const":"indeterminate"},"tokenHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"epoch":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"revision":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"policyHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"bindingHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"dispatchAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"providerBudgetId":{"type":"string","minLength":1,"maxLength":120},"groupId":{"type":"string","minLength":1,"maxLength":120},"servingContractHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"rowHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"wireHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"chargedTokens":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["requestId","owner","state","tokenHash","epoch","revision","policyHash","bindingHash","dispatchAt","providerBudgetId","groupId","servingContractHash","rowHash","wireHash","chargedTokens"],"additionalProperties":false},"control":{"type":"object","properties":{"mode":{"type":"string","const":"draining"},"epoch":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"revision":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"policyHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"updatedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{6}Z$"}},"required":["mode","epoch","revision","policyHash","updatedAt"],"additionalProperties":false},"writer":{"type":"object","properties":{"lineageId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"writerEpoch":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["lineageId","writerEpoch"],"additionalProperties":false},"originalOwner":{"type":"object","properties":{"kind":{"type":"string","const":"durable_process_group_exit"},"instanceId":{"type":"string","minLength":1,"maxLength":120},"bootId":{"type":"string","allOf":[{"pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"pattern":"^[a-f0-9-]+$"}]},"openedEventId":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"groups":{"minItems":1,"maxItems":128,"type":"array","items":{"type":"object","properties":{"seq":{"type":"integer","exclusiveMinimum":0,"maximum":2147483647},"pid":{"type":"integer","minimum":2,"maximum":2147483647},"runIdHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"spawnIntentEventId":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"spawnedEventId":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"exitEventId":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["seq","pid","runIdHash","spawnIntentEventId","spawnedEventId","exitEventId"],"additionalProperties":false}},"localEndEventId":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"localEndEvidenceHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"artifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["kind","instanceId","bootId","openedEventId","groups","localEndEventId","localEndEvidenceHash","artifactHash"],"additionalProperties":false}},"required":["version","kind","createdAt","reviewReference","request","control","writer","originalOwner"],"additionalProperties":false},"receipt":{"type":"object","properties":{"version":{"type":"number","const":1},"kind":{"type":"string","const":"replaced_provider_boundary_receipt"},"planHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"containers":{"type":"array","prefixItems":[{"type":"object","properties":{"role":{"type":"string","enum":["owner","gateway-m3","gateway-mini"]},"host":{"type":"string","enum":["m3ultra","9mini"]},"serviceName":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"serviceId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"taskId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"containerId":{"type":"string","pattern":"^[a-f0-9]{64}$"},"startedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"replicas":{"type":"number","const":1},"privatePidNamespace":{"type":"boolean","const":true},"noPreDispatchActiveTask":{"type":"boolean","const":true},"noAlternativeIngress":{"type":"boolean","const":true},"artifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"topologyArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["role","host","serviceName","serviceId","taskId","containerId","startedAt","observedAt","replicas","privatePidNamespace","noPreDispatchActiveTask","noAlternativeIngress","artifactHash","topologyArtifactHash"],"additionalProperties":false},{"type":"object","properties":{"role":{"type":"string","enum":["owner","gateway-m3","gateway-mini"]},"host":{"type":"string","enum":["m3ultra","9mini"]},"serviceName":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"serviceId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"taskId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"containerId":{"type":"string","pattern":"^[a-f0-9]{64}$"},"startedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"replicas":{"type":"number","const":1},"privatePidNamespace":{"type":"boolean","const":true},"noPreDispatchActiveTask":{"type":"boolean","const":true},"noAlternativeIngress":{"type":"boolean","const":true},"artifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"topologyArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["role","host","serviceName","serviceId","taskId","containerId","startedAt","observedAt","replicas","privatePidNamespace","noPreDispatchActiveTask","noAlternativeIngress","artifactHash","topologyArtifactHash"],"additionalProperties":false},{"type":"object","properties":{"role":{"type":"string","enum":["owner","gateway-m3","gateway-mini"]},"host":{"type":"string","enum":["m3ultra","9mini"]},"serviceName":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"serviceId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"taskId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$"},"containerId":{"type":"string","pattern":"^[a-f0-9]{64}$"},"startedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"replicas":{"type":"number","const":1},"privatePidNamespace":{"type":"boolean","const":true},"noPreDispatchActiveTask":{"type":"boolean","const":true},"noAlternativeIngress":{"type":"boolean","const":true},"artifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"topologyArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["role","host","serviceName","serviceId","taskId","containerId","startedAt","observedAt","replicas","privatePidNamespace","noPreDispatchActiveTask","noAlternativeIngress","artifactHash","topologyArtifactHash"],"additionalProperties":false}],"items":false,"minItems":3,"maxItems":3},"relay":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"requestModel":{"type":"string","const":"qwen3.8-flash-next"},"requestHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"relayGeneration":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"startedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"endedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"state":{"type":"string","const":"indeterminate"},"error":{"type":"string","const":"upstream_timeout"},"receiptArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"recoveryArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"currentGeneration":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"currentStartedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"currentPid":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"currentArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"oldRelayGroupEnded":{"type":"boolean","const":true},"oldModelGroupEnded":{"type":"boolean","const":true},"originalModelPid":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"originalModelStartedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"currentModelPid":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"currentModelStartedAt":{"type":"string","pattern":"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$"},"currentModel":{"type":"string","minLength":1,"maxLength":200},"originalWireArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewaySourceArtifactHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"originalWire":{"type":"string","minLength":1,"maxLength":1048576},"relayWire":{"type":"string","minLength":1,"maxLength":1048576},"transform":{"type":"string","const":"abcllm-qwen-nonstream-httpx-0.27.2"}},"required":["requestId","requestModel","requestHash","relayGeneration","startedAt","endedAt","state","error","receiptArtifactHash","recoveryArtifactHash","currentGeneration","currentStartedAt","currentPid","currentArtifactHash","oldRelayGroupEnded","oldModelGroupEnded","originalModelPid","originalModelStartedAt","currentModelPid","currentModelStartedAt","currentModel","originalWireArtifactHash","gatewaySourceArtifactHash","originalWire","relayWire","transform"],"additionalProperties":false}},"required":["version","kind","planHash","observedAt","containers","relay"],"additionalProperties":false}},"required":["version","kind","requestId","owner","fromState","dispatchAt","bindingHash","notBefore","evaluatedAt","operator","reference","plan","receipt"],"additionalProperties":false}$shape$::jsonb) THEN RETURN false; END IF;
  IF e->'requestId' IS DISTINCT FROM q->'requestId' OR e->'owner' IS DISTINCT FROM q->'owner' OR e->'dispatchAt' IS DISTINCT FROM q->'dispatchAt'
    OR e->'bindingHash' IS DISTINCT FROM q->'bindingHash' OR e->'reference' IS DISTINCT FROM p->'reviewReference'
    OR e->'notBefore' IS DISTINCT FROM r->'observedAt' OR r->>'planHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p),'UTF8')),'hex')
    OR p->'originalOwner'->>'instanceId' IS DISTINCT FROM q->'owner'->>'instanceId' OR p->'originalOwner'->>'bootId' IS DISTINCT FROM q->'owner'->>'bootId'
    OR NOT nmv_boundary_original_owner_valid(p->'originalOwner') THEN RETURN false; END IF;
  FOREACH t IN ARRAY ARRAY[e->>'dispatchAt',e->>'notBefore',e->>'evaluatedAt',p->>'createdAt',r->>'observedAt',relay->>'startedAt',relay->>'endedAt',relay->>'currentStartedAt',relay->>'originalModelStartedAt',relay->>'currentModelStartedAt'] LOOP
    IF to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>t THEN RETURN false; END IF;
  END LOOP;
  t:=p->'control'->>'updatedAt';
  IF to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>t
    OR t::timestamptz>(p->>'createdAt')::timestamptz OR (q->>'dispatchAt')::timestamptz>(p->>'createdAt')::timestamptz
    OR (p->>'createdAt')::timestamptz>(r->>'observedAt')::timestamptz OR (r->>'observedAt')::timestamptz>(e->>'evaluatedAt')::timestamptz
    OR (e->>'evaluatedAt')::timestamptz-(p->>'createdAt')::timestamptz>interval '30 minutes'
    OR (e->>'evaluatedAt')::timestamptz-(r->>'observedAt')::timestamptz>interval '5 minutes'
    OR (SELECT count(DISTINCT x->>'containerId') FROM jsonb_array_elements(r->'containers') x)<>3 THEN RETURN false; END IF;
  FOR i IN 0..2 LOOP
    c:=r->'containers'->i;
    IF c->>'role' IS DISTINCT FROM (ARRAY['owner','gateway-m3','gateway-mini'])[i+1]
      OR c->>'host' IS DISTINCT FROM (ARRAY['m3ultra','m3ultra','9mini'])[i+1]
      OR c->>'serviceName' IS DISTINCT FROM (ARRAY['nomorevibe-text-m3-ebmybu','app-reboot-optical-matrix-3bl2a4','app-hack-optical-monitor-v1ioak'])[i+1]
      OR (c->>'startedAt')::timestamptz<=(q->>'dispatchAt')::timestamptz OR (c->>'startedAt')::timestamptz>(c->>'observedAt')::timestamptz
      OR (c->>'observedAt')::timestamptz<(p->>'createdAt')::timestamptz OR (c->>'observedAt')::timestamptz>(r->>'observedAt')::timestamptz
      OR to_char((c->>'startedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>c->>'startedAt'
      OR to_char((c->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>c->>'observedAt' THEN RETURN false; END IF;
  END LOOP;
  IF (relay->>'startedAt')::timestamptz<(q->>'dispatchAt')::timestamptz OR (relay->>'startedAt')::timestamptz>(relay->>'endedAt')::timestamptz
    OR (relay->>'endedAt')::timestamptz>=(relay->>'currentStartedAt')::timestamptz OR (relay->>'currentStartedAt')::timestamptz>(r->>'observedAt')::timestamptz
    OR relay->'relayGeneration'=relay->'currentGeneration' OR (relay->>'originalModelStartedAt')::timestamptz>(q->>'dispatchAt')::timestamptz
    OR relay->'currentModel'=relay->'requestModel' OR relay->'currentModelPid'=relay->'originalModelPid'
    OR (relay->>'currentModelStartedAt')::timestamptz<=(relay->>'endedAt')::timestamptz OR (relay->>'currentModelStartedAt')::timestamptz>(r->>'observedAt')::timestamptz OR relay->'originalWireArtifactHash' IS DISTINCT FROM q->'wireHash'
    OR encode(sha256(convert_to(relay->>'originalWire','UTF8')),'hex') IS DISTINCT FROM q->>'wireHash'
    OR encode(sha256(convert_to(relay->>'relayWire','UTF8')),'hex') IS DISTINCT FROM relay->>'requestHash' THEN RETURN false; END IF;
  original:=(relay->>'originalWire')::jsonb; forwarded:=(relay->>'relayWire')::jsonb;
  IF NOT nmv_boundary_keys(original,ARRAY['model','stream','temperature','reasoning_effort','max_tokens','messages'])
    OR original->>'model'<>'[m1] qwen3.8-flash-next' OR original->'stream'<>'false'::jsonb OR original->'temperature'<>'0'::jsonb
    OR original->>'reasoning_effort'<>'low' OR jsonb_typeof(original->'max_tokens')<>'number'
    OR original->>'max_tokens' !~ '^[1-9][0-9]*$' OR (original->>'max_tokens')::integer>8000
    OR jsonb_typeof(original->'messages')<>'array' OR jsonb_array_length(original->'messages')<>2 THEN RETURN false; END IF;
  FOR i IN 0..1 LOOP
    c:=original->'messages'->i;
    IF NOT nmv_boundary_keys(c,ARRAY['role','content']) OR c->>'role' IS DISTINCT FROM (ARRAY['system','user'])[i+1]
      OR jsonb_typeof(c->'content')<>'string' THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(forwarded=jsonb_build_object('model',relay->'requestModel','messages',original->'messages','stream',true,
    'stream_options',jsonb_build_object('include_usage',true),'chat_template_kwargs',jsonb_build_object('enable_thinking',false),
    'max_tokens',original->'max_tokens','temperature',0),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
-- Keep the complete old constraints, including the true indeterminate predecessor.
DO $$
DECLARE predicates text; amount integer;
BEGIN
  SELECT string_agg('('||substring(pg_get_constraintdef(oid) FROM 7)||')',' AND ' ORDER BY conname),count(*) INTO predicates,amount
    FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname=ANY(ARRAY['model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check']);
  IF amount<>4 THEN RAISE EXCEPTION 'replaced_provider_predecessor_missing'; END IF;
  EXECUTE 'CREATE FUNCTION nmv_replaced_provider_predecessor_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT coalesce(('||predicates||'),false) FROM jsonb_populate_record(NULL::model_capacity_requests,v||''{"state":"indeterminate","terminal_evidence":null,"terminal_evidence_hash":null,"settled_at":null}''::jsonb) model_capacity_requests $fn$';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_provider_request_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE e jsonb:=v->'terminal_evidence'; q jsonb:=e->'plan'->'request'; b jsonb:=v->'dispatch_binding';
BEGIN
  RETURN coalesce(v->>'state'='withdrawn' AND v->'settled_at'='null'::jsonb AND v->'token'<>'null'::jsonb
    AND nmv_replaced_provider_release_valid(e) AND nmv_replaced_provider_predecessor_valid(v)
    AND v->>'terminal_evidence_hash'=encode(sha256(convert_to(nmv_boundary_canonical(e),'UTF8')),'hex')
    AND e->>'requestId'=v->>'request_id' AND e->'owner'->>'instanceId'=v->>'owner_instance_id' AND e->'owner'->>'bootId'=v->>'owner_boot_id'
    AND e->>'bindingHash'=v->>'dispatch_binding_hash' AND (e->>'dispatchAt')::timestamptz=(v->>'dispatched_at')::timestamptz
    AND q->>'tokenHash'=encode(sha256(convert_to(v->>'token','UTF8')),'hex') AND q->'epoch'=v->'epoch' AND q->'revision'=v->'revision'
    AND q->>'policyHash'=v->>'policy_hash' AND q->>'providerBudgetId'=v->>'provider_budget_id' AND q->>'groupId'=v->>'group_id'
    AND v->>'route_id'='product-translate' AND v->>'provider'='abcllm' AND v->>'model'='[m1] qwen3.8-flash-next'
    AND b->>'kind'='product_translation_gateway' AND q->'wireHash'=b->'wireHash' AND q->'chargedTokens'=b->'chargedTokens'
    AND b->'totalTokenBound'=b->'chargedTokens' AND q->'servingContractHash'=b->'servingContractHash'
    AND v->>'dispatch_binding_hash'=encode(sha256(convert_to(nmv_boundary_canonical(b),'UTF8')),'hex'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_provider_records_valid(e jsonb,v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c model_capacity_control; f dr_writer_fence; p jsonb:=e->'plan';
BEGIN
  SELECT * INTO STRICT f FROM dr_writer_fence WHERE id=1;
  SELECT * INTO STRICT c FROM model_capacity_control WHERE id=1;
  RETURN coalesce(f.state='active' AND c.mode='draining' AND v->>'state'='indeterminate'
    AND v->'terminal_evidence'='null'::jsonb AND v->'terminal_evidence_hash'='null'::jsonb AND v->'settled_at'='null'::jsonb
    AND p->'request'->>'rowHash'=encode(sha256(convert_to(v::text,'UTF8')),'hex')
    AND p->'writer'=jsonb_build_object('lineageId',f.lineage_id,'writerEpoch',f.writer_epoch)
    AND p->'control'=jsonb_build_object('mode',c.mode,'epoch',c.epoch,'revision',c.revision,'policyHash',c.policy_hash,'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    AND nmv_boundary_original_owner_records_valid(p,v),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_provider_event_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE e jsonb:=v->'evidence';
BEGIN
  RETURN coalesce(v->>'kind'='dispatch_released' AND v->>'from_state'='indeterminate' AND v->>'to_state'='withdrawn' AND v->'reason'='null'::jsonb
    AND nmv_replaced_provider_release_valid(e) AND e->>'requestId'=v->>'request_id'
    AND e->'plan'->'request'->'epoch'=v->'epoch' AND e->'plan'->'request'->'revision'=v->'revision'
    AND e->'plan'->'request'->'policyHash'=v->'policy_hash',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
DO $$
DECLARE n text; old_predicate text;
BEGIN
  FOREACH n IN ARRAY ARRAY['model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check'] LOOP
    SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname=n;
    EXECUTE format('ALTER TABLE model_capacity_requests DROP CONSTRAINT %I',n);
    EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT %I CHECK ((%s) OR nmv_replaced_provider_request_valid(to_jsonb(model_capacity_requests)))',n,old_predicate);
  END LOOP;
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate FROM pg_constraint WHERE conrelid='model_capacity_events'::regclass AND conname='model_capacity_events_kind_check';
  ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_kind_check;
  EXECUTE 'ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK (('||old_predicate||') OR nmv_replaced_provider_event_valid(to_jsonb(model_capacity_events)))';
END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_replaced_provider_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed_now timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND OLD.terminal_evidence->>'kind'='replaced_provider_boundary_exit' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'replaced_provider_terminal_immutable';
  END IF;
  IF NEW.terminal_evidence->>'kind' IS DISTINCT FROM 'replaced_provider_boundary_exit' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'replaced_provider_transition_invalid'; END IF;
  PERFORM 1 FROM dr_writer_fence WHERE id=1 FOR SHARE;
  PERFORM 1 FROM model_capacity_control WHERE id=1 FOR UPDATE;
  observed_now:=clock_timestamp();
  IF NOT nmv_replaced_provider_records_valid(NEW.terminal_evidence,to_jsonb(OLD))
    OR NOT nmv_replaced_provider_request_valid(to_jsonb(NEW))
    OR (to_jsonb(OLD)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','terminal_evidence','terminal_evidence_hash','updated_at'])
    OR (NEW.terminal_evidence->>'evaluatedAt')::timestamptz NOT BETWEEN observed_now-interval '30 seconds' AND observed_now
    OR (NEW.terminal_evidence->'receipt'->>'observedAt')::timestamptz NOT BETWEEN observed_now-interval '5 minutes' AND observed_now
    OR (NEW.terminal_evidence->'plan'->>'createdAt')::timestamptz NOT BETWEEN observed_now-interval '30 minutes' AND observed_now
    THEN RAISE EXCEPTION 'replaced_provider_transition_conflict'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_capacity_replaced_provider_guard BEFORE INSERT OR UPDATE ON model_capacity_requests FOR EACH ROW EXECUTE FUNCTION nmv_replaced_provider_transition_guard();
