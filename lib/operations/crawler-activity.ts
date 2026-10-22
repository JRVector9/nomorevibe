import type { JobRole, JobLane } from "@/lib/jobs/catalog";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { COLLECTOR_JOBS, COLLECTOR_NAMES, isAdditiveField, type JobTallySummary, type TallyWindow } from "@/lib/jobs/tally";
import { COLLECTOR_EVENTS } from "@/lib/jobs/collector-events";
import type { JobDeferralSummary } from "@/lib/jobs/deferral-observation";
import { isPausedJob } from "@/lib/jobs/status";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { isConsumerServiceInstance, parseServiceObservationKey } from "./instance";
import { parseAgentProviderFailure, parseRuntimeLanes } from "./worker-progress";
import { NEWS_SOURCE_KEYS } from "@/lib/news/sources";

export type CollectorJobInput = { name: string; lastRunAt: Date | null; lastSuccessAt: Date | null;
  nextScheduledAt: Date | null; notBefore: Date | null; lockedAt: Date | null; leaseToken: string | null;
  requestedVersion: number; processedVersion: number; lastError: string | null; runs: number; cursor?: unknown };
type Observation = { key: string; value: Record<string, unknown>; observedAt: Date | string };
type RoleOwner = { role: string; ownerInstanceId: string | null; secondsUntilExpiry: number | null };
type QueueMetrics = { measuredAt: string; stages: { key: string; waiting: number; deferred?: number }[] };
export type CollectorState = "disabled" | "paused" | "running" | "stale-lock" | "retrying" | "queued" | "error" | "never-run" | "idle";
export type CollectorEvent = { label: string; counts: Record<string, number | boolean>; /** 숫자 없는 이벤트(오류·대기)가 창 안에 나온 횟수 */ times?: number };
/** 회차 누적 한 창(job-tally:<job>) — ticks 는 성공 회차, failed 는 실패 회차, events 는 아래 EVENTS 로 거른 이벤트별 합 */
export type CollectorTotals = { ticks: number; failed: number;
  /** 끝났지만 제 일을 못 한 회차(@degraded — 검색 실패·키 없음 등). ticks 에도 들어 있다. 옛 관측은 0 */
  degraded?: number; events: CollectorEvent[] };
export type CollectorResult = { name: string; observedAt: string; durationMs: number | null; done: boolean | null;
  outcome: "item-errors" | "event-errors" | "provider-error" | "waiting" | "completed" | "unknown"; itemErrors: number | null;
  errorEvents: number; providerError: boolean; events: CollectorEvent[] };
export type CollectorRow = { name: string; role: JobRole; lane: JobLane; state: CollectorState;
  enabled: boolean; paused: boolean;
  intervalMs: number | null; lastRunAt: string | null; lastSuccessAt: string | null; nextScheduledAt: string | null;
  retryAt: string | null; runs: number | null; waiting: number | null; deferred: number | null;
  error: "timeout" | "rate-limited" | "authentication" | "job-error" | null; note: string | null; latest: CollectorResult | null;
  /** 최근 1시간·24시간 누적. 누적을 못 읽었으면(보류) null, 아직 쓴 적이 없으면 0 인 창 */
  totals: { hour: CollectorTotals; day: CollectorTotals } | null;
  /** 마지막 성공 회차보다 나중에 미룬 틱(defer:<job>) — 지난 성공 숫자가 그대로 남아 멈춘 것처럼 보이지 않게 */
  lastDeferred: { reason: string; at: string; lastHour: number } | null;
  /** 마지막 성공 회차보다 나중에 실패한 틱(job-tally:<job> lastFailedAt) */
  lastFailedAt: string | null;
  /** 최근 1시간 미룬 횟수(defer:<job>) — 미룸을 못 읽었으면 null */
  deferredHour: number | null };
/** kind consumer: 역할 lease·후보 없이 claim 으로 일하는 consumer(agent-scan·uptime 등) — 담당·예비가 아니고 역할 작업 줄이 없다 */
export type CollectorInstance = { instanceId: string; role: JobRole; kind: "primary" | "standby" | "unknown" | "consumer";
  state: "active" | "standby" | "stale" | "stopping" | "unknown"; observedAt: string | null; runtimeStale: boolean;
  release: string | null; lanes: { name: JobLane; jobs: string[]; currentJob: string | null;
    state: "idle" | "polling" | "running" | "stopping" | "standby" | "stale" | "unknown" | "other-job"; startedAt: string | null }[] };
