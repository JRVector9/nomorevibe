import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import type * as schema from "@/lib/db/schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { batchRoleForJob } from "@/lib/jobs/batches";
import { modelRequestIntervals, OBSERVATION_MAX_WINDOW_MS, OBSERVATION_MIN_WINDOW_MS, OBSERVATION_OPTIONAL_TABLES, OBSERVATION_ROW_LIMIT,
  parsePipelineObservation, pipelineSnapshotSchema, type ModelEvent, type PipelineObservation, type PipelineSnapshot } from "./pipeline-observation";

type Database = PostgresJsDatabase<typeof schema>;
export type Row = Record<string, unknown>;
export type Query = (statement: SQL) => Promise<Row[]>;
type Absent = ReadonlySet<string>;
export type ObservationTarget = "primary" | "replica";
export type ObservationOptions = { runId: string; revision: string; endedAt: string; hours: number; target: ObservationTarget; baseline: PipelineSnapshot | null };

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const canonicalDate = (value: string) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export const iso = (column: SQL) => sql`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * 읽기 전용 REPEATABLE READ 한 트랜잭션. 쓰기 문장은 없고, 끝에서 트랜잭션 번호가 배정되지 않았음을 다시 확인한다.
 * 운영 시각 열 일부는 시간대 없는 UTC 벽시계다 — 모든 경과는 SQL에서 잰다.
 */
export async function readOnly<T>(database: Database, target: ObservationTarget, load: (query: Query, session: Row) => Promise<T>, endedAt?: string): Promise<T> {
  return database.transaction(async tx => {
    const query: Query = async statement => [...await tx.execute(statement)] as Row[];
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`set local statement_timeout = '120s'`);
    const end = endedAt ?? null;
    // collected_at은 DB clock을 ms에서 자른 UTC 문자열이다. 구간 끝과의 차이는 이 두 UTC 문자열로 정확히 셀 수 있다.
    const [session] = await query(sql`select ${iso(sql`now()`)} as collected_at, pg_is_in_recovery() as in_recovery,
      current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation,
      current_database() as name, (select oid::text from pg_database where datname = current_database()) as oid,
      case when pg_is_in_recovery() and ${end}::timestamptz is not null
        then coalesce(pg_last_xact_replay_timestamp() >= ${end}::timestamptz, false) end as replica_caught_up`);
    ensure(session.read_only === "on" && session.isolation === "repeatable read", "report_transaction_not_read_only");
    ensure(session.in_recovery === (target === "replica"), "report_target_mismatch");
    const result = await load(query, session);
    const [xid] = await query(sql`select txid_current_if_assigned() is not null as assigned`);
    ensure(xid.assigned === false, "report_write_detected");
    return result;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function absentTables(query: Query): Promise<Set<string>> {
  const [row] = await query(sql.raw(`select ${OBSERVATION_OPTIONAL_TABLES.map(name =>
    `coalesce(has_table_privilege(to_regclass('public.${name}'), 'SELECT'), false) as ${name}`).join(", ")}`));
  return new Set(OBSERVATION_OPTIONAL_TABLES.filter(name => row[name] !== true));
}

/** 수집 시점의 카운터(역할 epoch·잡 실행 수·제어 epoch). 이력 표가 없어 두 시점의 차이로만 인계를 증명한다. */
async function readState(query: Query, absent: Absent) {
  const roles = await query(sql`select role, epoch::float8 as epoch, owner_instance_id, owner_boot_id from role_leases order by role`);
  const jobs = await query(sql`select name, runs, processed_version::float8 as processed_version from jobs order by name`);
  const stageModes = absent.has("pipeline_stage_modes") ? null
    : await query(sql`select stage, mode, epoch::float8 as epoch from pipeline_stage_modes order by stage`);
  const [model] = absent.has("model_capacity_control") ? [] : await query(sql`select mode, epoch::float8 as epoch, revision::float8 as revision
    from model_capacity_control where id = 1`);
  const [batch] = absent.has("job_batch_control") ? [] : await query(sql`select mode, epoch::float8 as epoch from job_batch_control where id = 1`);
  const [fence] = absent.has("dr_writer_fence") ? [] : await query(sql`select state, writer_epoch::float8 as writer_epoch from dr_writer_fence where id = 1`);
  return {
    roles: roles.map(row => ({ role: String(row.role), epoch: Number(row.epoch), ownerInstanceId: (row.owner_instance_id as string | null) ?? null,
      ownerBootId: (row.owner_boot_id as string | null) ?? null })),
    jobs: jobs.map(row => ({ name: String(row.name), runs: Number(row.runs), processedVersion: Number(row.processed_version) })),
    controls: {
      stageModes: stageModes?.map(row => ({ stage: String(row.stage), mode: String(row.mode), epoch: Number(row.epoch) })) ?? null,
      modelCapacity: model ? { mode: String(model.mode), epoch: Number(model.epoch), revision: Number(model.revision) } : null,
      jobBatch: batch ? { mode: String(batch.mode), epoch: Number(batch.epoch) } : null,
      writerFence: fence ? { state: String(fence.state), writerEpoch: Number(fence.writer_epoch) } : null,
    },
  };
}
const databaseOf = (session: Row, target: ObservationTarget) => ({ name: String(session.name), oid: String(session.oid), target,
  inRecovery: session.in_recovery === true, readOnly: true as const, isolation: "repeatable read" as const, writeXidAssigned: false as const });

/** 구간 시작 전에 남기는 기준 스냅숏(읽기 전용). */
export async function collectPipelineSnapshot(database: Database, target: ObservationTarget): Promise<PipelineSnapshot> {
  return readOnly(database, target, async (query, session) => pipelineSnapshotSchema.parse({ version: 1, scope: "pipeline_snapshot",
    capturedAt: session.collected_at, database: databaseOf(session, target), ...await readState(query, await absentTables(query)) }));
}

const ackSchema = z.object({ batchResult: z.object({ role: z.string().min(1).max(60), job: z.string().min(1).max(60),
  instanceId: z.string().min(1).max(120), host: z.string().min(1).max(60), recordedAt: z.iso.datetime({ offset: true }) }).passthrough() }).passthrough();
/** 역할별 도메인 실처리(구간 안에 마지막 쓰기가 있는 행, 하한). oracle-canary의 domain readback과 같은 표·시각 열이다. */
const READBACK: { role: string; stage: string; table: string; at: string; tz: boolean; where?: string }[] = [
  { role: "crawler", stage: "crawl-fetch", table: "crawl_documents", at: "fetched_at", tz: false },
  { role: "reviewer", stage: "crawl-agent-review", table: "crawl_review_attempts", at: "completed_at", tz: false, where: "kind = 'automatic'" },
  { role: "reviewer", stage: "second-review", table: "second_reviews", at: "reviewed_at", tz: false },
  { role: "publisher", stage: "crawl-publish", table: "products", at: "created_at", tz: false, where: "source = 'crawler'" },
  { role: "translation", stage: "reason-translate", table: "text_translations", at: "updated_at", tz: false },
  { role: "translation", stage: "product-translate", table: "product_translations", at: "updated_at", tz: false },
  { role: "translation", stage: "product-tagline-ko", table: "product_korean_taglines", at: "updated_at", tz: false },
  { role: "product-health", stage: "uptime-ping", table: "uptime_observations", at: "received_at", tz: true },
  { role: "official-news", stage: "news-refresh", table: "news_items", at: "created_at", tz: false },
  { role: "site-evidence", stage: "product-site-evidence-refresh", table: "evidence_source_claims", at: "updated_at", tz: true,
    where: "last_outcome in ('ok', 'failed')" },
];

/**
 * 지정 구간(start, end] 운영 관측. end는 명시해야 하고 이미 지난 시각이어야 한다. 수집 대상 URL 하나만 쓴다.
 * 역할 인계·epoch는 baseline 스냅숏(구간 시작 전)과 수집 시점의 차이로만 증명한다 — 이력 표가 없어서다.
 */
export async function collectPipelineObservation(database: Database, options: ObservationOptions): Promise<PipelineObservation> {
  const { endedAt, hours, target } = options;
  const durationMs = Math.round(hours * 3_600_000);
  ensure(canonicalDate(endedAt) && Number.isFinite(hours) && durationMs >= OBSERVATION_MIN_WINDOW_MS && durationMs <= OBSERVATION_MAX_WINDOW_MS
    && ["primary", "replica"].includes(target), "observation_window_invalid");
  const startedAt = new Date(Date.parse(endedAt) - durationMs).toISOString();
  return readOnly(database, target, async (query, session) => {
    const collectedAfterEndMs = Date.parse(String(session.collected_at)) - Date.parse(endedAt);
    ensure(collectedAfterEndMs >= 0, "observation_window_not_finished");
    const absent = await absentTables(query);
    const start = sql`(${startedAt}::timestamptz at time zone 'utc')`, end = sql`(${endedAt}::timestamptz at time zone 'utc')`;
    const startTz = sql`${startedAt}::timestamptz`, endTz = sql`${endedAt}::timestamptz`;
    const naiveOffset = (value: SQL) => sql`ceil(extract(epoch from (${value} - ${start})) * 1000)::float8`;
    const tzOffset = (value: SQL) => sql`round(extract(epoch from (${value} - ${startTz})) * 1000)::float8`;
    const nullable = (value: unknown) => value === null || value === undefined ? null : Number(value);
    const [migrations] = await query(sql`select case when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations' and has_table_privilege(c.oid, 'SELECT')) then true else false end as readable`);
    const [applied] = migrations.readable ? await query(sql`select count(*)::int as count from drizzle.__drizzle_migrations`) : [];

    const jobRows = await query(sql`select name, ${naiveOffset(sql`last_run_at`)} as last_run_ms, ${naiveOffset(sql`last_success_at`)} as last_success_ms,
      last_error is not null as failing from jobs order by name`);
    const catalog = new Map(JOB_CATALOG.map(job => [job.name, job.role as string]));
    const jobs = jobRows.map(row => ({ name: String(row.name), role: batchRoleForJob(String(row.name)) ?? catalog.get(String(row.name)) ?? "unknown",
      lastRunMs: nullable(row.last_run_ms), lastSuccessMs: nullable(row.last_success_ms), failingAtCollection: row.failing === true }));

    const ackRows = await query(sql`select value from operations_observations where key like 'batch-result:%' order by key limit 4097`);
    ensure(ackRows.length <= 4096, "observation_row_limit");
    const acks = { rows: [] as PipelineObservation["acks"]["rows"], invalid: 0 };
    for (const row of ackRows) {
      const parsed = ackSchema.safeParse(row.value);
      if (!parsed.success) { acks.invalid++; continue; }
      const { role, job, instanceId, host, recordedAt } = parsed.data.batchResult;
      acks.rows.push({ role, job, instanceId, host, recordedMs: Date.parse(recordedAt) - Date.parse(startedAt) });
    }

    const readback = [];
    for (const item of READBACK) {
      const table = item.table as (typeof OBSERVATION_OPTIONAL_TABLES)[number];
      if (absent.has(table)) { readback.push({ role: item.role, stage: item.stage, rows: null }); continue; }
      const [lower, upper] = item.tz ? [startTz, endTz] : [start, end];
      const [count] = await query(sql`select count(*)::int as count from ${sql.identifier(item.table)}
        where ${sql.identifier(item.at)} > ${lower} and ${sql.identifier(item.at)} <= ${upper}${item.where ? sql.raw(` and ${item.where}`) : sql``}`);
      readback.push({ role: item.role, stage: item.stage, rows: Number(count.count) });
    }

    // pipeline-capacity-live의 AI1 호출 정의: 자동 시도, 규칙·재사용 제외, cancelled|deferred 실패는 취소, 나머지 실패는 기술 실패.
    const [ai1] = await query(sql`select
        count(*) filter (where state = 'succeeded' or coalesce(error_code, '') not in ('cancelled', 'deferred'))::int as calls,
        count(*) filter (where state = 'failed' and coalesce(error_code, '') not in ('cancelled', 'deferred'))::int as technical,
        count(*) filter (where state = 'failed' and error_code in ('cancelled', 'deferred'))::int as cancelled
      from crawl_review_attempts where kind = 'automatic' and provider is distinct from 'rules' and reused_from_attempt_id is null
        and state in ('succeeded', 'failed') and completed_at > ${start} and completed_at <= ${end}`);

    // 0097 증거 장부: 기록 시작 marker가 구간 시작 이전일 때만 센다(pipeline-capacity-live 수집기와 같은 규칙).
    let ledger: PipelineObservation["ledger"] = { status: "absent", startedAt: null, counts: null };
    if (!absent.has("pipeline_evidence_events")) {
      const [marker] = await query(sql`select ${iso(sql`created_at`)} as started_at, created_at <= ${startTz} as covers
        from pipeline_evidence_events where kind = 'recorder_started'`);
      ledger = !marker ? { status: "marker_missing", startedAt: null, counts: null }
        : !marker.covers ? { status: "marker_after_start", startedAt: String(marker.started_at), counts: null }
        : { status: "covered", startedAt: String(marker.started_at), counts: null };
      if (marker?.covers) {
        const [counts] = await query(sql`select
            count(*) filter (where kind = 'human_decision_overridden')::int as overrides,
            count(*) filter (where kind = 'lease_violation')::int as lease_violations,
            count(*) filter (where kind = 'human_decision_refused')::int as human_refusals,
            count(*) filter (where kind = 'late_write_refused')::int as late_refusals,
            count(*) filter (where kind = 'ai2_attempt')::int as ai2_calls,
            count(*) filter (where kind = 'ai2_attempt' and failed)::int as ai2_failed,
            count(distinct root_review_id) filter (where kind = 'ai2_attempt')::int as ai2_chains
          from pipeline_evidence_events where created_at > ${startTz} and created_at <= ${endTz}`);
        ledger = { ...ledger, counts: { humanDecisionOverrides: counts.overrides as number, leaseViolations: counts.lease_violations as number,
          humanDecisionRefusals: counts.human_refusals as number, lateWritesRefused: counts.late_refusals as number,
          ai2Calls: counts.ai2_calls as number, ai2Failed: counts.ai2_failed as number, ai2Chains: counts.ai2_chains as number } };
      }
    }
    if (absent.has("pipeline_evidence_events")) {
      // 표가 있으나 권한이 없는 경우와 배포 전을 구별한다.
      const [exists] = await query(sql`select to_regclass('public.pipeline_evidence_events') is not null as present`);
      if (exists.present) ledger = { status: "unreadable", startedAt: null, counts: null };
    }

    // products_repository_identity_idx 와 같은 정규화로 같은 저장소의 다른 제품을 찾는다(pipeline-capacity-live와 같은 문장).
    const [duplicates] = await query(sql`select count(*)::int as count from products p
      where p.source = 'crawler' and p.repo_url is not null and p.created_at > ${start} and p.created_at <= ${end}
        and exists (select 1 from products q where q.id <> p.id and q.repo_url is not null
          and regexp_replace(regexp_replace(lower(rtrim(q.repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')
            = regexp_replace(regexp_replace(lower(rtrim(p.repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', ''))`);

    const fenceEvents = absent.has("dr_fence_events") ? null : (await query(sql`select reason, from_epoch::float8 as from_epoch,
        to_epoch::float8 as to_epoch, ${tzOffset(sql`created_at`)} as at_ms from dr_fence_events
      where created_at > ${startTz} and created_at <= ${endTz} order by id limit 1000`))
      .map(row => ({ reason: String(row.reason), fromEpoch: Number(row.from_epoch), toEpoch: Number(row.to_epoch), atMs: Number(row.at_ms) }));

    let modelLedger: unknown = null;
    if (!["model_capacity_control", "model_capacity_requests", "model_capacity_events"].some(table => absent.has(table))) {
      const [control] = await query(sql`select mode, policy, policy_hash, updated_at > ${startTz} as changed from model_capacity_control where id = 1`);
      const events = await query(sql`select r.route_id, r.class, e.kind, count(*)::int as count from model_capacity_events e
        join model_capacity_requests r on r.request_id = e.request_id where e.created_at > ${startTz} and e.created_at <= ${endTz}
        group by 1, 2, 3 order by 1, 2, 3`);
      const open = await query(sql`select route_id, class, state, count(*)::int as count from model_capacity_requests
        where state in ('dispatched', 'indeterminate') group by 1, 2, 3 order by 1, 2, 3`);
      // 구간에 걸친 요청: 시작 뒤 이벤트가 있거나(끝난 시각이 시작 뒤) 아직 끝나지 않았고, 구간 끝 전에 생긴 요청.
      const timeline = await query(sql`with touched as (
          select distinct request_id from model_capacity_events where created_at > ${startTz}
          union select request_id from model_capacity_requests where state in ('waiting', 'reserved', 'dispatched', 'indeterminate'))
        select r.request_id::text as request_id, r.route_id, r.class, r.pool, r.provider_budget_id, r.group_id, r.policy_hash,
          ${tzOffset(sql`r.queue_until`)} as queue_until_ms, ${tzOffset(sql`r.reserved_until`)} as reserved_until_ms,
          e.to_state, ${tzOffset(sql`e.created_at`)} as at_ms
        from touched t join model_capacity_requests r on r.request_id = t.request_id
          join model_capacity_events e on e.request_id = r.request_id
        where r.queued_at <= ${endTz} and e.created_at <= ${endTz}
        order by r.request_id, e.id limit ${OBSERVATION_ROW_LIMIT + 1}`);
      ensure(timeline.length <= OBSERVATION_ROW_LIMIT, "observation_row_limit");
      const grouped = new Map<string, { row: Row; events: ModelEvent[] }>();
      for (const row of timeline) {
        const entry = grouped.get(String(row.request_id)) ?? { row, events: [] };
        entry.events.push({ toState: (row.to_state as ModelEvent["toState"]) ?? null, atMs: Number(row.at_ms) });
        grouped.set(String(row.request_id), entry);
      }
      // 모양 검사는 마지막 parsePipelineObservation이 한다.
      modelLedger = {
        control: control ? { mode: control.mode, changedSinceStart: control.changed === true, policyHash: control.policy_hash ?? null,
          policy: control.policy ?? null } : null,
        events: events.map(row => ({ routeId: row.route_id, class: row.class, kind: row.kind, count: Number(row.count) })),
        openAtCollection: open.map(row => ({ routeId: row.route_id, class: row.class, state: row.state, count: Number(row.count) })),
        requests: [...grouped.values()].map(({ row, events: list }) => ({ routeId: row.route_id, class: row.class, pool: row.pool,
          providerBudgetId: row.provider_budget_id, groupId: row.group_id, policyHash: row.policy_hash,
          ...modelRequestIntervals(list, { queueUntilMs: Number(row.queue_until_ms), reservedUntilMs: nullable(row.reserved_until_ms) }) })),
      };
    }

    const current = await readState(query, absent);
    return parsePipelineObservation({ version: 1, scope: "pipeline_observation", runId: options.runId, revision: options.revision,
      window: { startedAt, endedAt, durationMs, collectedAt: session.collected_at, collectedAfterEndMs },
      database: { ...databaseOf(session, target), replicaCaughtUp: (session.replica_caught_up as boolean | null) ?? null },
      schema: { appliedMigrations: applied ? Number(applied.count) : null, absentTables: OBSERVATION_OPTIONAL_TABLES.filter(name => absent.has(name)) },
      baseline: options.baseline, current, jobs, acks, readback,
      ai1: { calls: Number(ai1.calls), technicalFailures: Number(ai1.technical), cancelled: Number(ai1.cancelled) },
      ledger, duplicatePublications: Number(duplicates.count), fenceEvents, modelLedger });
  }, endedAt);
}
