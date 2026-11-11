/**
 * 0174(2026-11-11): text 7경로 게이트웨이 dispatch 가 공급자에게서 "처리하지 않고 거절했다"는 완결된 HTTP 응답(429 빈도 한도·401/403 인증 거절)을
 * 받았을 때의 확정 정산 근거 `gateway_http_rejected` {version, kind, dispatch, status, retryAfterMs} 의 CHECK 가지.
 *
 * 왜: 그 응답은 지금까지 결과 미확정(indeterminate, transport_unknown)으로 남아 장비 칸을 capacity.unknownHoldSeconds(기본 600초)만큼 쥐었다 —
 * 한도 1인 장비(LG EXAONE)는 429 한 번에 10분 막혔다(2026-11-11 운영). 응답 상태 줄을 받았으니 공급자는 이 요청을 생성하지 않았고(전송 여부도 안다),
 * 점유를 바로 끝내도 된다. 정산은 gateway_not_started(0102·0149)와 같은 모양이다 — dispatched → settled 만, binding 의 C(chargedTokens)는 그대로,
 * 사용량 증거 없음. 5xx·시간 초과·응답 중 끊김은 여기 오지 않는다(위쪽이 아직 생성 중일 수 있다 — 지금처럼 결과 미확정).
 *
 * 0160 이후 장부 CHECK 는 model_capacity_check_rules 의 행이다: 0174 는 아래 두 값을 각 제약의 다음 ordinal 로 넣고
 * nmv_model_capacity_check_guard_rebuild(표) 를 부른다. lib/db/operations-schema.ts 의 check() 는 "(앞 술어) OR (이 값)" 으로 맨 끝에 잇는다.
 * 이 파일은 다른 모듈을 import 하지 않는다(operations-schema·capacity 가 같이 읽는다 — 순환 없음).
 */
/** 이 근거로 정산하는 dispatch binding kind — text 7경로(직접 HTTP 게이트웨이)뿐이다. */
export const GATEWAY_HTTP_REJECTED_BINDING_KINDS = ["text_profile_gateway", "reason_translation_gateway", "product_translation_gateway",
  "product_tagline_ko_gateway", "crawl_tagline_gateway", "search_verify_gateway", "websearch_query_gateway"] as const;
/** 처리 전 거절이 확실한 상태만: 429(빈도 한도), 401·403(인증·권한 거절 — 요청이 모델에 닿기 전에 끝난다). 4xx 의 나머지·5xx 는 넣지 않는다. */
export const GATEWAY_HTTP_REJECTED_STATUSES = [401, 403, 429] as const;
/** retryAfterMs 상한 — provider-rate-limit 의 Retry-After 자르기(1시간)와 같다. */
export const GATEWAY_HTTP_REJECTED_RETRY_AFTER_MAX_MS = 3_600_000;

const kinds = `(${GATEWAY_HTTP_REJECTED_BINDING_KINDS.map(kind => `'${kind}'`).join(",")})`;
const statuses = `(${GATEWAY_HTTP_REJECTED_STATUSES.map(status => `'${status}'::jsonb`).join(",")})`;
const keys = "ARRAY['version','kind','dispatch','status','retryAfterMs']";
const shape = (value: string) => `(CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ?& ${keys} AND ${value} - ${keys}='{}'::jsonb ELSE false END)`
  + ` AND (${value}->'version'='1'::jsonb) AND (${value}->'kind'='"gateway_http_rejected"'::jsonb) AND (${value}->'status' IN ${statuses})`
  // CASE 로 순서를 묶는다 — 숫자 모양을 본 뒤에만 캐스트한다(AND 는 평가 순서를 보장하지 않는다)
  + ` AND (CASE WHEN ${value}->'retryAfterMs'='null'::jsonb THEN true WHEN jsonb_typeof(${value}->'retryAfterMs')='number'`
  + ` AND (${value}->>'retryAfterMs') ~ '^(0|[1-9][0-9]{0,6})$' THEN (${value}->>'retryAfterMs')::integer <= ${GATEWAY_HTTP_REJECTED_RETRY_AFTER_MAX_MS} ELSE false END)`;

/** model_capacity_requests_terminal_check: 근거의 dispatch 는 이 행 자신의 handle·binding 이다(gatewayNotStartedAllKindsTerminalSql 과 같은 대조). */
export const gatewayHttpRejectedTerminalSql = "coalesce(((state='settled' AND terminal_evidence IS NOT NULL AND terminal_evidence_hash IS NOT NULL AND settled_at IS NOT NULL)"
  + " AND (terminal_evidence_hash ~ '^[a-f0-9]{64}$') AND (dispatch_binding IS NOT NULL AND dispatch_binding_hash IS NOT NULL AND dispatched_at IS NOT NULL)"
  + ` AND (jsonb_typeof(dispatch_binding)='object') AND (dispatch_binding->'version'='1'::jsonb) AND (dispatch_binding->>'kind' IN ${kinds})`
  + ` AND ${shape("terminal_evidence")}`
  + " AND (terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),"
  + "'token',token::text,'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash))),false)";

/** model_capacity_events_terminal_check: dispatched → settled 만(gateway_not_started 처럼 indeterminate 는 받지 않는다). */
export const gatewayHttpRejectedEventTerminalSql = "coalesce(((kind='dispatch_settled' AND evidence IS NOT NULL AND from_state='dispatched' AND to_state='settled')"
  + ` AND ${shape("evidence")}`
  + " AND (CASE WHEN jsonb_typeof(evidence->'dispatch')='object' THEN (evidence->'dispatch') ?& ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']"
  + " AND (evidence->'dispatch') - ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']='{}'::jsonb ELSE false END)"
  + " AND (CASE WHEN jsonb_typeof(evidence->'dispatch'->'owner')='object' THEN (evidence->'dispatch'->'owner') ?& ARRAY['instanceId','bootId']"
  + " AND (evidence->'dispatch'->'owner') - ARRAY['instanceId','bootId']='{}'::jsonb ELSE false END)"
  + " AND (jsonb_typeof(evidence->'dispatch'->'owner'->'instanceId')='string')"
  + " AND (jsonb_typeof(evidence->'dispatch'->'owner'->'bootId')='string' AND (evidence->'dispatch'->'owner'->>'bootId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')"
  + " AND (jsonb_typeof(evidence->'dispatch'->'token')='string' AND (evidence->'dispatch'->>'token') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')"
  + " AND (jsonb_typeof(evidence->'dispatch'->'bindingHash')='string' AND (evidence->'dispatch'->>'bindingHash') ~ '^[a-f0-9]{64}$')"
  + ` AND (jsonb_typeof(evidence->'dispatch'->'binding')='object') AND (evidence->'dispatch'->'binding'->'version'='1'::jsonb)`
  + ` AND (evidence->'dispatch'->'binding'->>'kind' IN ${kinds})`
  + " AND (evidence->'dispatch'->>'requestId'=request_id::text) AND (evidence->'dispatch'->'epoch'=to_jsonb(epoch))"
  + " AND (evidence->'dispatch'->'revision'=to_jsonb(revision)) AND (evidence->'dispatch'->>'policyHash'=policy_hash)),false)";