export type CrawlerActivityReport = { measuredAt: string; jobs: CollectorRow[]; instances: CollectorInstance[];
  recent: CollectorResult[]; roleReadFailed: boolean; queueReadFailed: boolean;
  /** 누적(job-tally)·미룸(defer) 을 읽지 못했는가 — 못 읽은 것은 0 이 아니라 미확인이다 */
  totalsReadFailed: boolean; deferralsReadFailed: boolean;
  x: { state: "manual-pilot"; scheduled: false; lastRunAt: null } };
/** Every crawler catalog job is included, including future jobs without a display description(목록은 lib/jobs/tally.ts — runner 누적과 같다). */
export { COLLECTOR_JOBS };
const collectorNames = COLLECTOR_NAMES;
const collectorRoles = new Set(COLLECTOR_JOBS.map(job => job.role));

/** Exact known event/counter names: arbitrary log strings and numeric IDs never become browser data(목록은 lib/jobs/collector-events.ts — 누적도 같은 목록을 먼저 싣는다). */
const EVENTS = COLLECTOR_EVENTS;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}
function iso(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function fresh(row: Observation | undefined, now: number, maxMs: number): boolean {
  const date = iso(row?.observedAt);
  const age = date ? now - Date.parse(date) : NaN;
  return Number.isFinite(age) && age >= -5_000 && age <= maxMs;
}

function result(row: Observation, name: string): CollectorResult | null {
  const observedAt = iso(row.observedAt);
  if (!observedAt) return null;
  const events: CollectorEvent[] = [];
  let itemErrors: number | null = null, errorEvents = 0, providerError = false, waiting = false, scanStatusUnknown = false;
  for (const raw of (Array.isArray(row.value.events) ? row.value.events.slice(-12) : [])) {
    const event = record(raw), definition = typeof event.event === "string" && Object.hasOwn(EVENTS, event.event) ? EVENTS[event.event] : null;
    if (!definition) continue;
    const counters = record(event.counts), counts: CollectorEvent["counts"] = {};
    for (const field of definition.fields) {
      const value = counters[field];
      if (typeof value === "boolean") counts[field] = value;
      else if (event.event === "agent_evidence.scanned" && field === "failed") continue;
      else if (count(value) !== null) counts[field] = value as number;
    }
    // Historical scanned events lost state/errorCode in the runner; zero observations cannot prove success.
    if (event.event === "agent_evidence.scanned" && typeof counts.failed !== "boolean") scanStatusUnknown = true;
    // Summary events carry cumulative totals; per-item events can describe the same failure.
    if (typeof counts.failed === "number") itemErrors = counts.failed;
    if (counts.failed === true) providerError = true;
    if (definition.error) errorEvents++;
    waiting ||= !!definition.waiting;
    events.push({ label: definition.label, counts });
  }
  return { name, observedAt, durationMs: count(row.value.durationMs), done: typeof row.value.done === "boolean" ? row.value.done : null,
    outcome: itemErrors !== null && itemErrors > 0 ? "item-errors" : providerError ? "provider-error"
      : errorEvents > 0 ? "event-errors" : waiting ? "waiting" : scanStatusUnknown ? "unknown" : "completed", itemErrors, errorEvents, providerError, events };
}

/**
 * 누적 한 창을 화면 숫자로 — 이 파일의 EVENTS 에 있는 이벤트·필드만(임의의 로그 글자는 브라우저로 가지 않는다), 더해서 뜻이 있는 필드만.
 * 숫자 없는 이벤트(오류·대기 알림)는 나온 횟수(times)로 보인다.
 */
function totalsOf(window: TallyWindow): CollectorTotals {
  // 이벤트별 합 — 다른 이벤트로 접는 필드(foldInto)는 그쪽에 더한다. 더하지 않는 필드(noSum)·더해서 뜻이 없는 필드는 뺀다
  const sums = new Map<string, Record<string, number>>();
  const add = (event: string, field: string, value: number) => {
    const counts = sums.get(event) ?? {};
    counts[field] = (counts[field] ?? 0) + value;
    sums.set(event, counts);
  };
  for (const [event, definition] of Object.entries(EVENTS)) {
    for (const field of definition.fields) {
      // 조사 결과의 failed 는 예전 관측에서 상태를 잃었다 — 마지막 회차 표시(result)와 같이 세지 않는다
      if (!isAdditiveField(field) || definition.noSum?.includes(field) || (event === "agent_evidence.scanned" && field === "failed")) continue;
      const value = count(window[`${event}#${field}`]);
      if (!value) continue;
      add(definition.foldInto?.fields.includes(field) ? definition.foldInto.event : event, field, value);
    }
  }
  const events: CollectorEvent[] = [];
  for (const [event, definition] of Object.entries(EVENTS)) {
    const counts = sums.get(event) ?? {};
    // 나온 횟수는 대기·오류 알림이거나 숫자를 싣지 않은 이벤트에만 보인다(결과 요약은 회차 수와 같아 겹친다)
    const occurred = count(window[event]) ?? 0;
    const times = occurred && (definition.waiting || definition.error || Object.keys(counts).length === 0) ? occurred : 0;
    if (Object.keys(counts).length || times) events.push({ label: definition.label, counts, ...(times ? { times } : {}) });
  }
  return { ticks: count(window["@ok"]) ?? 0, failed: count(window["@failed"]) ?? 0, degraded: count(window["@degraded"]) ?? 0, events };
}

function enabled(name: string, settings: CrawlSettings): boolean {
  if (name === "crawl-fetch") return settings.enabled;
  if (name === "crawl-seed") return settings.enabled && settings.discover.queries.some(query => query.enabled);
  if (name === "hn-show-seed") return settings.enabled && settings.discover.showHn.enabled;
  if (name === "agent-evidence-refresh") return settings.agentEvidence.enabled;
  if (name === "news-refresh") return NEWS_SOURCE_KEYS.some(key => !settings.news.disabledSources.includes(key));
  return true;
}
function errorCategory(value: string | null | undefined): CollectorRow["error"] {
  if (!value) return null;
  if (/timeout|timed out/i.test(value)) return "timeout";
  if (/rate.?limit|quota|\b429\b/i.test(value)) return "rate-limited";
  if (/auth|credential|\b401\b|\b403\b/i.test(value)) return "authentication";
  return "job-error";
}

function instanceRows(observations: Observation[], roles: RoleOwner[] | null, now: number): CollectorInstance[] {
  const grouped = new Map<string, { role: JobRole; instanceId: string; runtime?: Observation; candidate?: Observation }>();
  for (const row of observations) {
    const candidate = row.key.startsWith("candidate:");
    const parsed = parseServiceObservationKey(candidate ? row.key.replace(/^candidate:/, "service:") : row.key);
    if (!parsed || !collectorRoles.has(parsed.role as JobRole)) continue;
    const key = `${parsed.role}:${parsed.instanceId}`, current = grouped.get(key) ?? { ...parsed, role: parsed.role as JobRole };
    const field = candidate ? "candidate" : "runtime";
    if (!current[field] || Date.parse(iso(row.observedAt) ?? "") > Date.parse(iso(current[field]?.observedAt) ?? "")) current[field] = row;
    grouped.set(key, current);
  }
  const scopedRoles = new Set([...grouped.values()].filter(row => row.instanceId !== "legacy").map(row => row.role));
  const releaseOf = (row: Observation | undefined) => {
    const value = row?.value.release;
    return typeof value === "string" && /^[a-f0-9]{7,64}$/.test(value) ? value.slice(0,12) : null;
  };
  const rows = [...grouped.values()].filter(row => row.instanceId !== "legacy" || !scopedRoles.has(row.role)).map(({ role, instanceId, candidate, runtime }): CollectorInstance => {
    const candidateFresh = fresh(candidate, now, 60_000), runtimeFresh = fresh(runtime, now, 45_000);
    // consumer 는 역할 lease·후보 관측이 없다 — '담당 여부 미확인' 역할 인스턴스로 섞지 않고 감독 관측만으로 따로 한 줄을 낸다
    if (isConsumerServiceInstance(instanceId)) {
      const status = runtime?.value.status;
      return { instanceId, role, kind: "consumer", state: runtimeFresh && (status === "running" || status === "starting") ? "active" : "stale",
        observedAt: iso(runtime?.observedAt), runtimeStale: !runtimeFresh, release: releaseOf(runtime), lanes: [] };
    }
    const phase = candidateFresh ? candidate?.value.phase : null;
    const owner = roles?.find(row => row.role === role);
    const owns = owner?.ownerInstanceId === instanceId && typeof owner.secondsUntilExpiry === "number"
      && Number.isFinite(owner.secondsUntilExpiry) && owner.secondsUntilExpiry > 0;
    // An acquired worker can publish runtime before the next candidate heartbeat replaces its old standby phase.
    const newerOwnedRuntime = owns && runtimeFresh && runtime?.value.status === "running" && (!candidateFresh
      || Date.parse(iso(runtime.observedAt) ?? "") > Date.parse(iso(candidate?.observedAt) ?? ""));
    const state: CollectorInstance["state"] = !candidateFresh && !runtimeFresh ? "stale" : newerOwnedRuntime ? "active" : phase === "stopping" ? "stopping"
      : phase === "standby" ? "standby" : owns && (phase === "active" || runtimeFresh && runtime?.value.status === "running") ? "active" : "unknown";
    const kind = candidate?.value.kind === "primary" || candidate?.value.kind === "standby" ? candidate.value.kind : "unknown";
    const roleJobs = COLLECTOR_JOBS.filter(job => job.role === role);
    const metadata = runtimeFresh && state === "active" && runtime?.value.status === "running" ? parseRuntimeLanes(runtime.value.lanes, role) : null;
    const configuredLanes = [...new Set(roleJobs.map(job => job.lane ?? "main"))];
    const lanes = configuredLanes.map((name): CollectorInstance["lanes"][number] => {
      const jobs = roleJobs.filter(job => (job.lane ?? "main") === name).map(job => job.name);
      const measured = metadata?.find(lane => lane.jobs.some(job => jobs.includes(job)));
      const currentJob = measured?.currentJob && jobs.includes(measured.currentJob) ? measured.currentJob : null;
      const laneState = state === "standby" ? "standby" : state === "stale" ? "stale" : state === "stopping" ? "stopping"
        : measured ? measured.state === "running" && !currentJob ? "other-job" : measured.state : "unknown";
      return { name, jobs, state: laneState, currentJob, startedAt: currentJob ? iso(measured?.startedAt) : null };
    });
    const newest = [candidate, runtime].filter((row): row is Observation => !!row).sort((a,b) => Date.parse(iso(b.observedAt) ?? "") - Date.parse(iso(a.observedAt) ?? ""))[0];
    return { instanceId, role, kind, state, observedAt: iso(newest?.observedAt), runtimeStale: !runtimeFresh, release: releaseOf(newest), lanes };
  });
  rows.sort((a,b) => Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? ""));
  // Preserve every current instance; old deployment keys are bounded separately.
  return [...rows.filter(row => row.state !== "stale"), ...rows.filter(row => row.state === "stale").slice(0,20)];
}

