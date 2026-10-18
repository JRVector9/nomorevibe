import { JOB_CATALOG, type JobRole, type JobLane } from "@/lib/jobs/catalog";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { isPausedJob } from "@/lib/jobs/status";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { parseServiceObservationKey } from "./instance";
import { parseAgentProviderFailure, parseRuntimeLanes } from "./worker-progress";
import { NEWS_SOURCE_KEYS } from "@/lib/news/sources";

export type CollectorJobInput = { name: string; lastRunAt: Date | null; lastSuccessAt: Date | null;
  nextScheduledAt: Date | null; notBefore: Date | null; lockedAt: Date | null; leaseToken: string | null;
  requestedVersion: number; processedVersion: number; lastError: string | null; runs: number; cursor?: unknown };
type Observation = { key: string; value: Record<string, unknown>; observedAt: Date | string };
type RoleOwner = { role: string; ownerInstanceId: string | null; secondsUntilExpiry: number | null };
type QueueMetrics = { measuredAt: string; stages: { key: string; waiting: number; deferred?: number }[] };
export type CollectorState = "disabled" | "paused" | "running" | "stale-lock" | "retrying" | "queued" | "error" | "never-run" | "idle";
export type CollectorEvent = { label: string; counts: Record<string, number | boolean> };
export type CollectorResult = { name: string; observedAt: string; durationMs: number | null; done: boolean | null;
  outcome: "item-errors" | "event-errors" | "provider-error" | "waiting" | "completed" | "unknown"; itemErrors: number | null;
  errorEvents: number; providerError: boolean; events: CollectorEvent[] };
export type CollectorRow = { name: string; role: JobRole; lane: JobLane; state: CollectorState;
  enabled: boolean; paused: boolean;
  intervalMs: number | null; lastRunAt: string | null; lastSuccessAt: string | null; nextScheduledAt: string | null;
  retryAt: string | null; runs: number | null; waiting: number | null; deferred: number | null;
  error: "timeout" | "rate-limited" | "authentication" | "job-error" | null; note: string | null; latest: CollectorResult | null };
export type CollectorInstance = { instanceId: string; role: JobRole; kind: "primary" | "standby" | "unknown";
  state: "active" | "standby" | "stale" | "stopping" | "unknown"; observedAt: string | null; runtimeStale: boolean;
  release: string | null; lanes: { name: JobLane; jobs: string[]; currentJob: string | null;
    state: "idle" | "polling" | "running" | "stopping" | "standby" | "stale" | "unknown" | "other-job"; startedAt: string | null }[] };
export type CrawlerActivityReport = { measuredAt: string; jobs: CollectorRow[]; instances: CollectorInstance[];
  recent: CollectorResult[]; roleReadFailed: boolean; queueReadFailed: boolean;
  x: { state: "manual-pilot"; scheduled: false; lastRunAt: null } };
const EXTERNAL_COLLECTORS = new Set(["uptime-ping", "news-refresh", "product-thumbnail-refresh", "product-repo-review"]);
/** Every crawler catalog job is included, including future jobs without a display description. */
export const COLLECTOR_JOBS = JOB_CATALOG.filter((job): job is typeof job & { role: JobRole } =>
  job.role === "crawler" || (job.role !== "scheduler" && EXTERNAL_COLLECTORS.has(job.name)));
const collectorNames = new Set(COLLECTOR_JOBS.map(job => job.name));
const collectorRoles = new Set(COLLECTOR_JOBS.map(job => job.role));

