import { z } from 'zod';
import { batchPolicySchema, batchPolicyHash, BATCH_HOSTS, BATCH_ROLES } from '@/lib/jobs/batches';
import { modelCapacityPolicySchema, modelCapacityPolicyHash } from '@/lib/llm/capacity';
import { httpOriginPolicySchema, httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { UptimeSourcesSchema } from '@/lib/domain/products/uptime-policy';
import { buildPipelineRuntimeStatus, type PipelineRuntimeStatus } from './pipeline-runtime-status';
import { storedUptimeSplitPolicy, uptimeSplitNote, uptimeSplitReadbackSchema } from './uptime-split';

export type ControlMetric = { label: string; value: number | null };
export type ControlReadback = { key: string; label: string; mode: string | null; epoch: number | null; revision: number | null;
  policy: 'verified' | 'unset' | 'unknown'; metrics: ControlMetric[]; note: string };
export type PipelineControlStatus = { observedAt: string | null; controls: ControlReadback[];
  stages: { stage: string; mode: string | null; epoch: number | null; contract: number | null; live: number | null; unsettled: number | null }[];
  backlog: ControlMetric[]; hosts: { host: string; roles: { role: string; ready: boolean; reason: string }[] }[];
  owners: { role: string; instanceId: string | null; host: string | null; release: string | null; epoch: number | null; live: boolean | null }[];
  runtime: PipelineRuntimeStatus };
const CONTROL_LABELS = { batch: '작업 배치', source: '사이트 근거', model: '공통 모델 슬롯', http: '공유 HTTP', uptime: '연결 관측',
  uptimeSplit: '응답 점검 분담' };
const positive = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime({ offset: true });
const stageSchema = z.object({ stage: z.enum(['fetch', 'ai1', 'ai2']), mode: z.enum(['legacy', 'draining', 'items']),
  epoch: positive, contract: count, live: count, unsettled: count });
const batchSchema = z.object({ mode: z.enum(['legacy', 'draining', 'versioned']), epoch: positive, contract: count,
  policy: z.unknown(), policyHash: z.string().nullable() });
const sourceSchema = z.object({ enabled: z.boolean(), epoch: positive, live: count, unsettled: count, due: count, backoff: count });
const modelSchema = z.object({ mode: z.enum(['disabled', 'open', 'draining']), epoch: positive, revision: positive,
  policy: z.unknown(), policyHash: z.string().nullable(), waiting: count, reserved: count, dispatched: count, indeterminate: count,
  oldestWaitingAt: timestamp.nullable() });
const httpSchema = z.object({ mode: z.enum(['disabled', 'open', 'draining']), epoch: positive, revision: positive,
  policy: z.unknown(), policyHash: z.string().nullable(), reserved: count, dispatched: count, indeterminate: count, oracleCharged: count });
const uptimeSchema = z.object({ observationsEnabled: z.boolean(), gateEnabled: z.boolean(), revision: positive,
  sources: UptimeSourcesSchema, rawOnly: count, held: count, applied: count, latestAt: timestamp.nullable() })
  .refine(row => !row.gateEnabled || row.observationsEnabled);
const backlogSchema = z.object({ fetchReady: count, fetchBackoff: count, human: count, jobRequests: count });
const ownersSchema = z.array(z.object({ role: z.string(), instanceId: z.string().nullable(), release: z.string().nullable(),
  epoch: count, live: z.boolean() }));
// 후보 표에는 batch 역할 밖의 후보도 있다(Oracle scheduler 의 role 'scheduler' — identity_mismatch 행). 그 한 행 때문에
// 표 전체를 못 읽지 않도록 role 은 글자로 받고, host 표는 batch 역할 행만 골라 쓴다.
const readinessSchema = z.object({ mode: z.enum(['legacy', 'draining', 'versioned']), epoch: positive, policyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  candidates: z.array(z.object({ role: z.string(), host: z.enum(BATCH_HOSTS), instanceId: z.string(), release: z.string(),
    anchor: z.boolean().nullable().optional(), ready: z.boolean(), reason: z.string() })) });
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const metric = (label: string, value: number | null): ControlMetric => ({ label, value });

/** Presentation only. DB configuration, ledger counts and capability evidence are separate facts. */
export function buildPipelineControlStatus(raw: unknown, readiness: unknown): PipelineControlStatus {
  const input = record(raw), clock = timestamp.safeParse(input.at);
  const result: PipelineControlStatus = { observedAt: clock.success ? clock.data : null,
    controls: Object.entries(CONTROL_LABELS).map(([key, label]) => ({ key, label, mode: null,
      epoch: null, revision: null, policy: 'unknown', metrics: [], note: '읽지 못했습니다.' })),
    stages: ['fetch', 'ai1', 'ai2'].map(stage => ({ stage, mode: null, epoch: null, contract: null, live: null, unsettled: null })),
    backlog: ['수집 대기', '수집 재시도 예약', '심사 대기', '요청 남은 작업'].map(label => metric(label, null)),
    hosts: BATCH_HOSTS.map(host => ({ host, roles: BATCH_ROLES.map(role => ({ role, ready: false, reason: 'readback_unknown' })) })), owners: [],
    runtime: buildPipelineRuntimeStatus(null, { at: null, batchMode: null, batchPolicy: null, readiness: null, owners: null }) };
  if (!clock.success) return result;
  const set = (key: keyof typeof CONTROL_LABELS, values: Partial<ControlReadback>) => Object.assign(result.controls.find(row => row.key === key)!, values);
  const batch = batchSchema.safeParse(input.batch);
  let batchPolicy: z.infer<typeof batchPolicySchema> | null = null;
  if (batch.success) {
    const row = batch.data, parsed = batchPolicySchema.safeParse(row.policy);
    const unset = row.policy === null && row.policyHash === null && row.mode === 'legacy';
    if (parsed.success && batchPolicyHash(parsed.data) === row.policyHash) batchPolicy = parsed.data;
    set('batch', { mode: unset || batchPolicy ? row.mode : null, epoch: row.epoch,
      policy: unset ? 'unset' : batchPolicy ? 'verified' : 'unknown', metrics: [metric('writer 계약', row.contract)],
      note: '배치 설정과 host 준비조건을 구분합니다.' });
  }
  const stageRows = z.array(stageSchema).safeParse(input.stages);
  if (stageRows.success) for (const stage of result.stages) {
    const matches = stageRows.data.filter(row => row.stage === stage.stage);
    if (matches.length === 1) Object.assign(stage, matches[0]);
  }
  const source = sourceSchema.safeParse(input.source);
  if (source.success) set('source', { mode: source.data.enabled ? 'open' : 'disabled', epoch: source.data.epoch, policy: 'unset',
    metrics: [metric('유효 소유', source.data.live), metric('기한 지난 미정산', source.data.unsettled), metric('재시도 시각 도달', source.data.due), metric('재시도 예약', source.data.backoff)],
    note: '기존 사이트 수집 장부입니다. 시각 도달 수는 현재 입력의 실행 적격 판정이 아닙니다.' });
  const model = modelSchema.safeParse(input.model);
  if (model.success) {
    const row = model.data, parsed = modelCapacityPolicySchema.safeParse(row.policy);
    const valid = parsed.success && modelCapacityPolicyHash(parsed.data) === row.policyHash;
    const unset = row.mode === 'disabled' && row.policy === null && row.policyHash === null;
    const age = row.oldestWaitingAt === null ? null : Math.floor((Date.parse(clock.data) - Date.parse(row.oldestWaitingAt)) / 60_000);
    set('model', { mode: valid || unset ? row.mode : null, epoch: row.epoch, revision: row.revision,
      policy: valid ? 'verified' : unset ? 'unset' : 'unknown',
      metrics: [metric('대기', row.waiting), metric('최장 대기(분)', age !== null && age >= 0 ? age : null), metric('예약', row.reserved),
        metric('미정산', row.dispatched + row.indeterminate), metric('dispatched', row.dispatched), metric('indeterminate', row.indeterminate),
        metric('설정 상한', valid ? parsed.data.globalLimit : null)],
      note: '미정산은 dispatched + indeterminate입니다. 기한 지난 대기·예약도 정리 전에는 남습니다. 설정 상한은 실제 모델 제공용량을 인증하지 않습니다.' });
  }
  const http = httpSchema.safeParse(input.http);
  if (http.success) {
    const row = http.data, parsed = httpOriginPolicySchema.safeParse(row.policy);
    const valid = parsed.success && httpOriginPolicyHash(parsed.data) === row.policyHash;
    const unset = row.mode === 'disabled' && row.policy === null && row.policyHash === null;
    set('http', { mode: valid || unset ? row.mode : null, epoch: row.epoch, revision: row.revision,
      policy: valid ? 'verified' : unset ? 'unset' : 'unknown',
      metrics: [metric('예약', row.reserved), metric('미정산', row.dispatched + row.indeterminate), metric('Oracle 점유', row.oracleCharged)],
      note: '정책 한도는 origin별 1 · Oracle 합계 2입니다. 기한 지난 예약도 장부에 남으며 실행기별 적용 여부는 별도 확인합니다.' });
  }
  const uptime = uptimeSchema.safeParse(input.uptime);
  if (uptime.success) {
    const row = uptime.data;
    set('uptime', { mode: row.gateEnabled ? 'gated' : row.observationsEnabled ? 'observing' : 'disabled', revision: row.revision, policy: 'unset',
      metrics: [metric('원시 관측', row.rawOnly), metric('판정 보류', row.held), metric('적용 기록', row.applied), metric('설정 관측지', row.sources.length)],
      note: '누적 관측 결과입니다. 원시 관측만으로 제품 실패나 Oracle 장애복구를 판정하지 않습니다.' });
  }
  // split-v1(0104): mode·epoch·policy 와 claim 장부. 마감 지남 = home 이 지금 가져갈 수 있는 수, 제출 대기 = 반영 안 된 Oracle 등 결과
  const split = uptimeSplitReadbackSchema.safeParse(input.uptimeSplit);
  if (split.success) {
    const row = split.data, stored = storedUptimeSplitPolicy(row.control), q = row.queue;
    const age = (value: number | null) => value === null ? null : Math.round(value);
    set('uptimeSplit', { mode: stored.state === 'invalid' && row.control.mode === 'claims' ? null : row.control.mode, epoch: row.control.epoch,
      policy: stored.state === 'verified' ? 'verified' : stored.state === 'unset' ? 'unset' : 'unknown',
      metrics: [metric('마감 지남', q.due), metric('최장 지남(분)', q.due ? age(q.dueOldestMinutes) : 0), metric('제출 대기', q.submitted),
        metric('제출 최장(분)', q.submitted ? age(q.submittedOldestMinutes) : 0), metric('재확인 대기', q.confirm),
        metric('재확인 최장(분)', q.confirm ? age(q.confirmOldestMinutes) : 0), metric('확인 중', q.claimed), metric('5분 반영', q.applied5m),
        metric('claim 행 없음', q.missingRows)],
      note: row.control.mode === 'claims' ? uptimeSplitNote(row)
        : `기존 방식으로 확인합니다(claim 장부는 읽기만). ${uptimeSplitNote(row)}` });
  }
  const backlog = backlogSchema.safeParse(input.backlog);
  if (backlog.success) result.backlog.forEach((row, i) => { row.value = [backlog.data.fetchReady, backlog.data.fetchBackoff, backlog.data.human, backlog.data.jobRequests][i]; });
  const ready = readinessSchema.safeParse(readiness), anchors = new Map<string, boolean | null>();
  if (ready.success && batch.success && ready.data.epoch === batch.data.epoch && ready.data.mode === batch.data.mode
    && ready.data.policyHash === batch.data.policyHash && batchPolicy) {
    for (const host of result.hosts) for (const role of host.roles) {
      const candidates = ready.data.candidates.filter(row => row.host === host.host && row.role === role.role);
      const matching = candidates.filter(row => row.release === batchPolicy!.release
        && batchPolicy!.instances.some(instance => instance.instanceId === row.instanceId && instance.host === row.host));
      const selected = matching.find(row => row.ready) ?? matching[0];
      if (selected) { Object.assign(role, { ready: selected.ready, reason: selected.reason }); anchors.set(`${host.host}:${role.role}`, selected.anchor ?? null); }
      else role.reason = candidates.length ? 'identity_mismatch' : 'candidate_missing';
    }
  }
  const owners = ownersSchema.safeParse(input.owners);
  if (owners.success) result.owners = owners.data.map(row => ({ ...row,
    host: batchPolicy?.instances.find(instance => instance.instanceId === row.instanceId)?.host ?? null }));
  result.runtime = buildPipelineRuntimeStatus(input, { at: clock.data, batchMode: result.controls.find(row => row.key === 'batch')!.mode, batchPolicy,
    readiness: result.hosts.flatMap(host => host.roles.map(role => ({ host: host.host, role: role.role, reason: role.reason,
      anchor: anchors.get(`${host.host}:${role.role}`) ?? null }))),
    owners: owners.success ? result.owners.map(row => ({ role: row.role, host: row.host, live: row.live === true })) : null });
  return result;
}

/** One read-only statement for control/ledger readback; no locks or runtime admission.
 * PR13b: host-slot 장부·provider budget 별 모델 슬롯·DR writer fence·Oracle 후보도 같은 문장·같은 DB 시계로 읽는다.
 * 방금 쓴 값이 필요 없는 관리자 집계(약 30개 count)라 복제본에서 읽는다(밀리거나 닿지 않으면 주 DB, lib/db/replica.ts).
 * 읽기 전용 TX 의 문장 상한으로 주 DB 로 넘어가도 오래 붙잡지 않고, 읽지 못하면 화면은 '읽지 못했습니다'에 남기고 로그를 남긴다. */
export async function readPipelineControlStatus(): Promise<PipelineControlStatus> {
  const [{ db, onReplica }, { sql }, { readJobBatchReadiness }, { logger }, { uptimeSplitReadbackSql }] = await Promise.all([
    import('@/lib/db'), import('drizzle-orm'), import('./job-batch-readiness'), import('@/lib/observability/logger'),
    import('./uptime-split-repository'),
  ]);
  const [snapshot, readiness] = await Promise.allSettled([
    onReplica(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const [row] = await tx.execute<{ snapshot: unknown }>(sql`
        WITH observation_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT jsonb_build_object(
          'at', c.at,
          'batch', (SELECT jsonb_build_object('mode',mode,'epoch',epoch,'contract',writer_contract_version,
            'policy',policy,'policyHash',policy_hash) FROM job_batch_control WHERE id=1),
          'stages', (SELECT jsonb_agg(jsonb_build_object('stage',s.stage,'mode',s.mode,'epoch',s.epoch,'contract',s.writer_contract_version,
            'live',(SELECT count(*) FROM pipeline_item_leases i WHERE i.stage=s.stage AND i.token IS NOT NULL AND i.lease_until>c.at),
            'unsettled',(SELECT count(*) FROM pipeline_item_leases i WHERE i.stage=s.stage AND i.token IS NOT NULL AND i.lease_until<=c.at)) ORDER BY s.stage)
            FROM pipeline_stage_modes s),
          'source', (SELECT jsonb_build_object('enabled',enabled,'epoch',epoch,
            'live',(SELECT count(*) FROM evidence_source_claims WHERE token IS NOT NULL AND lease_until>c.at),
            'unsettled',(SELECT count(*) FROM evidence_source_claims WHERE token IS NOT NULL AND lease_until<=c.at),
            'due',(SELECT count(*) FROM evidence_source_claims WHERE token IS NULL AND next_attempt_at<=c.at),
            'backoff',(SELECT count(*) FROM evidence_source_claims WHERE token IS NULL AND next_attempt_at>c.at))
            FROM evidence_source_control WHERE id=1),
          'model', (SELECT jsonb_build_object('mode',mode,'epoch',epoch,'revision',revision,'policy',policy,'policyHash',policy_hash,
            'waiting',(SELECT count(*) FROM model_capacity_requests WHERE state='waiting'),
            'reserved',(SELECT count(*) FROM model_capacity_requests WHERE state='reserved'),
            'dispatched',(SELECT count(*) FROM model_capacity_requests WHERE state='dispatched'),
            'indeterminate',(SELECT count(*) FROM model_capacity_requests WHERE state='indeterminate'),
            'oldestWaitingAt',(SELECT min(queued_at) FROM model_capacity_requests WHERE state='waiting'))
            FROM model_capacity_control WHERE id=1),
          'http', (SELECT jsonb_build_object('mode',mode,'epoch',epoch,'revision',revision,'policy',policy,'policyHash',policy_hash,
            'reserved',(SELECT count(*) FROM http_origin_hops WHERE state='reserved'),
            'dispatched',(SELECT count(*) FROM http_origin_hops WHERE state='dispatched'),
            'indeterminate',(SELECT count(*) FROM http_origin_hops WHERE state='indeterminate'),
            'oracleCharged',(SELECT count(*) FROM http_origin_hops WHERE host_id='oracle-osaka-smoke' AND state IN ('reserved','dispatched','indeterminate')))
            FROM http_origin_control WHERE id=1),
          'uptime', (SELECT jsonb_build_object('observationsEnabled',observations_enabled,'gateEnabled',gate_enabled,'revision',revision,'sources',sources,
            'rawOnly',(SELECT count(*) FROM uptime_observations WHERE disposition='raw_only'),
            'held',(SELECT count(*) FROM uptime_observations WHERE disposition='observation_hold'),
            'applied',(SELECT count(*) FROM uptime_observations WHERE disposition='applied'),
            'latestAt',(SELECT max(observed_at) FROM uptime_observations)) FROM uptime_control WHERE id=1),
          'uptimeSplit', ${uptimeSplitReadbackSql(sql`c.at`)},
          'backlog', jsonb_build_object(
            'fetchReady',(SELECT count(*) FROM crawl_frontier WHERE state='pending' AND next_attempt_at<=c.at::timestamp),
            'fetchBackoff',(SELECT count(*) FROM crawl_frontier WHERE state='pending' AND next_attempt_at>c.at::timestamp),
            'human',(SELECT count(*) FROM crawl_candidates WHERE state='needs_review'),
            'jobRequests',(SELECT count(*) FROM jobs WHERE requested_version>processed_version)),
          'owners', coalesce((SELECT jsonb_agg(jsonb_build_object('role',role,'instanceId',owner_instance_id,'release',owner_release,
            'epoch',epoch,'live',owner_instance_id IS NOT NULL AND lease_until>c.at::timestamp) ORDER BY role) FROM role_leases),'[]'::jsonb),
          'hostSlots', jsonb_build_object('atMs',(extract(epoch FROM c.at)*1000)::float8,
            'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'value',value) ORDER BY key) FROM operations_observations WHERE key LIKE 'host-slot:%'),'[]'::jsonb)),
          'modelBudgets', coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.budget) FROM (SELECT r.provider_budget_id AS budget,
              count(*) FILTER (WHERE r.state='waiting') AS waiting, count(*) FILTER (WHERE r.state='reserved') AS reserved,
              count(*) FILTER (WHERE r.state='reserved' AND r.reserved_until<=c.at) AS "expiredReserved",
              count(*) FILTER (WHERE r.state='dispatched') AS dispatched, count(*) FILTER (WHERE r.state='indeterminate') AS indeterminate,
              min(r.queued_at) FILTER (WHERE r.state='waiting') AS "oldestWaitingAt",
              min(coalesce(r.dispatched_at,(SELECT min(e.created_at) FROM model_capacity_events e WHERE e.request_id=r.request_id AND e.kind='dispatch_started')))
                FILTER (WHERE r.state IN ('dispatched','indeterminate')) AS "oldestUnsettledAt",
              count(*) FILTER (WHERE r.state IN ('dispatched','indeterminate') AND r.dispatched_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id=r.request_id AND e.kind='dispatch_started')) AS untimed
            FROM model_capacity_requests r WHERE r.state IN ('waiting','reserved','dispatched','indeterminate') GROUP BY r.provider_budget_id) b),'[]'::jsonb),
          'dr', (SELECT jsonb_build_object('state',f.state,'epoch',f.writer_epoch,'reason',f.reason,'updatedAt',f.updated_at,
            'promoted',(SELECT count(*) FROM dr_promotions WHERE state='promoted'),
            'sealed',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.promotion_id,'fromEpoch',p.from_epoch,'toEpoch',p.to_epoch,'sealedAt',p.sealed_at,
              'evidence',(SELECT coalesce(jsonb_agg(DISTINCT e.kind ORDER BY e.kind),'[]'::jsonb) FROM dr_promotion_evidence e WHERE e.promotion_id=p.promotion_id))
              ORDER BY p.sealed_at) FROM dr_promotions p WHERE p.state='sealed'),'[]'::jsonb)) FROM dr_writer_fence f WHERE f.id=1),
          'oracleCandidates', coalesce((SELECT jsonb_agg(jsonb_build_object('role',role,'instanceId',instance_id,'release',release,'capability',capability)
            ORDER BY role,instance_id) FROM job_batch_candidates WHERE host='oracle-osaka-smoke'),'[]'::jsonb)
        ) AS snapshot FROM observation_clock c`);
      return row?.snapshot;
    }, { accessMode: 'read only' })),
    readJobBatchReadiness(),
  ]);
  if (snapshot.status === 'rejected') logger.warn('operations.control_status_read_failed', { part: 'snapshot', error: snapshot.reason });
  if (readiness.status === 'rejected') logger.warn('operations.control_status_read_failed', { part: 'readiness', error: readiness.reason });
  return buildPipelineControlStatus(snapshot.status === 'fulfilled' ? snapshot.value : null,
    readiness.status === 'fulfilled' ? readiness.value : null);
}