export function buildCrawlerActivity(input: { settings: CrawlSettings; jobs: CollectorJobInput[];
  observations: Observation[]; roles: RoleOwner[] | null; throughput: QueueMetrics | null; now: Date;
  /** 수집기 회차 누적(readJobTallies) — 못 읽었으면 null. 넘기지 않으면(undefined) 누적 칸을 그리지 않는다 */
  tallies?: JobTallySummary[] | null;
  /** 미룬 이유(defer:<job>, readDeferrals) — 못 읽었으면 null */
  deferrals?: JobDeferralSummary[] | null }): CrawlerActivityReport {
  const { settings, observations, roles, throughput, now } = input;
  const tallies = input.tallies === undefined ? undefined : input.tallies === null ? null : new Map(input.tallies.map(row => [row.job, row]));
  const deferrals = new Map((input.deferrals ?? []).map(row => [row.job, row]));
  const latest = new Map<string, CollectorResult>();
  // Filter before limit. Review/publish/text observations cannot crowd out collector results.
  for (const row of observations) {
    if (!row.key.startsWith("job:")) continue;
    const name = row.key.slice(4);
    if (!collectorNames.has(name)) continue;
    const projected = result(row, name), previous = latest.get(name);
    if (projected && (!previous || Date.parse(projected.observedAt) > Date.parse(previous.observedAt))) latest.set(name, projected);
  }
  const states = new Map(input.jobs.map(job => [job.name, job]));
  const jobs = COLLECTOR_JOBS.map((catalog): CollectorRow => {
    const job = states.get(catalog.name), at = now.getTime();
    const storedRetry = iso(job?.notBefore);
    const cursor = record(job?.cursor);
    const providerRetry = ["agent-evidence-refresh", "ai-level-refresh", "product-stars-refresh", "product-star-observation"].includes(catalog.name)
      ? iso(cursor.retryAfter) : catalog.name === "crawl-seed" ? iso(cursor.retryAt) : null;
    const retryAt = [storedRetry, providerRetry].filter((value): value is string => !!value && Date.parse(value) > at)
      .sort((a,b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const locked = iso(job?.lockedAt), lockAge = locked ? at - Date.parse(locked) : Infinity;
    const isEnabled = enabled(catalog.name, settings), paused = isPausedJob(job, at);
    const providerFailure = catalog.name === "agent-evidence-refresh" ? parseAgentProviderFailure(cursor.providerFailure) : null;
    const error = errorCategory(job?.lastError) ?? (providerFailure ? providerFailure.code === "rate_limited" ? "rate-limited"
      : providerFailure.code === "timeout" ? "timeout" : "job-error" : null);
    const state: CollectorState = locked ? job?.leaseToken && lockAge >= -5_000 && lockAge <= STALE_LOCK_MS ? "running" : "stale-lock"
      : paused ? "paused" : !isEnabled ? "disabled"
      : retryAt ? "retrying" : job && job.requestedVersion > job.processedVersion ? "queued"
      : error ? "error" : !job?.lastRunAt ? "never-run" : "idle";
    const queue = catalog.name === "crawl-fetch" ? throughput?.stages.find(stage => stage.key === "fetch") : null;
    const recentResult = latest.get(catalog.name) ?? null;
    // 마지막 성공 회차보다 나중의 미룸·실패만 — 그보다 오래된 것은 이미 지난 일이다
    const since = Date.parse(recentResult?.observedAt ?? iso(job?.lastSuccessAt) ?? "") || -Infinity;
    const deferral = deferrals.get(catalog.name);
    const deferredAt = iso(deferral?.lastDeferredAt);
    const tally = tallies?.get(catalog.name);
    const failedAt = iso(tally?.lastFailedAt);
    return { name: catalog.name, role: catalog.role, lane: catalog.lane ?? "main", state, enabled: isEnabled, paused, intervalMs: catalog.intervalMs,
      lastRunAt: iso(job?.lastRunAt), lastSuccessAt: iso(job?.lastSuccessAt), nextScheduledAt: iso(job?.nextScheduledAt),
      retryAt, runs: count(job?.runs), waiting: count(queue?.waiting), deferred: count(queue?.deferred),
      error, note: catalog.name === "product-repo-review" ? "재확인 결과에 따라 제품을 내릴 수 있습니다. 여기서는 활동만 관측합니다." : null,
      latest: recentResult,
      totals: tallies === null || tallies === undefined ? null : { hour: totalsOf(tally?.hour ?? {}), day: totalsOf(tally?.day ?? {}) },
      lastDeferred: deferral && deferredAt && Date.parse(deferredAt) > since
        ? { reason: deferral.reason, at: deferredAt, lastHour: count(deferral.lastHour) ?? 0 } : null,
      lastFailedAt: failedAt && Date.parse(failedAt) > since ? failedAt : null,
      deferredHour: input.deferrals === null || input.deferrals === undefined ? null : count(deferral?.lastHour) ?? 0 };
  });
  return { measuredAt: now.toISOString(), jobs, instances: instanceRows(observations, roles, now.getTime()),
    recent: [...latest.values()].sort((a,b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0,30),
    roleReadFailed: roles === null, queueReadFailed: throughput === null,
    totalsReadFailed: input.tallies === null, deferralsReadFailed: input.deferrals === null,
    x: { state: "manual-pilot", scheduled: false, lastRunAt: null } };
}