/** Exact known event/counter names: arbitrary log strings and numeric IDs never become browser data. */
const EVENTS: Record<string, { label: string; fields: string[]; error?: boolean; waiting?: boolean }> = {
  "crawl.seeded": { label: "탐색 결과", fields: ["discovered", "drained", "page", "incompleteWindows"] },
  "crawl.seed_latest_scanned": { label: "최신 탐색 결과", fields: ["discovered", "page", "incompleteWindows"] },
  "crawl.seed_admission": { label: "탐색 수용 확인", fields: ["throttled"] },
  "crawl.seed_failed": { label: "탐색 항목 오류", fields: [], error: true },
  "crawl.seed_incomplete": { label: "탐색 이어서 처리", fields: ["page"], waiting: true },
  "crawl.fetched": { label: "원본 수집 결과", fields: ["fetched", "skipped", "failed", "gated", "drained"] },
  "crawl.fetch_recovered": { label: "중단 수집 회수", fields: ["recovered"] },
  "crawl.fetch_rate_limited": { label: "원본 공급자 한도 대기", fields: [], waiting: true },
  "crawl.fetch_auth_unavailable": { label: "원본 수집 인증 확인 필요", fields: [], error: true },
  "crawl.show_hn_seeded": { label: "Show HN 수집 결과", fields: ["discovered", "examined", "backlogPages", "drained"] },
  "crawl.show_hn_failed": { label: "Show HN 항목 오류", fields: ["page"], error: true },
  "evidence.refresh_batch": { label: "공개 근거 수집 결과", fields: ["attempted", "succeeded", "failed", "factsChanged", "eventsInserted", "mediaInserted"] },
  "evidence.product_refresh_failed": { label: "공개 근거 항목 오류", fields: [], error: true },
  "evidence.initial_refresh_queue_failed": { label: "근거 수집 요청 오류", fields: [], error: true },
  "agent_evidence.scanned": { label: "개발 AI 조사 결과", fields: ["observations", "cached", "failed"] },
  "agent_evidence.failed": { label: "개발 AI 조사 오류", fields: [], error: true },
  "agent_evidence.attach_failed": { label: "개발 AI 근거 연결 오류", fields: [], error: true },
  "agent_evidence.deferred": { label: "개발 AI 조사 재시도 대기", fields: [], waiting: true },
  "agent_evidence.disabled": { label: "개발 AI 수집 설정 꺼짐", fields: [] },
  "agent_evidence.github_headroom_low": { label: "개발 AI 조사 GitHub 잔량 부족", fields: ["remaining", "limit"], waiting: true },
  "ai_level.tick": { label: "AI 단계 확인 결과", fields: ["checked", "due", "verified", "restUsed"] },
  "ai_level.rate_limited": { label: "AI 단계 공급자 한도 대기", fields: [], waiting: true },
  "ai_level.graphql_low": { label: "AI 단계 공급자 잔량 부족", fields: ["remaining"], waiting: true },
  "product_stars.refreshed": { label: "저장소·스타 확인 결과", fields: ["examined", "updated", "ok", "missing", "empty", "blocked", "unknown", "renamed", "archived", "batches", "failed"] },
  "product_stars.waiting": { label: "저장소·스타 공급자 대기", fields: ["examined", "updated", "batches"], waiting: true },
  "product_star_observation.closed": { label: "스타 관측 회차 닫힘", fields: ["runs"] },
  "product_star_observation.collected": { label: "스타 관측 결과", fields: ["examined", "recorded", "batches", "targets"] },
  "product_star_observation.waiting": { label: "스타 관측 공급자 대기", fields: ["examined", "recorded", "batches"], waiting: true },
  "readme_refresh.done": { label: "README 갱신 결과", fields: ["refreshed", "failed", "superseded"] },
  "uptime.idle": { label: "응답 점검 대상 없음", fields: ["checked"] },
  "uptime.checked": { label: "서비스 응답 결과", fields: ["alive", "down"] },
  "uptime.broad_failure_held": { label: "응답 점검 광역 실패 보류", fields: ["attempted", "down"], error: true },
  "news.refreshed": { label: "소식 수집 결과", fields: ["added", "failed", "autoApprove", "unfinished"] },
  "thumbnail.refreshed": { label: "이미지 수집 결과", fields: ["examined", "filled", "defaults", "skipped", "failed"] },
  "repo_review.idle": { label: "저장소 재확인 대상 없음", fields: ["reviewed"] },
  "repo_review.reviewed": { label: "저장소 재확인 결과", fields: ["keep", "human", "delist_candidate", "delisted", "unknown", "capped", "operatorKeep"] },
  "repo_review.blocked": { label: "저장소 재확인 공급자 대기", fields: ["keep", "human", "delist_candidate", "delisted", "unknown", "capped", "operatorKeep"], waiting: true },
  "repo_review.capped": { label: "자동 내리기 한도 대기", fields: ["limit", "capped"], waiting: true },
};

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
  const rows = [...grouped.values()].filter(row => row.instanceId !== "legacy" || !scopedRoles.has(row.role)).map(({ role, instanceId, candidate, runtime }): CollectorInstance => {
    const candidateFresh = fresh(candidate, now, 60_000), runtimeFresh = fresh(runtime, now, 45_000);
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
    const releaseValue = newest?.value.release;
    const release = typeof releaseValue === "string" && /^[a-f0-9]{7,64}$/.test(releaseValue) ? releaseValue.slice(0,12) : null;
    return { instanceId, role, kind, state, observedAt: iso(newest?.observedAt), runtimeStale: !runtimeFresh, release, lanes };
  });
  rows.sort((a,b) => Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? ""));
  // Preserve every current instance; old deployment keys are bounded separately.
  return [...rows.filter(row => row.state !== "stale"), ...rows.filter(row => row.state === "stale").slice(0,20)];
}

export function buildCrawlerActivity(input: { settings: CrawlSettings; jobs: CollectorJobInput[];
  observations: Observation[]; roles: RoleOwner[] | null; throughput: QueueMetrics | null; now: Date }): CrawlerActivityReport {
  const { settings, observations, roles, throughput, now } = input;
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
    return { name: catalog.name, role: catalog.role, lane: catalog.lane ?? "main", state, enabled: isEnabled, paused, intervalMs: catalog.intervalMs,
      lastRunAt: iso(job?.lastRunAt), lastSuccessAt: iso(job?.lastSuccessAt), nextScheduledAt: iso(job?.nextScheduledAt),
      retryAt, runs: count(job?.runs), waiting: count(queue?.waiting), deferred: count(queue?.deferred),
      error, note: catalog.name === "product-repo-review" ? "재확인 결과에 따라 제품을 내릴 수 있습니다. 여기서는 활동만 관측합니다." : null,
      latest: latest.get(catalog.name) ?? null };
  });
  return { measuredAt: now.toISOString(), jobs, instances: instanceRows(observations, roles, now.getTime()),
    recent: [...latest.values()].sort((a,b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0,30),
    roleReadFailed: roles === null, queueReadFailed: throughput === null, x: { state: "manual-pilot", scheduled: false, lastRunAt: null } };
}
