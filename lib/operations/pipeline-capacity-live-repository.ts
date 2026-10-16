import { and, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { crawlCandidates } from "@/lib/db/schema";
import { reviewCandidatePredicate, secondGateRequired } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { comparisonReviewPolicyHash, fullReviewPolicyHash } from "./pipeline-capacity";
import { LIVE_MAX_WINDOW_MS, LIVE_MIN_WINDOW_MS, LIVE_OPTIONAL_TABLES, LIVE_ROW_LIMIT, parseLiveCapacityArtifact,
  type LiveCapacityArtifact } from "./pipeline-capacity-live";

type Database = PostgresJsDatabase<typeof schema>;
export type LiveCapacityOptions = { runId: string; revision: string; startedAt: string; endedAt: string; target: "primary" | "replica" };
type Row = Record<string, unknown>;

function canonicalDate(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

/**
 * 운영 구간 증거를 읽기 전용 REPEATABLE READ 한 트랜잭션에서 수집한다. 쓰기 쿼리는 없다.
 * 운영 시각 열은 시간대 없는 UTC 벽시계라 모든 경과를 SQL에서 구간 시작 기준 ms로 잰다(JS Date 해석 금지).
 */
export async function collectLiveCapacityWindow(database: Database, options: LiveCapacityOptions): Promise<LiveCapacityArtifact> {
  const { startedAt, endedAt, target } = options;
  ensure(canonicalDate(startedAt) && canonicalDate(endedAt) && ["primary", "replica"].includes(target)
    && Date.parse(endedAt) - Date.parse(startedAt) >= LIVE_MIN_WINDOW_MS
    && Date.parse(endedAt) - Date.parse(startedAt) <= LIVE_MAX_WINDOW_MS, "live_window_invalid");
  return database.transaction(async tx => {
    const query = async (statement: SQL) => [...await tx.execute(statement)] as Row[];
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`set local statement_timeout = '120s'`);
    const start = sql`(${startedAt}::timestamptz at time zone 'utc')`, end = sql`(${endedAt}::timestamptz at time zone 'utc')`;
    const startTz = sql`${startedAt}::timestamptz`;
    const offset = (value: SQL) => sql`ceil(extract(epoch from (${value} - ${start})) * 1000)::float8`;
    const [session] = await query(sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as collected_at,
      ceil(extract(epoch from ((now() at time zone 'utc') - ${end})) * 1000)::float8 as collected_after_end_ms,
      round(extract(epoch from (${end} - ${start})) * 1000)::float8 as duration_ms,
      pg_is_in_recovery() as in_recovery, current_setting('transaction_read_only') as read_only,
      current_setting('transaction_isolation') as isolation,
      case when pg_is_in_recovery() then coalesce(pg_last_xact_replay_timestamp() >= ${endedAt}::timestamptz, false) end as replica_caught_up`);
    ensure(session.read_only === "on" && session.isolation === "repeatable read", "live_transaction_not_read_only");
    ensure(session.in_recovery === (target === "replica"), "live_target_mismatch");
    ensure(Number(session.collected_after_end_ms) >= 0, "live_window_not_finished");

    // 0077·0078 이전 운영 스키마: 테이블이 없으면 그 기능은 배포 전이다(legacy·disabled·item lease 없음).
    const [tables] = await query(sql`select ${sql.raw(LIVE_OPTIONAL_TABLES.map(name => `to_regclass('public.${name}') is not null as ${name}`).join(", "))},
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'drizzle'
        and c.relname = '__drizzle_migrations' and has_schema_privilege(n.oid, 'USAGE') and has_table_privilege(c.oid, 'SELECT')) as migrations_readable`);
    const absentTables = LIVE_OPTIONAL_TABLES.filter(name => tables[name] !== true);
    const [migrations] = tables.migrations_readable
      ? await query(sql`select count(*)::int as applied from drizzle.__drizzle_migrations`) : [];
    const [stored] = await query(sql`select values, ${offset(sql`updated_at`)} as updated_ms from crawl_settings where id = 1`);
    const settings = mergeWithDefaults(stored?.values);
    ensure(settings.firstReview, "live_first_reviewer_unpinned");
    const model = (row: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) =>
      ({ provider: row.provider, model: row.model, canonicalModel: canonicalReviewModel(row.model) });

    // 구간 안에서 끝났거나, 구간 안의 AI2 표로 최종이 될 수 있는 자동 AI1 세대.
    const relevant = sql`a.kind = 'automatic' and a.completed_at <= ${end} and (a.completed_at > ${start} or exists (
      select 1 from second_reviews r where r.first_attempt_id = a.id and r.trigger = 'ai_approved'
        and r.reviewed_at > ${start} and r.reviewed_at <= ${end}))`;
    const limit = LIVE_ROW_LIMIT + 1;
    const attempts = await query(sql`select a.id, a.candidate_id, a.input_hash, a.state, a.provider, a.model, a.policy_hash,
        a.prompt_version, a.rules_version, a.reused_from_attempt_id, a.outcome->>'decision' as decision,
        case when a.state = 'failed' then case when a.error_code in ('cancelled', 'deferred') then 'cancelled' else 'technical' end end as failure,
        exists (select 1 from crawl_review_attempts p where p.candidate_id = a.candidate_id and p.kind = 'automatic'
          and p.state = 'succeeded' and p.id < a.id) as re_review,
        ${offset(sql`greatest((a.source->>'documentFetchedAt')::timestamptz at time zone 'utc',
          (a.source->>'scanCompletedAt')::timestamptz at time zone 'utc', (a.source->>'candidateJudgedAt')::timestamptz at time zone 'utc')`)} as ready_ms,
        ${offset(sql`a.started_at`)} as started_ms, ${offset(sql`a.completed_at`)} as completed_ms, a.input_tokens, a.output_tokens
      from crawl_review_attempts a where ${relevant} order by a.id limit ${limit}`);
    const votes = await query(sql`select g.id, g.first_attempt_id, g.status, coalesce(g.resolution = 'decided_elsewhere', false) as settled_elsewhere,
        g.fallback_for_id is not null as fallback, g.provider, g.model, coalesce(root.provider, g.provider) as slot_provider,
        coalesce(root.model, g.model) as slot_model,
        case when g.second_decision in ('approve', 'reject', 'needs_review') then g.second_decision end as second_decision,
        ${offset(sql`g.reviewed_at`)} as reviewed_ms
      from second_reviews g left join second_reviews root on root.id = g.fallback_for_id
      where g.trigger = 'ai_approved' and g.published_slug is null
        and g.first_attempt_id in (select a.id from crawl_review_attempts a where ${relevant})
      order by g.id limit ${limit}`);
    const applied = sql`c.signals->'agentReviewAttemptId'`;
    const candidates = await query(sql`select c.id, c.state, case when c.decided_by in ('auto', 'admin') then c.decided_by end as decided_by,
        case when jsonb_typeof(${applied}) = 'number' and (${applied})::text::numeric between 1 and 9007199254740991
          and (${applied})::text::numeric = trunc((${applied})::text::numeric) then (${applied})::text::float8 end as applied_attempt_id
      from crawl_candidates c where c.id in (select a.candidate_id from crawl_review_attempts a where ${relevant})
      order by c.id limit ${limit}`);
    ensure(attempts.length <= LIVE_ROW_LIMIT && votes.length <= LIVE_ROW_LIMIT && candidates.length <= LIVE_ROW_LIMIT, "live_row_limit");

    // AI2 행은 재시도마다 덮어쓰인다. fallback 사슬 전체가 구간 안에서 생기고 끝난 경우만 호출 수를 확정한다.
    const [ai2] = await query(sql`with chain as (
        select coalesce(g.fallback_for_id, g.id) as root_id,
          bool_and(g.created_at > ${start} and (g.reviewed_at is null or g.reviewed_at <= ${end})) as contained,
          max(g.failure_count) as failures, count(*) filter (where g.second_decision is not null) as successes
        from second_reviews g
        where coalesce(g.fallback_for_id, g.id) in (select coalesce(x.fallback_for_id, x.id) from second_reviews x
          where x.created_at > ${start} and x.created_at <= ${end})
        group by 1)
      select (count(*) filter (where contained))::int as chains,
        coalesce(sum(failures + successes) filter (where contained), 0)::int as calls,
        coalesce(sum(failures) filter (where contained), 0)::int as failed,
        (count(*) filter (where not contained))::int as unattributed_chains
      from chain`);

    // 구간 시작 전부터 지금까지 아무것도 바뀌지 않았고 지금도 준비된 후보는 구간 내내 준비 대기였다(고갈 아님의 증인).
    const noLeases = absentTables.includes("pipeline_item_leases") ? sql`with pipeline_item_leases (stage, work_key, token, lease_until, updated_at) as (
      select null::varchar, null::varchar, null::uuid, null::timestamptz, null::timestamptz where false) ` : sql``;
    const witnesses = await query(sql`${noLeases}select ${crawlCandidates.id} as id from ${crawlCandidates} where ${and(
      reviewCandidatePredicate(settings, { readyOnly: true }),
      sql`${crawlCandidates.updatedAt} <= ${start}`,
      sql`not exists (select 1 from crawl_documents d where d.repo = ${crawlCandidates.repo} and d.fetched_at > ${start})`,
      sql`not exists (select 1 from agent_repository_scans s where s.repository_key = lower(${crawlCandidates.repo})
        and (s.started_at > ${start} or s.completed_at > ${start}))`,
      sql`not exists (select 1 from crawl_review_attempts w where w.candidate_id = ${crawlCandidates.id}
        and (w.completed_at is null or w.started_at > ${start} - interval '24 hours' or w.completed_at > ${start} - interval '24 hours'
          or w.retry_after > ${start} or (w.state = 'succeeded' and w.valid_until > ${start})))`,
      sql`not exists (select 1 from pipeline_item_leases l where l.stage = 'ai1'
        and l.work_key = 'ai1:' || ${crawlCandidates.id}::text and l.updated_at > ${startTz})`,
    )} order by ${crawlCandidates.id} limit 1000`);

    const stageModes = absentTables.includes("pipeline_stage_modes")
      ? (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: "legacy", epoch: 1, changed: false }))
      : await query(sql`select stage, mode, epoch::float8 as epoch, updated_at > ${startTz} as changed from pipeline_stage_modes order by stage`);
    const [capacity] = absentTables.includes("model_capacity_control") ? [{ mode: "disabled", changed: false }]
      : await query(sql`select mode, updated_at > ${startTz} as changed from model_capacity_control where id = 1`);
    // products_repository_identity_idx 와 같은 정규화로 같은 저장소의 다른 제품을 찾는다.
    const [duplicates] = await query(sql`select count(*)::int as count from products p
      where p.source = 'crawler' and p.repo_url is not null and p.created_at > ${start} and p.created_at <= ${end}
        and exists (select 1 from products q where q.id <> p.id and q.repo_url is not null
          and regexp_replace(regexp_replace(lower(rtrim(q.repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')
            = regexp_replace(regexp_replace(lower(rtrim(p.repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', ''))`);
    const [xid] = await query(sql`select txid_current_if_assigned() is not null as assigned`);
    ensure(xid.assigned === false, "live_write_detected");

    const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
    return parseLiveCapacityArtifact({ version: 1, scope: "live_window", runId: options.runId, revision: options.revision,
      schema: { appliedMigrations: migrations?.applied ?? null, absentTables },
      window: { startedAt, endedAt, durationMs: Number(session.duration_ms), collectedAt: session.collected_at,
        collectedAfterEndMs: Number(session.collected_after_end_ms) },
      database: { target, inRecovery: session.in_recovery, readOnly: true, isolation: "repeatable read",
        replicaCaughtUp: session.replica_caught_up ?? null, writeXidAssigned: false },
      identity: { promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, inputPolicyHash: reviewPolicyHash(settings),
        comparisonPolicyHash: comparisonReviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings),
        reviewMode: settings.reviewMode, secondGateRequired: secondGateRequired(settings), concurrency: settings.reviewConcurrency,
        settingsUpdatedMs: nullableNumber(stored?.updated_ms),
        models: { first: model(settings.firstReview), second: settings.secondReview.voters.map(model),
          fallbacks: (settings.secondReview.fallbacks ?? []).map(model) } },
      stageModes: stageModes.map(row => ({ stage: row.stage, mode: row.mode, epoch: Number(row.epoch), changedSinceStart: row.changed })),
      modelCapacity: capacity ? { mode: capacity.mode, changedSinceStart: capacity.changed } : null,
      attempts: attempts.map(row => ({ id: row.id, candidateId: row.candidate_id, inputHash: row.input_hash, state: row.state,
        failure: row.failure ?? null, provider: row.provider, model: row.model, policyHash: row.policy_hash,
        promptVersion: row.prompt_version, rulesVersion: row.rules_version, reusedFromAttemptId: row.reused_from_attempt_id,
        decision: row.decision ?? null, reReview: row.re_review, readyMs: Number(row.ready_ms), startedMs: Number(row.started_ms),
        completedMs: nullableNumber(row.completed_ms), inputTokens: row.input_tokens, outputTokens: row.output_tokens })),
      votes: votes.map(row => ({ id: row.id, firstAttemptId: row.first_attempt_id, status: row.status,
        settledElsewhere: row.settled_elsewhere, fallback: row.fallback, provider: row.provider, model: row.model,
        slotProvider: row.slot_provider, slotModel: row.slot_model, secondDecision: row.second_decision ?? null,
        reviewedMs: nullableNumber(row.reviewed_ms) })),
      candidates: candidates.map(row => ({ id: row.id, state: row.state, decidedBy: row.decided_by ?? null,
        appliedAttemptId: nullableNumber(row.applied_attempt_id) })),
      ai2Calls: { chains: ai2.chains, calls: ai2.calls, failed: ai2.failed, unattributedChains: ai2.unattributed_chains },
      readiness: { witnesses: witnesses.length, sampleCandidateIds: witnesses.slice(0, 20).map(row => Number(row.id)) },
      safety: { duplicatePublications: duplicates.count, humanDecisionOverrides: "unverified", leaseViolations: "unverified" },
      budget: { status: "unverified" }, quality: null });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
