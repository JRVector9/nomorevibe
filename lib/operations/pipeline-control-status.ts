import { z } from 'zod';
import { batchPolicySchema, batchPolicyHash, BATCH_HOSTS, BATCH_ROLES } from '@/lib/jobs/batches';
import { modelCapacityPolicySchema, modelCapacityPolicyHash } from '@/lib/llm/capacity';
import { httpOriginPolicySchema, httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { UptimeSourcesSchema } from '@/lib/domain/products/uptime-policy';

export type ControlMetric = { label: string; value: number | null };
export type ControlReadback = { key: string; label: string; mode: string | null; epoch: number | null; revision: number | null;
  policy: 'verified' | 'unset' | 'unknown'; metrics: ControlMetric[]; note: string };
export type PipelineControlStatus = { observedAt: string | null; controls: ControlReadback[];
  stages: { stage: string; mode: string | null; epoch: number | null; contract: number | null; live: number | null; unsettled: number | null }[];
  backlog: ControlMetric[]; hosts: { host: string; roles: { role: string; ready: boolean; reason: string }[] }[];
  owners: { role: string; instanceId: string | null; host: string | null; release: string | null; epoch: number | null; live: boolean | null }[] };
const CONTROL_LABELS = { batch: '작업 배치', source: '사이트 근거', model: '공통 모델 슬롯', http: '공유 HTTP', uptime: '연결 관측' };
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
const readinessSchema = z.object({ mode: z.enum(['legacy', 'draining', 'versioned']), epoch: positive, policyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  candidates: z.array(z.object({ role: z.enum(BATCH_ROLES), host: z.enum(BATCH_HOSTS), instanceId: z.string(), release: z.string(),
    ready: z.boolean(), reason: z.string() })) });
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
    hosts: BATCH_HOSTS.map(host => ({ host, roles: BATCH_ROLES.map(role => ({ role, ready: false, reason: 'readback_unknown' })) })), owners: [] };
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
        metric('미정산', row.dispatched + row.indeterminate), metric('설정 상한', valid ? parsed.data.globalLimit : null)],
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
  const backlog = backlogSchema.safeParse(input.backlog);
  if (backlog.success) result.backlog.forEach((row, i) => { row.value = [backlog.data.fetchReady, backlog.data.fetchBackoff, backlog.data.human, backlog.data.jobRequests][i]; });
  const ready = readinessSchema.safeParse(readiness);
  if (ready.success && batch.success && ready.data.epoch === batch.data.epoch && ready.data.mode === batch.data.mode
    && ready.data.policyHash === batch.data.policyHash && batchPolicy) {
    for (const host of result.hosts) for (const role of host.roles) {
      const candidates = ready.data.candidates.filter(row => row.host === host.host && row.role === role.role);
      const matching = candidates.filter(row => row.release === batchPolicy!.release
        && batchPolicy!.instances.some(instance => instance.instanceId === row.instanceId && instance.host === row.host));
      const selected = matching.find(row => row.ready) ?? matching[0];
      if (selected) Object.assign(role, { ready: selected.ready, reason: selected.reason });
      else role.reason = candidates.length ? 'identity_mismatch' : 'candidate_missing';
    }
  }
  const owners = ownersSchema.safeParse(input.owners);
  if (owners.success) result.owners = owners.data.map(row => ({ ...row,
    host: batchPolicy?.instances.find(instance => instance.instanceId === row.instanceId)?.host ?? null }));
  return result;
}

/** One primary statement for control/ledger readback; no locks or runtime admission. */
export async function readPipelineControlStatus(): Promise<PipelineControlStatus> {
  const [{ db, onPrimary }, { sql }, { readJobBatchReadiness }] = await Promise.all([
    import('@/lib/db'), import('drizzle-orm'), import('./job-batch-readiness'),
  ]);
  const [snapshot, readiness] = await Promise.allSettled([
    onPrimary(async () => {
      const [row] = await db.execute<{ snapshot: unknown }>(sql`
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
          'backlog', jsonb_build_object(
            'fetchReady',(SELECT count(*) FROM crawl_frontier WHERE state='pending' AND next_attempt_at<=c.at::timestamp),
            'fetchBackoff',(SELECT count(*) FROM crawl_frontier WHERE state='pending' AND next_attempt_at>c.at::timestamp),
            'human',(SELECT count(*) FROM crawl_candidates WHERE state='needs_review'),
            'jobRequests',(SELECT count(*) FROM jobs WHERE requested_version>processed_version)),
          'owners', coalesce((SELECT jsonb_agg(jsonb_build_object('role',role,'instanceId',owner_instance_id,'release',owner_release,
            'epoch',epoch,'live',owner_instance_id IS NOT NULL AND lease_until>c.at::timestamp) ORDER BY role) FROM role_leases),'[]'::jsonb)
        ) AS snapshot FROM observation_clock c`);
      return row?.snapshot;
    }),
    readJobBatchReadiness(),
  ]);
  return buildPipelineControlStatus(snapshot.status === 'fulfilled' ? snapshot.value : null,
    readiness.status === 'fulfilled' ? readiness.value : null);
}
