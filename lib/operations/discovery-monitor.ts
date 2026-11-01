import { sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { KoreanCursorSchema, desiredKoreanQueries } from "@/lib/crawl/korean-discovery/contracts";
import { mergeWithDefaults, settingsUnreadable } from "@/lib/crawl/settings";
import { readReviewBacklogInTransaction, reviewBacklogAdmission } from "@/lib/crawl/review-backlog";
import { DISCOVERY_MAX_CHECKPOINTS, DISCOVERY_MAX_SUBJECTS, DISCOVERY_SOURCES, discoveryHash, githubDiscoveryGeneration, githubDiscoverySemantic, githubDiscoverySharedWait, koreanCursorSemantic,
  koreanDiscoveryGeneration, koreanQueryGeneration, type DiscoveryFailures, type DiscoveryIntent, type DiscoverySource } from "@/lib/crawl/discovery-checkpoint-contract";
import { isConsumerServiceInstance, serviceInstancesFromObservations } from "./instance";
import type { ProductTransaction } from "@/lib/domain/products/generation";

export type DiscoveryReceipt = {
  source: DiscoverySource; subject: string; generation: string; semantic: string; reference: string | null;
  intent: DiscoveryIntent; resumeAt: string | null; firstSeenAt: string; progressAt: string | null;
  failureStartedAt: string | null; acknowledgedAt: string | null; recordedAt: string;
};
export type DiscoveryObligation = {
  source: DiscoverySource; subject: string; generation: string; semantic: string;
  /** These exceptions come from the current canonical controls/queue, never a receipt timestamp. */
  exempt?: boolean; unknown?: boolean; configuredAt: string; graceMs: number;
  workerPresent: boolean; consumer?: boolean; resumeAt?: string | null; dueAt?: string | null;
  /** Creation time of the oldest still-pending demand, never an attempt/retry timestamp. */
  demandAt?: string | null; empty?: boolean; completed?: boolean;
};
export type DiscoveryMonitorReport = { at: string; overall: "ok" | "alarm" | "unknown"; failures: DiscoveryFailures };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
const faultPriority = { no_progress: 0, upstream_stalled: 1, worker_missing: 2, consumer_missing: 3 };
const strongestFault = (prior: DiscoveryFailures["failures"][number]["reason"] | null, next: DiscoveryFailures["failures"][number]["reason"]) =>
  prior === null || faultPriority[next] > faultPriority[prior] ? next : prior;

/** One busy query never certifies another. Unknown subjects cannot clear their source. */
export function buildDiscoveryMonitor(at: string, obligations: DiscoveryObligation[], receipts: DiscoveryReceipt[]): DiscoveryMonitorReport {
  const now = time(at), covered: DiscoverySource[] = [], failures: DiscoveryFailures["failures"] = [];
  for (const source of DISCOVERY_SOURCES) {
    const subjects = obligations.filter(row => row.source === source);
    let unknown = !subjects.length || !Number.isFinite(now);
    let reason: DiscoveryFailures["failures"][number]["reason"] | null = null;
    for (const row of subjects) {
      if (row.unknown) { unknown = true; continue; }
      if (row.exempt) continue;
      const configured = time(row.configuredAt);
      if (!Number.isFinite(configured) || configured > now) { unknown = true; continue; }
      const receipt = receipts.find(r => r.source === source && r.subject === row.subject);
      // Mixed deployments and failed receipt writes are unknown, never observed healthy.
      if (!receipt || receipt.generation !== row.generation || receipt.semantic !== row.semantic) { unknown = true; continue; }
      const first = time(receipt.firstSeenAt), progress = receipt.progressAt === null ? first : time(receipt.progressAt);
      const recorded = time(receipt.recordedAt), ack = receipt.acknowledgedAt === null ? null : time(receipt.acknowledgedAt);
      if (![first, progress, recorded].every(v => Number.isFinite(v) && v >= 0 && v <= now)
        || progress < first || recorded < progress || ack !== null && (!Number.isFinite(ack) || ack < first || ack > recorded || ack > now)) { unknown = true; continue; }
      if (receipt.intent === "measurement_unknown") { unknown = true; continue; }
      const failed = receipt.intent === "upstream_error", failure = time(receipt.failureStartedAt), demand = time(row.demandAt);
      if (failed && (!Number.isFinite(failure) || failure < 0 || failure > recorded)
        || row.demandAt != null && (!Number.isFinite(demand) || demand < 0 || demand > now)) { unknown = true; continue; }
      const resume = time(row.resumeAt);
      if (Number.isFinite(resume) && resume > now && receipt.resumeAt && time(receipt.resumeAt) === resume
        && ["backoff", "caught_up"].includes(receipt.intent)) continue;
      if (!failed && row.empty && ack !== null && now - ack <= row.graceMs) continue;
      if (row.completed && ack !== null) continue;
      const grace = failed ? Math.max(row.graceMs, 30 * 60_000) : row.graceMs;
      const due = time(row.dueAt);
      // Generic configuration updated_at is not progress. Exact generations get durable first-seen grace.
      const baseline = failed ? Math.max(failure, Number.isFinite(demand) ? demand : 0)
        : Math.max(progress, Number.isFinite(demand) ? demand : 0, Number.isFinite(due) && due <= now ? due : 0,
          Number.isFinite(resume) && resume <= now && ["backoff", "caught_up"].includes(receipt.intent) ? resume : 0);
      if (!row.workerPresent && now - baseline >= grace) {
        reason = strongestFault(reason, row.consumer ? "consumer_missing" : "worker_missing"); continue;
      }
      if (now - baseline >= grace)
        reason = strongestFault(reason, receipt.intent === "upstream_error" ? "upstream_stalled" : "no_progress");
    }
    // A proved fault is reportable even if another subject is unconfirmed. A clear needs all subjects.
    if (reason || !unknown) covered.push(source);
    if (reason) failures.push({ source, reason });
  }
  covered.sort(); failures.sort((a, b) => a.source.localeCompare(b.source));
  return { at, overall: failures.length ? "alarm" : covered.length === DISCOVERY_SOURCES.length ? "ok" : "unknown",
    failures: { v: 1, covered, failures } };
}

type Job = { name: string; cursor: unknown; notBefore: string | null };
type Control = { enabled: boolean; epoch: number; shared_cursor: unknown; configuredAt: string; start_at: unknown; queries: unknown };
type Query = { label: string; query: string; enabled: boolean; transferred: boolean; cursor: unknown; dueAt: string; last_error: string | null };
type Staging = { repo: string; language: string; state: string; checkedAt: string | null; updatedAt: string };
const isoSql = (column: SQL) => sql`to_char(${column},'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const GRACE_MS = 5 * 60_000;
const MAX_SUBJECTS = DISCOVERY_MAX_SUBJECTS;

/** Transaction-bound queries do not inherit the pool wait deadline. Shrink SQL timeouts before every read. */
export function discoveryReadWithDeadline(tx: ProductTransaction, deadlineAt: number) {
  const remaining = () => {
    const ms = Math.floor(deadlineAt - Date.now() - 50);
    if (ms < 1) throw new Error("discovery_monitor_deadline");
    return ms;
  };
  return async <T extends Record<string, unknown>>(query: SQL) => {
    const ms = remaining();
    await tx.execute(sql`SELECT set_config(name,least(CASE WHEN setting::bigint=0 THEN ${ms} ELSE setting::bigint END,
      CASE WHEN name='lock_timeout' THEN least(${ms},1000) ELSE ${ms} END)::text||'ms',true)
      FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout')`);
    remaining();
    const rows = await tx.execute<T>(query);
    remaining();
    return rows;
  };
}

