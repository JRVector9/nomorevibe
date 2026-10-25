-- Privileged physical observations, not native terminal or usage authority. Existing V1/V2 bodies and CHECKs are preserved.
CREATE FUNCTION nmv_boot_text(v jsonb,n integer) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(jsonb_typeof(v)='string' AND char_length(v#>>'{}') BETWEEN 1 AND n AND v#>>'{}'=btrim(v#>>'{}') AND v#>>'{}' !~ '[[:cntrl:]]',false)
$$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_sha(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[a-f0-9]{64}$',false) $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_uuid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false) $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_uint(v jsonb,lo numeric,hi numeric) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$ BEGIN RETURN coalesce(jsonb_typeof(v)='number' AND v::text ~ '^[0-9]+$' AND v::text::numeric BETWEEN lo AND hi,false); EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_at(v jsonb,micro boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN RETURN coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ (CASE WHEN micro THEN '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$' ELSE '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' END)
 AND to_char((v#>>'{}')::timestamptz AT TIME ZONE 'UTC',CASE WHEN micro THEN 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' ELSE 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' END)=v#>>'{}',false); EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_us(v text) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT extract(epoch FROM v::timestamptz)*1000000 $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_lower(w jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT nmv_boot_us(w->>'dbBefore')-ceil((w->>'uptimeNs')::numeric/1000)-1 $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_upper(w jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT nmv_boot_us(w->>'dbAfter')-floor((w->>'uptimeNs')::numeric/1000)+1 $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_witness_valid(w jsonb,boot text,observed text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
 IF NOT nmv_boundary_keys(w,ARRAY['dbBefore','dbAfter','uptimeNs','bootId','hostBtimeAt','artifactHash']) OR NOT nmv_boot_at(w->'dbBefore',true) OR NOT nmv_boot_at(w->'dbAfter',true)
  OR NOT nmv_boot_at(w->'hostBtimeAt') OR NOT nmv_boot_uuid(w->'bootId') OR w->>'bootId' IS DISTINCT FROM boot OR NOT nmv_boot_sha(w->'artifactHash')
  OR jsonb_typeof(w->'uptimeNs') IS DISTINCT FROM 'string' OR w->>'uptimeNs' !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 RETURN nmv_boot_us(w->>'dbAfter')-nmv_boot_us(w->>'dbBefore') BETWEEN 0 AND 5000000
  AND nmv_boot_us(observed)-nmv_boot_us(w->>'dbAfter') BETWEEN 0 AND 300000000
  AND nmv_boot_us(w->>'hostBtimeAt') BETWEEN nmv_boot_lower(w)-1000000 AND nmv_boot_upper(w)+1000000;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_contract_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text; t jsonb:=v->'thinking'; term jsonb:=v->'termination';
BEGIN
 IF NOT nmv_boundary_keys(v,ARRAY['version','protocol','backendId','provider','physicalGroup','endpoint','model','responseModel','modelFamily','deploymentRevision','contextWindowTokens','totalTokenBound','maxOutputTokens','maxInputBytes','capabilities','thinking','termination'])
  OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->>'protocol' IS DISTINCT FROM 'local-openai-chat-v1' OR v->>'provider' IS DISTINCT FROM 'local-direct'
  OR NOT nmv_boundary_keys(v->'capabilities',ARRAY['vision','jsonSchema']) OR jsonb_typeof(v->'capabilities'->'vision') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'capabilities'->'jsonSchema') IS DISTINCT FROM 'boolean'
  OR NOT nmv_boundary_keys(t,ARRAY['mode','parameter']) OR t->>'mode' NOT IN ('disabled','low') OR t->>'parameter' NOT IN ('chat_template_kwargs.enable_thinking','enable_thinking','reasoning_effort','none')
  OR jsonb_typeof(t->'mode') IS DISTINCT FROM 'string' OR jsonb_typeof(t->'parameter') IS DISTINCT FROM 'string'
  OR (t->>'mode'='low') IS DISTINCT FROM (t->>'parameter'='reasoning_effort') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['backendId','physicalGroup','model','responseModel','modelFamily','deploymentRevision','endpoint'] LOOP
  IF NOT nmv_boot_text(v->k,CASE WHEN k IN ('backendId','physicalGroup') THEN 120 WHEN k='endpoint' THEN 2048 ELSE 200 END) THEN RETURN false; END IF;
 END LOOP;
 IF v->>'modelFamily' NOT IN ('qwen3.8-flash-next','deepseek-v4.1-flash-1017','gpt-oss-120b')
  OR NOT nmv_boot_uint(v->'contextWindowTokens',1,1048576) OR NOT nmv_boot_uint(v->'totalTokenBound',1,1048576) OR v->'totalTokenBound' IS DISTINCT FROM v->'contextWindowTokens'
  OR NOT nmv_boot_uint(v->'maxOutputTokens',1,262144) OR (v->>'maxOutputTokens')::numeric>(v->>'totalTokenBound')::numeric OR NOT nmv_boot_uint(v->'maxInputBytes',1,16777216) THEN RETURN false; END IF;
 IF term->>'kind'='response_only' THEN RETURN nmv_boundary_keys(term,ARRAY['kind']); END IF;
 RETURN coalesce(term->>'kind'='provider_hard_deadline' AND nmv_boundary_keys(term,ARRAY['kind','maxDurationMs']) AND nmv_boot_uint(term->'maxDurationMs',1,3600000),false);
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_boot_provider_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE j jsonb; k text;
BEGIN
 IF NOT nmv_boundary_keys(v,ARRAY['kind','host','endpointAddress','endpointPort','machineIdSha256','tailscaleNodeId','oldBootId','currentBootId','endpointProofHash','oldJournal','currentJournal'])
  OR v->>'kind' IS DISTINCT FROM 'direct_linux_host_reboot' OR NOT nmv_boot_text(v->'host',120) OR NOT nmv_boot_text(v->'tailscaleNodeId',120)
  OR NOT nmv_boot_sha(v->'machineIdSha256') OR NOT nmv_boot_sha(v->'endpointProofHash') OR NOT nmv_boot_uuid(v->'oldBootId') OR NOT nmv_boot_uuid(v->'currentBootId') OR v->'oldBootId'=v->'currentBootId'
  OR jsonb_typeof(v->'endpointAddress') IS DISTINCT FROM 'string' OR v->>'endpointAddress' !~ '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$'
  OR NOT nmv_boot_uint(v->'endpointPort',1,65535) OR NOT nmv_boundary_keys(v->'oldJournal',ARRAY['bootId','machineIdSha256','firstAt','lastAt','artifactHash'])
  OR NOT nmv_boundary_keys(v->'currentJournal',ARRAY['bootId','machineIdSha256','firstAt','artifactHash']) THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['oldJournal','currentJournal'] LOOP
  j:=v->k;
  IF j->'bootId' IS DISTINCT FROM v->(CASE WHEN k='oldJournal' THEN 'oldBootId' ELSE 'currentBootId' END) OR j->'machineIdSha256' IS DISTINCT FROM v->'machineIdSha256'
   OR NOT nmv_boot_at(j->'firstAt',true) OR NOT nmv_boot_sha(j->'artifactHash') THEN RETURN false; END IF;
 END LOOP;
 RETURN nmv_boot_at(v->'oldJournal'->'lastAt',true) AND v->'oldJournal'->>'firstAt'<=v->'oldJournal'->>'lastAt';
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
CREATE FUNCTION nmv_provider_boundary_release_v3_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE p jsonb:=e->'plan'; r jsonb:=e->'receipt'; q jsonb:=p->'request'; c jsonb:=p->'control'; v jsonb:=p->'provider'; s jsonb:=p->'servingContract'; a jsonb:=p->'ownerAssociation'; l jsonb:=p->'localEnd'; w jsonb:=p->'bootWitness'; rw jsonb:=r->'provider'->'bootWitness'; k text; x jsonb;
BEGIN
 IF NOT nmv_boundary_keys(e,ARRAY['version','kind','requestId','owner','fromState','dispatchAt','bindingHash','notBefore','evaluatedAt','operator','reference','plan','receipt'])
  OR e->'version' IS DISTINCT FROM '1'::jsonb OR e->>'kind' IS DISTINCT FROM 'provider_boundary_exit' OR e->>'fromState' IS DISTINCT FROM 'indeterminate'
  OR NOT nmv_boundary_keys(p,ARRAY['version','kind','createdAt','request','control','owner','gateways','provider','servingContract','transport','ownerAssociation','localEnd','bootWitness','beforeArtifactHash'])
  OR p->'version' IS DISTINCT FROM '3'::jsonb OR p->>'kind' IS DISTINCT FROM 'provider_boundary_plan'
  OR NOT nmv_boundary_keys(q,ARRAY['requestId','owner','state','tokenHash','epoch','revision','policyHash','bindingHash','dispatchAt','providerBudgetId','groupId','servingContractHash'])
  OR q->>'state' IS DISTINCT FROM 'indeterminate' OR NOT nmv_boundary_keys(q->'owner',ARRAY['instanceId','bootId']) OR NOT nmv_boot_text(q->'owner'->'instanceId',120) OR NOT nmv_boot_uuid(q->'owner'->'bootId') OR NOT nmv_boot_uuid(q->'requestId')
  OR NOT nmv_boundary_keys(c,ARRAY['mode','epoch','revision','policyHash','updatedAt']) OR c->>'mode' IS DISTINCT FROM 'draining' OR NOT nmv_boot_at(c->'updatedAt',true)
  OR NOT nmv_boundary_keys(r,ARRAY['version','kind','planHash','owner','gateways','provider']) OR r->'version' IS DISTINCT FROM '3'::jsonb OR r->>'kind' IS DISTINCT FROM 'provider_boundary_receipt'
  OR NOT nmv_boundary_keys(r->'provider',ARRAY['identity','observedAt','bootWitness','artifactHash']) OR p->'gateways' IS DISTINCT FROM '[]'::jsonb OR r->'gateways' IS DISTINCT FROM '[]'::jsonb
  OR e->'owner' IS DISTINCT FROM q->'owner' OR e->'requestId' IS DISTINCT FROM q->'requestId' OR e->'dispatchAt' IS DISTINCT FROM q->'dispatchAt' OR e->'bindingHash' IS DISTINCT FROM q->'bindingHash'
  OR e->'notBefore' IS DISTINCT FROM r->'provider'->'observedAt' OR NOT nmv_boot_at(e->'evaluatedAt') OR NOT nmv_boot_at(p->'createdAt') OR NOT nmv_boot_at(q->'dispatchAt')
  OR NOT nmv_boot_text(e->'operator',120) OR NOT nmv_boot_text(e->'reference',400) OR NOT nmv_boot_sha(p->'beforeArtifactHash')
  OR r->>'planHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p),'UTF8')),'hex') THEN RETURN false; END IF;
 FOREACH x IN ARRAY ARRAY[q,c] LOOP
  IF NOT nmv_boot_uint(x->'epoch',1,9007199254740991) OR NOT nmv_boot_uint(x->'revision',1,9007199254740991) OR NOT nmv_boot_sha(x->'policyHash') THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['tokenHash','bindingHash','servingContractHash'] LOOP IF NOT nmv_boot_sha(q->k) THEN RETURN false; END IF; END LOOP;
 IF NOT nmv_boot_text(q->'providerBudgetId',120) OR NOT nmv_boot_text(q->'groupId',120) OR NOT nmv_boundary_identity_valid(p->'owner') OR p->'owner'->>'kind' IS DISTINCT FROM 'container'
  OR NOT nmv_boundary_exit_valid(r->'owner') OR r->'owner'->'identity' IS DISTINCT FROM p->'owner' OR NOT nmv_boot_provider_valid(v) OR r->'provider'->'identity' IS DISTINCT FROM v
  OR NOT nmv_boot_at(r->'provider'->'observedAt') OR NOT nmv_boot_sha(r->'provider'->'artifactHash') OR NOT nmv_boot_contract_valid(s)
  OR s->>'endpoint' IS DISTINCT FROM 'http://'||(v->>'endpointAddress')||':'||(v->>'endpointPort')||'/v1/chat/completions'
  OR s->'physicalGroup' IS DISTINCT FROM q->'groupId' OR s->'backendId' IS DISTINCT FROM q->'providerBudgetId'
  OR q->>'servingContractHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(s),'UTF8')),'hex')
  OR NOT nmv_boundary_keys(p->'transport',ARRAY['kind','redirect','attempts','proxy','durableQueue','sourceArtifactHash'])
  OR p->'transport'->>'kind' IS DISTINCT FROM 'single_direct_http' OR p->'transport'->>'redirect' IS DISTINCT FROM 'error' OR p->'transport'->'attempts' IS DISTINCT FROM '1'::jsonb OR p->'transport'->'proxy' IS DISTINCT FROM 'false'::jsonb OR p->'transport'->'durableQueue' IS DISTINCT FROM 'false'::jsonb OR NOT nmv_boot_sha(p->'transport'->'sourceArtifactHash')
  OR NOT nmv_boundary_keys(a,ARRAY['instanceId','bootId','spawnedEventId','pid','runIdHash']) OR a->'instanceId' IS DISTINCT FROM q->'owner'->'instanceId' OR a->'bootId' IS DISTINCT FROM q->'owner'->'bootId'
  OR NOT nmv_boot_uint(a->'spawnedEventId',1,9007199254740991) OR NOT nmv_boot_uint(a->'pid',2,2147483647) OR NOT nmv_boot_sha(a->'runIdHash')
  OR NOT nmv_boundary_keys(l,ARRAY['eventId','evidenceHash','endedAt','dispatches','terminals']) OR NOT nmv_boot_uint(l->'eventId',1,9007199254740991) OR NOT nmv_boot_sha(l->'evidenceHash') OR NOT nmv_boot_at(l->'endedAt',true) OR l->'dispatches' IS DISTINCT FROM '1'::jsonb OR l->'terminals' IS DISTINCT FROM '1'::jsonb
  OR NOT nmv_boot_witness_valid(w,v->>'currentBootId',p->>'createdAt') OR NOT nmv_boot_witness_valid(rw,v->>'currentBootId',r->'provider'->>'observedAt') THEN RETURN false; END IF;
 RETURN coalesce(p->'owner'->>'startedAt'<=q->>'dispatchAt' AND p->>'createdAt'>=q->>'dispatchAt' AND nmv_boot_us(c->>'updatedAt')<=nmv_boot_us(p->>'createdAt')
  AND nmv_boot_us(q->>'dispatchAt')<least(nmv_boot_lower(w),nmv_boot_lower(rw)) AND nmv_boot_us(l->>'endedAt')<least(nmv_boot_lower(w),nmv_boot_lower(rw)) AND nmv_boot_us(l->>'endedAt')>=nmv_boot_us(q->>'dispatchAt')
  AND nmv_boot_us(v->'oldJournal'->>'firstAt')<=nmv_boot_us(q->>'dispatchAt') AND nmv_boot_us(v->'oldJournal'->>'lastAt')<nmv_boot_upper(w) AND nmv_boot_us(v->'currentJournal'->>'firstAt')>=nmv_boot_lower(w) AND nmv_boot_us(v->'currentJournal'->>'firstAt')<=nmv_boot_us(p->>'createdAt')
  AND r->'owner'->>'observedAt'>=p->>'createdAt' AND r->'provider'->>'observedAt'>=r->'owner'->>'observedAt' AND nmv_boot_us(rw->>'dbBefore')>=nmv_boot_us(r->'owner'->>'observedAt')
  AND nmv_boot_lower(w)<=nmv_boot_upper(rw) AND nmv_boot_lower(rw)<=nmv_boot_upper(w)
  AND e->>'evaluatedAt'>=r->'provider'->>'observedAt' AND (e->>'evaluatedAt')::timestamptz-(r->'provider'->>'observedAt')::timestamptz<=interval '5 minutes' AND e->>'evaluatedAt'>=p->>'createdAt' AND (e->>'evaluatedAt')::timestamptz-(p->>'createdAt')::timestamptz<=interval '30 minutes',false);
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
-- Facts are re-read under the caller's control/request locks, and independently by the UPDATE trigger.
CREATE FUNCTION nmv_boot_records_valid(p jsonb,v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE b jsonb:=v->'dispatch_binding'; s jsonb:=p->'servingContract'; a jsonb:=p->'ownerAssociation'; l jsonb:=p->'localEnd'; g dr_process_group_events; ended model_capacity_events; dispatch_at timestamptz:=(v->>'dispatched_at')::timestamptz;
BEGIN
 IF p->'version' IS DISTINCT FROM '3'::jsonb OR b->>'kind' IS DISTINCT FROM 'local_model_direct' OR v->>'provider' IS DISTINCT FROM 'local-direct'
  OR v->>'class' IS DISTINCT FROM 'background' OR v->>'pool' IS DISTINCT FROM 'reviewer'
  OR s->'backendId' IS DISTINCT FROM b->'backendId' OR s->'physicalGroup' IS DISTINCT FROM b->'physicalGroup' OR s->'model' IS DISTINCT FROM b->'model'
  OR s->'deploymentRevision' IS DISTINCT FROM b->'deploymentRevision' OR s->'totalTokenBound' IS DISTINCT FROM b->'totalTokenBound'
  OR s->'totalTokenBound' IS DISTINCT FROM b->'chargedTokens' OR b->>'servingContractHash' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(s),'UTF8')),'hex')
  OR a->>'instanceId' IS DISTINCT FROM v->>'owner_instance_id' OR a->>'bootId' IS DISTINCT FROM v->>'owner_boot_id' THEN RETURN false; END IF;
 SELECT * INTO g FROM dr_process_group_events WHERE id=(a->>'spawnedEventId')::bigint;
 IF NOT FOUND OR g.kind<>'spawned' OR g.owner_instance_id<>a->>'instanceId' OR g.owner_boot_id::text<>a->>'bootId' OR g.pid<>(a->>'pid')::integer
  OR encode(sha256(convert_to(g.run_id::text,'UTF8')),'hex') IS DISTINCT FROM a->>'runIdHash' OR g.recorded_at>dispatch_at OR g.recorded_at<(p->'owner'->>'startedAt')::timestamptz
  OR NOT EXISTS(SELECT 1 FROM dr_process_group_events i WHERE i.owner_instance_id=g.owner_instance_id AND i.owner_boot_id=g.owner_boot_id AND i.seq=g.seq AND i.run_id=g.run_id AND i.kind='spawn_intent' AND i.recorded_at<=g.recorded_at)
  OR NOT EXISTS(SELECT 1 FROM dr_process_group_events i WHERE i.owner_instance_id=g.owner_instance_id AND i.owner_boot_id=g.owner_boot_id AND i.kind='owner_opened' AND i.recorded_at<=g.recorded_at) THEN RETURN false; END IF;
 SELECT * INTO ended FROM model_capacity_events WHERE id=(l->>'eventId')::bigint;
 RETURN coalesce(FOUND AND ended.request_id::text=v->>'request_id' AND ended.kind='dispatch_local_ended' AND ended.from_state='indeterminate' AND ended.to_state='indeterminate'
  AND ended.created_at>=dispatch_at AND to_char(ended.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=l->>'endedAt'
  AND ended.epoch::text=v->>'epoch' AND ended.revision::text=v->>'revision' AND ended.policy_hash=v->>'policy_hash'
  AND nmv_boundary_keys(ended.evidence,ARRAY['version','kind','requestId','owner','bindingHash','dispatches','terminals'])
  AND ended.evidence->'version'='1'::jsonb AND ended.evidence->>'kind'='gateway_local_end' AND ended.evidence->>'requestId'=v->>'request_id'
  AND ended.evidence->'owner'=p->'request'->'owner' AND ended.evidence->>'bindingHash'=v->>'dispatch_binding_hash'
  AND ended.evidence->'dispatches'='1'::jsonb AND ended.evidence->'terminals'='1'::jsonb
  AND encode(sha256(convert_to(nmv_boundary_canonical(ended.evidence),'UTF8')),'hex')=l->>'evidenceHash',false);
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text:='  RETURN NEW;'||chr(10)||'END'; part text[];
BEGIN
 FOREACH part SLICE 1 IN ARRAY ARRAY[ARRAY['nmv_provider_boundary_release_valid','nmv_boot_previous_release_valid'],ARRAY['nmv_provider_boundary_transition_guard','nmv_boot_previous_transition_guard']] LOOP
  definition:=pg_get_functiondef(('public.'||part[1]||CASE WHEN part[1]='nmv_provider_boundary_transition_guard' THEN '()' ELSE '(jsonb)' END)::regprocedure);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.'||part[1]||'\(','CREATE FUNCTION public.'||part[2]||'(');
 END LOOP;
 definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'boot_boundary_predecessor_changed'; END IF;
 EXECUTE replace(definition,needle,'  IF NEW.terminal_evidence->''plan''->''version''=''3''::jsonb AND NOT nmv_boot_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boot_boundary_records_mismatch''; END IF;'||chr(10)||needle);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
 IF e->'plan'->'version'='3'::jsonb THEN RETURN nmv_provider_boundary_release_v3_valid(e); END IF;
 RETURN nmv_boot_previous_release_valid(e);
END $$;
