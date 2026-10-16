import { sql } from 'drizzle-orm';
import { pgTable, varchar, jsonb, timestamp, serial, bigserial, integer, text, bigint, boolean, index, uniqueIndex, check, primaryKey, foreignKey, uuid } from 'drizzle-orm/pg-core';
import type { ItemBinding, ItemStage, ItemStageMode } from '@/lib/jobs/items/types';
import type { ModelCapacityClass, ModelCapacityEventKind, ModelCapacityEventReason, ModelCapacityMode,
  ModelCapacityPolicy, ModelCapacityPool, ModelCapacityState, Ai1DispatchBinding, Ai1GatewayTerminalEvidence } from '@/lib/llm/capacity';

/**
 * Cloudflare 에서 지울 제품 — 공개 제품이 내려가거나 지워지면 DB 트리거가 같은 트랜잭션에서 적는다(0057).
 * 내리는 길(관리자 차단·내려달라는 요청·감사·재검토)마다 코드를 넣지 않아도 빠지지 않는다.
 * 발행 워커가 태그로 지우고(purgedAt), 원 서버가 옛 내용을 다시 채웠을 때를 위해 60초 뒤 한 번 더 지운다(confirmedAt).
 */
export const cdnPurges = pgTable('cdn_purges', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 80 }).notNull(),
  /** 바뀐 상태 또는 'deleted' */
  reason: varchar('reason', { length: 20 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  purgedAt: timestamp('purged_at'),
  confirmedAt: timestamp('confirmed_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: varchar('last_error', { length: 300 }),
}, (table) => [index('cdn_purges_pending_idx').on(table.id).where(sql`confirmed_at is null`)]);

/** One active process per job role. Database time is the authority for expiry. */
export const roleLeases = pgTable('role_leases', {
  role: varchar('role', { length: 30 }).primaryKey(),
  ownerInstanceId: varchar('owner_instance_id', { length: 120 }),
  ownerBootId: varchar('owner_boot_id', { length: 36 }),
  ownerKind: varchar('owner_kind', { length: 10 }),
  ownerRelease: varchar('owner_release', { length: 120 }),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
  primaryBoots: jsonb('primary_boots').$type<{ id: string; at: number }[]>().notNull().default([]),
  quarantineUntil: timestamp('quarantine_until'),
  leaseUntil: timestamp('lease_until').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Inactive until PR03/04 install both legacy and item writer contracts; role election does not own these epochs. */
export const pipelineStageModes = pgTable('pipeline_stage_modes', {
  stage: varchar('stage', { length: 8 }).$type<ItemStage>().primaryKey(),
  mode: varchar('mode', { length: 10 }).$type<ItemStageMode>().notNull().default('legacy'),
  drainingFrom: varchar('draining_from', { length: 8 }).$type<'legacy' | 'items'>(),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(1),
  writerContractVersion: integer('writer_contract_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  check('pipeline_stage_modes_stage_check', sql`${table.stage} in ('fetch','ai1','ai2')`),
  check('pipeline_stage_modes_mode_check', sql`${table.mode} in ('legacy','draining','items')`),
  check('pipeline_stage_modes_draining_check', sql`(${table.mode} = 'draining' and ${table.drainingFrom} is not null and ${table.drainingFrom} in ('legacy','items')) or (${table.mode} <> 'draining' and ${table.drainingFrom} is null)`),
  check('pipeline_stage_modes_epoch_check', sql`${table.epoch} between 1 and 9007199254740991`),
  check('pipeline_stage_modes_contract_check', sql`${table.writerContractVersion} >= 0`),
]);

/** Generic ownership only; domain rows and next-stage requests remain in their existing repositories. */
export const pipelineItemLeases = pgTable('pipeline_item_leases', {
  stage: varchar('stage', { length: 8 }).$type<ItemStage>().notNull().references(() => pipelineStageModes.stage),
  workKey: varchar('work_key', { length: 80 }).notNull(),
  binding: jsonb('binding').$type<ItemBinding>().notNull(),
  bindingHash: varchar('binding_hash', { length: 64 }).notNull(),
  ownerInstanceId: varchar('owner_instance_id', { length: 120 }),
  ownerBootId: uuid('owner_boot_id'),
  token: uuid('token'),
  stageEpoch: bigint('stage_epoch', { mode: 'number' }).notNull().default(1),
  itemEpoch: bigint('item_epoch', { mode: 'number' }).notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true, precision: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.stage, table.workKey], name: 'pipeline_item_leases_pkey' }),
  check('pipeline_item_leases_stage_check', sql`${table.stage} in ('fetch','ai1','ai2')`),
  check('pipeline_item_leases_binding_check', sql`coalesce(jsonb_typeof(${table.binding}) = 'object' and ${table.binding}->>'stage' = ${table.stage} and ${table.workKey} = ${table.stage} || ':' || case ${table.stage} when 'fetch' then ${table.binding}->>'frontierId' when 'ai1' then ${table.binding}->>'candidateId' when 'ai2' then ${table.binding}->>'secondReviewId' end, false)`),
  check('pipeline_item_leases_hash_check', sql`${table.bindingHash} ~ '^[a-f0-9]{64}$'`),
  check('pipeline_item_leases_owner_check', sql`(${table.ownerInstanceId} is null and ${table.ownerBootId} is null and ${table.token} is null and ${table.leaseUntil} is null) or (${table.ownerInstanceId} is not null and char_length(btrim(${table.ownerInstanceId})) > 0 and ${table.ownerBootId} is not null and ${table.token} is not null and ${table.leaseUntil} is not null and ${table.itemEpoch} >= 1)`),
  check('pipeline_item_leases_epoch_check', sql`${table.stageEpoch} between 1 and 9007199254740991 and ${table.itemEpoch} between 0 and 9007199254740991`),
  index('pipeline_item_leases_expiry_idx').on(table.stage, table.leaseUntil, table.workKey).where(sql`${table.token} is not null`),
]);

/** Inactive model admission ledger. No caller, enable API, or post-dispatch release is installed here. */
export const modelCapacityControl = pgTable('model_capacity_control', {
  id: integer('id').primaryKey().default(1),
  mode: varchar('mode', { length: 10 }).$type<ModelCapacityMode>().notNull().default('disabled'),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(1),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  policy: jsonb('policy').$type<ModelCapacityPolicy>(),
  policyHash: varchar('policy_hash', { length: 64 }),
  cursor: integer('cursor').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  check('model_capacity_control_id_check', sql`${table.id} = 1`),
  check('model_capacity_control_mode_check', sql`${table.mode} in ('disabled','open','draining')`),
  check('model_capacity_control_epoch_check', sql`${table.epoch} between 1 and 9007199254740991 and ${table.revision} between 1 and 9007199254740991`),
  check('model_capacity_control_policy_check', sql`(${table.policy} is null and ${table.policyHash} is null and ${table.mode} = 'disabled') or (${table.policy} is not null and jsonb_typeof(${table.policy}) = 'object' and ${table.policyHash} is not null and ${table.policyHash} ~ '^[a-f0-9]{64}$')`),
  check('model_capacity_control_cursor_check', sql`${table.cursor} between 0 and 95`),
]);

export const modelCapacityRequests = pgTable('model_capacity_requests', {
  requestId: uuid('request_id').primaryKey(),
  queueOrdinal: bigserial('queue_ordinal', { mode: 'number' }).notNull().unique(),
  workKey: varchar('work_key', { length: 160 }).notNull(),
  ownerInstanceId: varchar('owner_instance_id', { length: 120 }).notNull(),
  ownerBootId: uuid('owner_boot_id').notNull(),
  class: varchar('class', { length: 10 }).$type<ModelCapacityClass>().notNull(),
  pool: varchar('pool', { length: 8 }).$type<ModelCapacityPool>().notNull(),
  routeId: varchar('route_id', { length: 120 }).notNull(),
  provider: varchar('provider', { length: 60 }).notNull(),
  model: varchar('model', { length: 200 }).notNull(),
  providerBudgetId: varchar('provider_budget_id', { length: 120 }).notNull(),
  groupId: varchar('group_id', { length: 120 }).notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  policyHash: varchar('policy_hash', { length: 64 }).notNull(),
  state: varchar('state', { length: 13 }).$type<ModelCapacityState>().notNull(),
  logicalWorkKey: varchar('logical_work_key', { length: 160 }),
  dispatchBinding: jsonb('dispatch_binding').$type<Ai1DispatchBinding>(),
  dispatchBindingHash: varchar('dispatch_binding_hash', { length: 64 }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true, precision: 3 }),
  terminalEvidence: jsonb('terminal_evidence').$type<Ai1GatewayTerminalEvidence>(),
  terminalEvidenceHash: varchar('terminal_evidence_hash', { length: 64 }),
  settledAt: timestamp('settled_at', { withTimezone: true, precision: 3 }),
  token: uuid('token'),
  reservedUntil: timestamp('reserved_until', { withTimezone: true, precision: 3 }),
  queuedAt: timestamp('queued_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  queueUntil: timestamp('queue_until', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  check('model_capacity_requests_ordinal_check', sql`${table.queueOrdinal} between 1 and 9007199254740991`),
  check('model_capacity_requests_epoch_check', sql`${table.epoch} between 1 and 9007199254740991 and ${table.revision} between 1 and 9007199254740991`),
  check('model_capacity_requests_class_check', sql`${table.class} in ('first','second','background')`),
  check('model_capacity_requests_pool_check', sql`${table.pool} in ('reviewer','text') and (${table.class} = 'background' or ${table.pool} = 'reviewer')`),
  check('model_capacity_requests_identity_check', sql`char_length(${table.workKey}) > 0 and ${table.workKey} = btrim(${table.workKey}) and ${table.workKey} !~ '[[:cntrl:]]' and char_length(${table.ownerInstanceId}) > 0 and ${table.ownerInstanceId} = btrim(${table.ownerInstanceId}) and ${table.ownerInstanceId} !~ '[[:cntrl:]]' and char_length(${table.routeId}) > 0 and ${table.routeId} = btrim(${table.routeId}) and ${table.routeId} !~ '[[:cntrl:]]' and char_length(${table.provider}) > 0 and ${table.provider} = btrim(${table.provider}) and ${table.provider} !~ '[[:cntrl:]]' and char_length(${table.model}) > 0 and ${table.model} = btrim(${table.model}) and ${table.model} !~ '[[:cntrl:]]' and char_length(${table.providerBudgetId}) > 0 and ${table.providerBudgetId} = btrim(${table.providerBudgetId}) and ${table.providerBudgetId} !~ '[[:cntrl:]]' and char_length(${table.groupId}) > 0 and ${table.groupId} = btrim(${table.groupId}) and ${table.groupId} !~ '[[:cntrl:]]'`),
  check('model_capacity_requests_hash_check', sql`${table.policyHash} ~ '^[a-f0-9]{64}$'`),
  check('model_capacity_requests_state_check', sql`${table.state} in ('waiting','reserved','dispatched','indeterminate','withdrawn','settled')`),
  check('model_capacity_requests_token_check', sql`(${table.token} is null and ${table.reservedUntil} is null and ${table.state} in ('waiting','withdrawn')) or (${table.token} is not null and ${table.reservedUntil} is not null and ${table.state} in ('reserved','dispatched','indeterminate','withdrawn','settled'))`),
  check('model_capacity_requests_logical_check', sql.raw("logical_work_key IS NULL OR (logical_work_key ~ '^ai1:[1-9][0-9]{0,15}$' AND class='first' AND pool='reviewer' AND route_id='crawl-agent-review' AND provider='abcllm')")),
  check('model_capacity_requests_dispatch_check', sql.raw("(dispatch_binding IS NULL AND dispatch_binding_hash IS NULL AND dispatched_at IS NULL AND (logical_work_key IS NULL OR state NOT IN ('dispatched','indeterminate','settled'))) OR coalesce((dispatch_binding IS NOT NULL AND dispatch_binding_hash IS NOT NULL AND dispatched_at IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND logical_work_key IS NOT NULL AND state IN ('dispatched','indeterminate','settled') AND (jsonb_typeof(dispatch_binding)='object') AND (dispatch_binding ?& ARRAY['kind','version','logicalWorkKey','candidateId','attemptId','inputHash','sourceRevisionHash','reviewPolicyHash','promptVersion','rulesVersion','provider','model','routeId','stageEpoch','wireHash','servingContractHash','totalTokenBound','chargedTokens','job']) AND (dispatch_binding - ARRAY['kind','version','logicalWorkKey','candidateId','attemptId','inputHash','sourceRevisionHash','reviewPolicyHash','promptVersion','rulesVersion','provider','model','routeId','stageEpoch','wireHash','servingContractHash','totalTokenBound','chargedTokens','job'] = '{}'::jsonb) AND (dispatch_binding->>'kind'='ai1_legacy_gateway') AND (dispatch_binding->'version'='1'::jsonb) AND (dispatch_binding->>'logicalWorkKey'=logical_work_key) AND (logical_work_key='ai1:' || (dispatch_binding->>'candidateId')) AND (dispatch_binding->>'provider'=provider) AND (dispatch_binding->>'routeId'=route_id) AND (dispatch_binding->>'model'=model) AND (CASE WHEN jsonb_typeof(dispatch_binding->'candidateId')='number' AND (dispatch_binding->'candidateId')::text ~ '^[0-9]+$' THEN (dispatch_binding->'candidateId')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(dispatch_binding->'attemptId')='number' AND (dispatch_binding->'attemptId')::text ~ '^[0-9]+$' THEN (dispatch_binding->'attemptId')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(dispatch_binding->'stageEpoch')='number' AND (dispatch_binding->'stageEpoch')::text ~ '^[0-9]+$' THEN (dispatch_binding->'stageEpoch')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(dispatch_binding->'totalTokenBound')='number' AND (dispatch_binding->'totalTokenBound')::text ~ '^[0-9]+$' THEN (dispatch_binding->'totalTokenBound')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(dispatch_binding->'chargedTokens')='number' AND (dispatch_binding->'chargedTokens')::text ~ '^[0-9]+$' THEN (dispatch_binding->'chargedTokens')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (dispatch_binding->'totalTokenBound'=dispatch_binding->'chargedTokens') AND (jsonb_typeof(dispatch_binding->'inputHash')='string' AND dispatch_binding->>'inputHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(dispatch_binding->'sourceRevisionHash')='string' AND dispatch_binding->>'sourceRevisionHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(dispatch_binding->'reviewPolicyHash')='string' AND dispatch_binding->>'reviewPolicyHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(dispatch_binding->'wireHash')='string' AND dispatch_binding->>'wireHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(dispatch_binding->'servingContractHash')='string' AND dispatch_binding->>'servingContractHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(dispatch_binding->'promptVersion')='string' AND char_length(dispatch_binding->>'promptVersion') BETWEEN 1 AND 120 AND dispatch_binding->>'promptVersion'=btrim(dispatch_binding->>'promptVersion') AND dispatch_binding->>'promptVersion' !~ '[[:cntrl:]]') AND (jsonb_typeof(dispatch_binding->'rulesVersion')='string' AND char_length(dispatch_binding->>'rulesVersion') BETWEEN 1 AND 120 AND dispatch_binding->>'rulesVersion'=btrim(dispatch_binding->>'rulesVersion') AND dispatch_binding->>'rulesVersion' !~ '[[:cntrl:]]') AND (jsonb_typeof(dispatch_binding->'model')='string' AND char_length(dispatch_binding->>'model') BETWEEN 1 AND 200 AND dispatch_binding->>'model'=btrim(dispatch_binding->>'model') AND dispatch_binding->>'model' !~ '[[:cntrl:]]') AND (jsonb_typeof(dispatch_binding->'job')='object') AND ((dispatch_binding->'job') ?& ARRAY['name','token','requestedVersion']) AND ((dispatch_binding->'job') - ARRAY['name','token','requestedVersion']='{}'::jsonb) AND (dispatch_binding->'job'->>'name'='crawl-agent-review') AND (dispatch_binding->'job'->>'token' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND (CASE WHEN jsonb_typeof(dispatch_binding->'job'->'requestedVersion')='number' AND (dispatch_binding->'job'->'requestedVersion')::text ~ '^[0-9]+$' THEN (dispatch_binding->'job'->'requestedVersion')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END)),false)")),
  check('model_capacity_requests_terminal_check', sql.raw("(terminal_evidence IS NULL AND terminal_evidence_hash IS NULL AND settled_at IS NULL AND state<>'settled') OR coalesce((state='settled' AND dispatch_binding IS NOT NULL AND terminal_evidence IS NOT NULL AND terminal_evidence_hash IS NOT NULL AND settled_at IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND terminal_evidence->'dispatch'=jsonb_build_object('requestId',request_id::text,'owner',jsonb_build_object('instanceId',owner_instance_id,'bootId',owner_boot_id::text),'token',token::text,'epoch',epoch,'revision',revision,'policyHash',policy_hash,'binding',dispatch_binding,'bindingHash',dispatch_binding_hash) AND (jsonb_typeof(terminal_evidence)='object' AND (terminal_evidence) ?& ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance'] AND (terminal_evidence) - ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance']='{}'::jsonb) AND (terminal_evidence->>'kind'='ai1_gateway_terminal') AND (terminal_evidence->'version'='1'::jsonb) AND (terminal_evidence->>'finishReason' IN ('stop','length','tool_calls','function_call','content_filter')) AND (jsonb_typeof(terminal_evidence->'responseHash')='string' AND terminal_evidence->>'responseHash' ~ '^[a-f0-9]{64}$') AND (((terminal_evidence->'actualUsage'='null'::jsonb AND terminal_evidence->>'provenance'='unknown') OR (terminal_evidence->>'provenance'='upstream_reported' AND jsonb_typeof(terminal_evidence->'actualUsage')='object' AND (terminal_evidence->'actualUsage') ?& ARRAY['inputTokens','outputTokens','totalTokens'] AND (terminal_evidence->'actualUsage') - ARRAY['inputTokens','outputTokens','totalTokens']='{}'::jsonb AND CASE WHEN (CASE WHEN jsonb_typeof(terminal_evidence->'actualUsage'->'inputTokens')='number' AND (terminal_evidence->'actualUsage'->'inputTokens')::text ~ '^[0-9]+$' THEN (terminal_evidence->'actualUsage'->'inputTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(terminal_evidence->'actualUsage'->'outputTokens')='number' AND (terminal_evidence->'actualUsage'->'outputTokens')::text ~ '^[0-9]+$' THEN (terminal_evidence->'actualUsage'->'outputTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(terminal_evidence->'actualUsage'->'totalTokens')='number' AND (terminal_evidence->'actualUsage'->'totalTokens')::text ~ '^[0-9]+$' THEN (terminal_evidence->'actualUsage'->'totalTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(terminal_evidence->'dispatch'->'binding'->'totalTokenBound')='number' AND (terminal_evidence->'dispatch'->'binding'->'totalTokenBound')::text ~ '^[0-9]+$' THEN (terminal_evidence->'dispatch'->'binding'->'totalTokenBound')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) THEN (terminal_evidence->'actualUsage'->>'inputTokens')::numeric + (terminal_evidence->'actualUsage'->>'outputTokens')::numeric = (terminal_evidence->'actualUsage'->>'totalTokens')::numeric AND (terminal_evidence->'actualUsage'->>'totalTokens')::numeric <= (terminal_evidence->'dispatch'->'binding'->'totalTokenBound')::text::numeric ELSE false END)))),false)")),
  uniqueIndex('model_capacity_requests_ai1_attempt_idx').on(sql`(${table.dispatchBinding}->>'attemptId')`).where(sql`${table.dispatchBinding} is not null`),
  uniqueIndex('model_capacity_requests_logical_active_idx').on(table.logicalWorkKey).where(sql`${table.logicalWorkKey} is not null and ${table.state} in ('reserved','dispatched','indeterminate')`),
  uniqueIndex('model_capacity_requests_live_work_idx').on(table.ownerInstanceId, table.ownerBootId, table.workKey).where(sql`${table.state} in ('waiting','reserved','dispatched','indeterminate')`),
  index('model_capacity_requests_waiting_idx').on(table.class, table.queueOrdinal).where(sql`${table.state} = 'waiting'`),
  index('model_capacity_requests_active_idx').on(table.providerBudgetId, table.groupId, table.pool).where(sql`${table.state} in ('reserved','dispatched','indeterminate')`),
]);

/** 0078 statement triggers reject UPDATE/DELETE, including zero rows, and TRUNCATE. */
export const modelCapacityEvents = pgTable('model_capacity_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  requestId: uuid('request_id').notNull(),
  kind: varchar('kind', { length: 32 }).$type<ModelCapacityEventKind>().notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  policyHash: varchar('policy_hash', { length: 64 }).notNull(),
  fromState: varchar('from_state', { length: 13 }).$type<ModelCapacityState>(),
  toState: varchar('to_state', { length: 13 }).$type<ModelCapacityState>(),
  reason: varchar('reason', { length: 32 }).$type<ModelCapacityEventReason>(),
  evidence: jsonb('evidence'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  foreignKey({ columns: [table.requestId], foreignColumns: [modelCapacityRequests.requestId], name: 'model_capacity_events_request_fk' }),
  check('model_capacity_events_id_check', sql`${table.id} between 1 and 9007199254740991`),
  check('model_capacity_events_epoch_check', sql`${table.epoch} between 1 and 9007199254740991 and ${table.revision} between 1 and 9007199254740991`),
  check('model_capacity_events_hash_check', sql`${table.policyHash} ~ '^[a-f0-9]{64}$'`),
  check('model_capacity_events_kind_check', sql`${table.kind} in ('queued','reserved','dispatch_started','reservation_cancelled','reservation_expired','wait_expired','policy_changed','dispatch_indeterminate','dispatch_settled')`),
  check('model_capacity_events_state_check', sql`(${table.fromState} is null or ${table.fromState} in ('waiting','reserved','dispatched','indeterminate','withdrawn','settled')) and (${table.toState} is null or ${table.toState} in ('waiting','reserved','dispatched','indeterminate','withdrawn','settled'))`),
  check('model_capacity_events_reason_check', sql`${table.reason} is null or ${table.reason} in ('transport_unknown','local_abort','process_exit','commit_unknown')`),
  check('model_capacity_events_terminal_check', sql.raw("kind<>'dispatch_settled' OR coalesce((evidence IS NOT NULL AND from_state IN ('dispatched','indeterminate') AND to_state='settled' AND (jsonb_typeof(evidence)='object' AND (evidence) ?& ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance'] AND (evidence) - ARRAY['version','kind','dispatch','finishReason','responseHash','actualUsage','provenance']='{}'::jsonb) AND (evidence->>'kind'='ai1_gateway_terminal') AND (evidence->'version'='1'::jsonb) AND (evidence->>'finishReason' IN ('stop','length','tool_calls','function_call','content_filter')) AND (jsonb_typeof(evidence->'responseHash')='string' AND evidence->>'responseHash' ~ '^[a-f0-9]{64}$') AND (((evidence->'actualUsage'='null'::jsonb AND evidence->>'provenance'='unknown') OR (evidence->>'provenance'='upstream_reported' AND jsonb_typeof(evidence->'actualUsage')='object' AND (evidence->'actualUsage') ?& ARRAY['inputTokens','outputTokens','totalTokens'] AND (evidence->'actualUsage') - ARRAY['inputTokens','outputTokens','totalTokens']='{}'::jsonb AND CASE WHEN (CASE WHEN jsonb_typeof(evidence->'actualUsage'->'inputTokens')='number' AND (evidence->'actualUsage'->'inputTokens')::text ~ '^[0-9]+$' THEN (evidence->'actualUsage'->'inputTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(evidence->'actualUsage'->'outputTokens')='number' AND (evidence->'actualUsage'->'outputTokens')::text ~ '^[0-9]+$' THEN (evidence->'actualUsage'->'outputTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(evidence->'actualUsage'->'totalTokens')='number' AND (evidence->'actualUsage'->'totalTokens')::text ~ '^[0-9]+$' THEN (evidence->'actualUsage'->'totalTokens')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof(evidence->'dispatch'->'binding'->'totalTokenBound')='number' AND (evidence->'dispatch'->'binding'->'totalTokenBound')::text ~ '^[0-9]+$' THEN (evidence->'dispatch'->'binding'->'totalTokenBound')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) THEN (evidence->'actualUsage'->>'inputTokens')::numeric + (evidence->'actualUsage'->>'outputTokens')::numeric = (evidence->'actualUsage'->>'totalTokens')::numeric AND (evidence->'actualUsage'->>'totalTokens')::numeric <= (evidence->'dispatch'->'binding'->'totalTokenBound')::text::numeric ELSE false END))) AND (jsonb_typeof(evidence->'dispatch')='object' AND (evidence->'dispatch') ?& ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash'] AND (evidence->'dispatch') - ARRAY['requestId','owner','token','epoch','revision','policyHash','binding','bindingHash']='{}'::jsonb) AND (jsonb_typeof(evidence->'dispatch'->'owner')='object' AND (evidence->'dispatch'->'owner') ?& ARRAY['instanceId','bootId'] AND (evidence->'dispatch'->'owner') - ARRAY['instanceId','bootId']='{}'::jsonb) AND (evidence->'dispatch'->>'requestId'=request_id::text) AND (evidence->'dispatch'->'epoch'=to_jsonb(epoch)) AND (evidence->'dispatch'->'revision'=to_jsonb(revision)) AND (evidence->'dispatch'->>'policyHash'=policy_hash) AND (evidence->'dispatch'->>'bindingHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof(evidence->'dispatch'->'owner'->'instanceId')='string' AND char_length(evidence->'dispatch'->'owner'->>'instanceId') BETWEEN 1 AND 120 AND evidence->'dispatch'->'owner'->>'instanceId'=btrim(evidence->'dispatch'->'owner'->>'instanceId') AND evidence->'dispatch'->'owner'->>'instanceId' !~ '[[:cntrl:]]') AND (evidence->'dispatch'->>'token' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND (evidence->'dispatch'->'owner'->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND ((jsonb_typeof((evidence->'dispatch'->'binding'))='object') AND ((evidence->'dispatch'->'binding') ?& ARRAY['kind','version','logicalWorkKey','candidateId','attemptId','inputHash','sourceRevisionHash','reviewPolicyHash','promptVersion','rulesVersion','provider','model','routeId','stageEpoch','wireHash','servingContractHash','totalTokenBound','chargedTokens','job']) AND ((evidence->'dispatch'->'binding') - ARRAY['kind','version','logicalWorkKey','candidateId','attemptId','inputHash','sourceRevisionHash','reviewPolicyHash','promptVersion','rulesVersion','provider','model','routeId','stageEpoch','wireHash','servingContractHash','totalTokenBound','chargedTokens','job'] = '{}'::jsonb) AND ((evidence->'dispatch'->'binding')->>'kind'='ai1_legacy_gateway') AND ((evidence->'dispatch'->'binding')->'version'='1'::jsonb) AND true AND ((evidence->'dispatch'->'binding')->>'logicalWorkKey'='ai1:' || ((evidence->'dispatch'->'binding')->>'candidateId')) AND ((evidence->'dispatch'->'binding')->>'provider'='abcllm') AND ((evidence->'dispatch'->'binding')->>'routeId'='crawl-agent-review') AND true AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'candidateId')='number' AND ((evidence->'dispatch'->'binding')->'candidateId')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'candidateId')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'attemptId')='number' AND ((evidence->'dispatch'->'binding')->'attemptId')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'attemptId')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'stageEpoch')='number' AND ((evidence->'dispatch'->'binding')->'stageEpoch')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'stageEpoch')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'totalTokenBound')='number' AND ((evidence->'dispatch'->'binding')->'totalTokenBound')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'totalTokenBound')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'chargedTokens')='number' AND ((evidence->'dispatch'->'binding')->'chargedTokens')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'chargedTokens')::text::numeric BETWEEN 1 AND 9007199254740991 ELSE false END) AND ((evidence->'dispatch'->'binding')->'totalTokenBound'=(evidence->'dispatch'->'binding')->'chargedTokens') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'inputHash')='string' AND (evidence->'dispatch'->'binding')->>'inputHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'sourceRevisionHash')='string' AND (evidence->'dispatch'->'binding')->>'sourceRevisionHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'reviewPolicyHash')='string' AND (evidence->'dispatch'->'binding')->>'reviewPolicyHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'wireHash')='string' AND (evidence->'dispatch'->'binding')->>'wireHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'servingContractHash')='string' AND (evidence->'dispatch'->'binding')->>'servingContractHash' ~ '^[a-f0-9]{64}$') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'promptVersion')='string' AND char_length((evidence->'dispatch'->'binding')->>'promptVersion') BETWEEN 1 AND 120 AND (evidence->'dispatch'->'binding')->>'promptVersion'=btrim((evidence->'dispatch'->'binding')->>'promptVersion') AND (evidence->'dispatch'->'binding')->>'promptVersion' !~ '[[:cntrl:]]') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'rulesVersion')='string' AND char_length((evidence->'dispatch'->'binding')->>'rulesVersion') BETWEEN 1 AND 120 AND (evidence->'dispatch'->'binding')->>'rulesVersion'=btrim((evidence->'dispatch'->'binding')->>'rulesVersion') AND (evidence->'dispatch'->'binding')->>'rulesVersion' !~ '[[:cntrl:]]') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'model')='string' AND char_length((evidence->'dispatch'->'binding')->>'model') BETWEEN 1 AND 200 AND (evidence->'dispatch'->'binding')->>'model'=btrim((evidence->'dispatch'->'binding')->>'model') AND (evidence->'dispatch'->'binding')->>'model' !~ '[[:cntrl:]]') AND (jsonb_typeof((evidence->'dispatch'->'binding')->'job')='object') AND (((evidence->'dispatch'->'binding')->'job') ?& ARRAY['name','token','requestedVersion']) AND (((evidence->'dispatch'->'binding')->'job') - ARRAY['name','token','requestedVersion']='{}'::jsonb) AND ((evidence->'dispatch'->'binding')->'job'->>'name'='crawl-agent-review') AND ((evidence->'dispatch'->'binding')->'job'->>'token' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND (CASE WHEN jsonb_typeof((evidence->'dispatch'->'binding')->'job'->'requestedVersion')='number' AND ((evidence->'dispatch'->'binding')->'job'->'requestedVersion')::text ~ '^[0-9]+$' THEN ((evidence->'dispatch'->'binding')->'job'->'requestedVersion')::text::numeric BETWEEN 0 AND 9007199254740991 ELSE false END))),false)")),
  check('model_capacity_events_evidence_check', sql`${table.evidence} is null or jsonb_typeof(${table.evidence}) = 'object'`),
  uniqueIndex('model_capacity_events_terminal_idx').on(table.requestId).where(sql`${table.kind} = 'dispatch_settled'`),
  index('model_capacity_events_request_idx').on(table.requestId, table.id),
]);

export const operationsObservations = pgTable('operations_observations', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  observedAt: timestamp('observed_at').notNull().defaultNow(),
});
export const categoryDecisions = pgTable('category_decisions', {
  repo: varchar('repo', { length: 200 }).primaryKey(),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  category: varchar('category', { length: 40 }),
  reason: text('reason').notNull(),
  actor: varchar('actor', { length: 120 }).notNull(),
  revision: integer('revision').notNull().default(1),
  retryAt: timestamp('retry_at').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
/**
 * 관리자 작업 로그. 덧붙이기만 한다 — 고치기·지우기·비우기는 DB 트리거가 거부한다(0056).
 * 스크립트가 남긴 옛 행은 actor_kind·ip 가 비어 있다.
 */
export const operationsAudit = pgTable('operations_audit', {
  id: serial('id').primaryKey(), actor: varchar('actor', { length: 120 }).notNull(),
  action: varchar('action', { length: 80 }).notNull(), target: varchar('target', { length: 200 }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** 'github' | 'local' | 'token' */
  actorKind: varchar('actor_kind', { length: 12 }),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 300 }),
  ok: boolean('ok').notNull().default(true),
  error: varchar('error', { length: 300 }),
}, (table) => [index('operations_audit_action_created_idx').on(table.action, table.createdAt.desc())]);

/** Collector PATs are encrypted with a dedicated secret shared by web and crawler instances. */
export const githubCollectorAccounts = pgTable('github_collector_accounts', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  login: varchar('login', { length: 100 }).notNull(),
  encryptedToken: text('encrypted_token').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  coreQuota: jsonb('core_quota').$type<{ limit: number; used: number; remaining: number; reset: number }>(),
  quotaObservedAt: timestamp('quota_observed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
/**
 * GitHub App 수집 자격(0064) — 설치(installation)마다 따로 한도가 있어, 같은 계정의 개인 토큰과 달리 한도가 더해진다.
 * 개인 키는 수집 비밀키(GITHUB_COLLECTOR_SECRET)로 암호화해 두고, 워커가 한 시간짜리 설치 토큰을 만들어 쓴다(github-apps.ts).
 */
export const githubCollectorApps = pgTable('github_collector_apps', {
  installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
  appId: bigint('app_id', { mode: 'number' }).notNull(),
  appSlug: varchar('app_slug', { length: 100 }).notNull(),
  accountLogin: varchar('account_login', { length: 100 }).notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  coreQuota: jsonb('core_quota').$type<{ limit: number; used: number; remaining: number; reset: number }>(),
  quotaObservedAt: timestamp('quota_observed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Additive, disabled by default. A draining transition changes no live job/item owner. */
export const jobBatchControl = pgTable('job_batch_control', {
  id: integer('id').primaryKey().notNull(),
  mode: varchar('mode', { length: 12 }).$type<'legacy' | 'draining' | 'versioned'>().notNull().default('legacy'),
  drainingFrom: varchar('draining_from', { length: 12 }).$type<'legacy' | 'versioned'>(),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(1),
  writerContractVersion: integer('writer_contract_version').notNull().default(0),
  policy: jsonb('policy'), policyHash: varchar('policy_hash', { length: 64 }),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
},table=>[
  check('job_batch_control_id_check',sql`${table.id}=1`),
  check('job_batch_control_mode_check',sql`${table.mode} IN ('legacy','draining','versioned')`),
  check('job_batch_control_epoch_check',sql`${table.epoch} BETWEEN 1 AND 9007199254740991`),
  check('job_batch_control_writer_contract_version_check',sql`${table.writerContractVersion}>=0`),
  check('job_batch_control_drain_check',sql`(${table.mode}='draining' AND ${table.drainingFrom} IS NOT NULL AND ${table.drainingFrom} IN ('legacy','versioned')) OR (${table.mode}<>'draining' AND ${table.drainingFrom} IS NULL)`),
  check('job_batch_control_policy_check',sql`(${table.policy} IS NULL AND ${table.policyHash} IS NULL) OR (${table.policy} IS NOT NULL AND ${table.policyHash} IS NOT NULL AND ${table.policyHash} ~ '^[0-9a-f]{64}$')`),
]);
export const jobBatchCandidates = pgTable('job_batch_candidates', {
  role: varchar('role', { length: 30 }).notNull(), instanceId: varchar('instance_id', { length: 48 }).notNull(),
  host: varchar('host', { length: 24 }).notNull(), bootId: varchar('boot_id', { length: 36 }).notNull(),
  release: varchar('release', { length: 120 }).notNull(), policyHash: varchar('policy_hash', { length: 64 }).notNull(),
  capability: jsonb('capability'), resultEvidence: jsonb('result_evidence'),
  observedAt: timestamp('observed_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [primaryKey({columns:[table.role,table.instanceId]}),
  check('job_batch_candidates_role_check',sql`${table.role} IN ('crawler','reviewer','publisher','text','maintenance','translation','product-health','site-evidence','official-news')`),
  check('job_batch_candidates_host_check',sql`${table.host} IN ('m3','mini','oracle-osaka-smoke')`),
  check('job_batch_candidates_policy_hash_check',sql`${table.policyHash} ~ '^[0-9a-f]{64}$'`),
]);