/** Primary only, one repeatable-read snapshot; bounded subjects, queues, receipts and three-second SQL budget.
 * No network calls, observer writes or lease renewals. Canonical admission includes the existing backlog aggregate. */
export async function readDiscoveryMonitor(): Promise<DiscoveryMonitorReport> {
  const deadlineAt = Date.now() + 3_000;
  return onPrimary(() => withDbDeadline(deadlineAt, () => db.transaction(async tx => {
    const execute = discoveryReadWithDeadline(tx, deadlineAt);
    const [clock] = await execute<{ at: string }>(sql`SELECT ${isoSql(sql`clock_timestamp() AT TIME ZONE 'UTC'`)} AS at`);
    const [setting] = await execute<{ values: unknown; configuredAt: string }>(sql`SELECT values,${isoSql(sql`updated_at`)} AS "configuredAt" FROM crawl_settings WHERE id=1`);
    if (!setting) throw new Error("discovery_settings_missing");
    const settings = mergeWithDefaults(setting.values);
    if (settingsUnreadable(settings)) throw new Error("discovery_settings_invalid");
    const [batch] = await execute<{ mode: string }>(sql`SELECT mode FROM job_batch_control WHERE id=1`);
    const [control] = await execute<Control>(sql`SELECT enabled,epoch,shared_cursor,start_at,queries,${isoSql(sql`updated_at`)} AS "configuredAt" FROM github_ko_discovery_control WHERE id=1`);
    if (!batch || !["legacy", "versioned", "draining"].includes(batch.mode) || !control) throw new Error("discovery_control_missing");
    const jobs = await execute<Job>(sql`SELECT name,cursor,${isoSql(sql`not_before`)} AS "notBefore" FROM jobs WHERE name IN ('crawl-seed','hn-show-seed','crawl-ko-apply')`);
    const queries = await execute<Query>(sql`SELECT label,query,enabled,transferred,cursor,${isoSql(sql`due_at`)} AS "dueAt",last_error FROM github_ko_discovery_queries WHERE enabled LIMIT 129`);
    const receipts = await execute<DiscoveryReceipt>(sql`SELECT source,subject,generation,semantic,reference,intent,
      ${isoSql(sql`resume_at`)} AS "resumeAt",${isoSql(sql`first_seen_at`)} AS "firstSeenAt",${isoSql(sql`progress_at`)} AS "progressAt",
      ${isoSql(sql`failure_started_at`)} AS "failureStartedAt",${isoSql(sql`acknowledged_at`)} AS "acknowledgedAt",${isoSql(sql`recorded_at`)} AS "recordedAt"
      FROM discovery_checkpoints ORDER BY recorded_at DESC LIMIT ${DISCOVERY_MAX_CHECKPOINTS + 1}`);
    if (receipts.length > DISCOVERY_MAX_CHECKPOINTS || queries.length > MAX_SUBJECTS) throw new Error("discovery_monitor_bound");
    const observations = await execute<{ key: string; value: Record<string, unknown>; observedAt: string }>(sql`SELECT key,value,${isoSql(sql`observed_at`)} AS "observedAt"
      FROM operations_observations WHERE (key LIKE 'service:crawler:%' OR key='crawler')
        AND observed_at>=clock_timestamp()-interval '90 seconds' ORDER BY observed_at DESC LIMIT 129`);
    if (observations.length > MAX_SUBJECTS) throw new Error("discovery_service_bound");
    const now = time(clock.at);
    const live = serviceInstancesFromObservations([...observations]).filter(row => {
      const age = now - time(row.observedAt), heartbeat = row.value.lastHeartbeatAt;
      return age >= 0 && age <= 90_000 && ["running", "starting"].includes(String(row.value.status)) && row.value.enabled !== false
        && typeof heartbeat === "number" && heartbeat <= now && now - heartbeat <= 90_000;
    });
    const workerPresent = live.some(row => !isConsumerServiceInstance(row.instanceId));
    const consumerPresent = live.some(row => row.instanceId.startsWith("github-ko-discovery-consumer-"));
    const obligations: DiscoveryObligation[] = [];
    const job = (name: string) => jobs.find(row => row.name === name);
    const paused = (name: string) => batch.mode === "draining" || time(job(name)?.notBefore) > now;
    const seed = object(job("crawl-seed")?.cursor) ? job("crawl-seed")!.cursor as Record<string, unknown> : {};
    const latest = object(seed.latestScan) ? seed.latestScan : null;
    const owned = settings.discover.queries.filter(q => q.enabled && !(control.enabled && queries.some(k => k.transferred && k.label === q.label && k.query === q.query)));
    if (owned.length > MAX_SUBJECTS) throw new Error("discovery_query_bound");
    const hasUnfinishedLatest = latest && (latest.waiting !== true || latest.coverageVersion !== 2 || latest.pendingPage
      || Array.isArray(latest.pendingWindows) && latest.pendingWindows.length || Array.isArray(latest.incompleteWindows) && latest.incompleteWindows.length);
    const cycle = object(seed.cycleWindow) ? seed.cycleWindow : {};
    const latestExpected = !!hasUnfinishedLatest || settings.discover.sort === "recent" && Number.isFinite(time(cycle.to)) && time(cycle.to) < now - 86_400_000;
    const sharedWait = latestExpected && (githubDiscoverySharedWait(seed, now) || githubDiscoverySharedWait(latest, now));
    const [queue] = await execute<{ pending: number; languagePending: boolean; oldestLanguage: string | null; nextLanguage: string | null; applyPending: boolean; nextApply: string | null; sharedAvailable: boolean; nextShared: string | null }>(sql`
      WITH pending AS MATERIALIZED (SELECT language,discovered_at,due_at,checked_at FROM github_ko_discovery_staging WHERE state='pending' LIMIT 10001)
      SELECT (SELECT count(*)::integer FROM pending) AS pending,
        EXISTS(SELECT 1 FROM pending WHERE language='unknown') AS "languagePending",
        (SELECT ${isoSql(sql`min(discovered_at)`)} FROM pending WHERE language='unknown') AS "oldestLanguage",
        (SELECT ${isoSql(sql`min(due_at)`)} FROM pending WHERE language='unknown') AS "nextLanguage",
        EXISTS(SELECT 1 FROM pending WHERE language IN ('yes','no')) AS "applyPending",
        (SELECT ${isoSql(sql`min(checked_at)`)} FROM pending WHERE language IN ('yes','no')) AS "nextApply",
        EXISTS(SELECT 1 FROM github_discovery_pages WHERE state='complete' AND kind='repositories' AND scope='public-v1'
          AND (completed_at,key)>(${object(control.shared_cursor) && typeof control.shared_cursor.at === "string" ? control.shared_cursor.at : "1970-01-01"}::timestamp,
            ${object(control.shared_cursor) && typeof control.shared_cursor.key === "string" ? control.shared_cursor.key : ""})) AS "sharedAvailable",
        (SELECT ${isoSql(sql`completed_at`)} FROM github_discovery_pages WHERE state='complete' AND kind='repositories' AND scope='public-v1'
          AND (completed_at,key)>(${object(control.shared_cursor) && typeof control.shared_cursor.at === "string" ? control.shared_cursor.at : "1970-01-01"}::timestamp,
            ${object(control.shared_cursor) && typeof control.shared_cursor.key === "string" ? control.shared_cursor.key : ""}) ORDER BY completed_at,key LIMIT 1) AS "nextShared"`);
    let capped = false;
    const homeReady = owned.length > 0 && !paused("crawl-seed") && !sharedWait && (!(time(seed.retryAt) > now)
      || latestExpected && !(time(latest?.retryAt) > now));
    const applyReady = control.enabled && queue.applyPending && !paused("crawl-ko-apply");
    if (settings.enabled && (homeReady || applyReady)) {
      const backlog = await readReviewBacklogInTransaction(tx, clock.at, deadlineAt);
      capped = reviewBacklogAdmission(backlog, settings.discover.maxNewPerHour, settings.discover.maxReviewBacklog).remainingNew === 0;
    }
    for (const source of ["github-full", "github-latest"] as const) {
      const cursor = source === "github-full" ? seed : latest;
      for (const q of owned.length ? owned : [{ label: "none", kind: "repositories", query: "" }]) {
        const state = object(cursor) ? cursor : {};
        obligations.push({ source, subject: discoveryHash(q.label), generation: githubDiscoveryGeneration(q, settings.discover),
          semantic: githubDiscoverySemantic(cursor, q.label), configuredAt: setting.configuredAt,
          graceMs: Math.max(GRACE_MS, Math.ceil(owned.length * 3 / settings.discover.pagesPerTick) * 60_000), workerPresent,
          exempt: !settings.enabled || !owned.length || paused("crawl-seed") || source === "github-latest" && !latestExpected || capped === true || sharedWait,
          resumeAt: typeof state.retryAt === "string" ? state.retryAt : null, dueAt: job("crawl-seed")?.notBefore,
          completed: state.waiting !== true && Array.isArray(state.doneSignals) && state.doneSignals.includes(q.label) });
      }
    }
    const hn = job("hn-show-seed");
    obligations.push({ source: "show-hn", subject: discoveryHash("show-hn"), generation: discoveryHash("show-hn-v1"), semantic: discoveryHash(hn?.cursor),
      configuredAt: setting.configuredAt, graceMs: 90 * 60_000, workerPresent,
      exempt: !settings.enabled || !settings.discover.showHn.enabled || paused("hn-show-seed"), empty: true, dueAt: hn?.notBefore });
    const koEnabled = settings.enabled && control.enabled;
    const desired = desiredKoreanQueries(settings, control.queries);
    if (desired.length > MAX_SUBJECTS) throw new Error("discovery_query_bound");
    const staleTransfers = queries.some(q => !desired.some(expected => expected.label === q.label && expected.query === q.query));
    for (const expected of desired.length ? desired : [{ label: "none", query: "" }]) {
      const q = queries.find(row => row.label === expected.label && row.query === expected.query);
      obligations.push({ source: "korean-query", subject: discoveryHash(expected.label), generation: koreanQueryGeneration(control.epoch, expected.query, settings.discover.windowDays),
        semantic: koreanCursorSemantic(q?.cursor), configuredAt: control.configuredAt, graceMs: GRACE_MS, workerPresent: consumerPresent, consumer: true,
        exempt: !koEnabled || !desired.length, unknown: koEnabled && (staleTransfers || !control.start_at || desired.length > 0
          && (!q?.enabled || !q.transferred || !KoreanCursorSchema.safeParse(q.cursor).success)), resumeAt: q?.dueAt });
    }
    const refs = receipts.filter(r => r.reference).map(r => r.reference!);
    const staging = refs.length ? await execute<Staging>(sql`SELECT repo,language,state,${isoSql(sql`checked_at`)} AS "checkedAt",${isoSql(sql`updated_at`)} AS "updatedAt"
      FROM github_ko_discovery_staging WHERE repo IN (${sql.join(refs.map(ref => sql`${ref}`), sql`,`)})`) : [];
    for (const source of ["korean-shared", "korean-language", "korean-apply"] as const) {
      const subject = discoveryHash(source === "korean-shared" ? "shared" : source === "korean-language" ? "language" : "apply");
      const receipt = receipts.find(r => r.source === source && r.subject === subject);
      const proof = staging.find(row => row.repo === receipt?.reference);
      const semantic = source === "korean-shared" ? discoveryHash(control.shared_cursor)
        : source === "korean-language" ? discoveryHash(proof && { repo: proof.repo, language: proof.language, at: proof.checkedAt })
        : discoveryHash(proof && { repo: proof.repo, state: proof.state, at: proof.updatedAt });
      const noWork = source === "korean-shared" ? !queue.sharedAvailable || queue.pending >= 9900
        : source === "korean-language" ? !queue.languagePending : !queue.applyPending;
      obligations.push({ source, subject, generation: koreanDiscoveryGeneration(control.epoch), semantic,
        configuredAt: control.configuredAt, graceMs: GRACE_MS, workerPresent: source === "korean-apply" ? workerPresent : consumerPresent,
        consumer: source !== "korean-apply", exempt: !koEnabled || noWork || source === "korean-apply" && (paused("crawl-ko-apply") || capped),
        dueAt: source === "korean-shared" ? queue.nextShared : source === "korean-language" ? queue.nextLanguage : queue.nextApply,
        demandAt: source === "korean-language" ? queue.oldestLanguage : null,
        unknown: koEnabled && queue.pending > 10000 });
    }
    return buildDiscoveryMonitor(clock.at, obligations, [...receipts]);
  }, { accessMode: "read only", isolationLevel: "repeatable read" })));
}
