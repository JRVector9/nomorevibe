import { createHash } from "node:crypto";

export const DISCOVERY_SOURCES = ["github-latest", "github-full", "show-hn", "korean-query", "korean-shared", "korean-language", "korean-apply"] as const;
export type DiscoverySource = typeof DISCOVERY_SOURCES[number];
export const DISCOVERY_MAX_SUBJECTS = 128;
export const DISCOVERY_MAX_CHECKPOINTS = DISCOVERY_SOURCES.length * DISCOVERY_MAX_SUBJECTS;
export const DISCOVERY_FAILURE_REASONS = ["no_progress", "worker_missing", "consumer_missing", "upstream_stalled"] as const;
export type DiscoveryFailureReason = typeof DISCOVERY_FAILURE_REASONS[number];
export type DiscoveryFailures = { v: 1; covered: DiscoverySource[]; failures: { source: DiscoverySource; reason: DiscoveryFailureReason }[] };
export type DiscoveryIntent = "ready" | "caught_up" | "queue_cap" | "rate_cap" | "backoff" | "upstream_error" | "no_work" | "measurement_unknown";
export type DiscoveryCheckpointInput = {
  source: DiscoverySource; subject: string; generation: string; semantic: string;
  reference?: string; intent: DiscoveryIntent; resumeAt?: string | null;
  progressed?: boolean; acknowledged?: boolean;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Stable bounded hashes contain no raw query, message, URL or credential. */
export function discoveryHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}
export function githubDiscoveryGeneration(query: { kind: string; query: string }, discover: { sort: string; windowDays: number; maxNewPerHour: number; maxReviewBacklog: number }): string {
  return discoveryHash({ kind: query.kind, query: query.query, sort: discover.sort, windowDays: discover.windowDays,
    maxNewPerHour: discover.maxNewPerHour, maxReviewBacklog: discover.maxReviewBacklog });
}
export const koreanDiscoveryGeneration = (epoch: number) => discoveryHash({ epoch });
export const koreanQueryGeneration = (epoch: number, query: string, days: number) => discoveryHash({ epoch, query, days });

/** Ignore attempts, timers, fairness timestamps and renewals. Only durable work position participates. */
export function githubDiscoverySemantic(raw: unknown, label: string): string {
  const cursor = object(raw) ? raw : {};
  const states = object(cursor.states) ? cursor.states : {};
  const state = cursor.signal === label ? cursor : object(states[label]) ? states[label] : {};
  const pending = object(state.pendingPage) ? state.pendingPage : null;
  return discoveryHash({ cycleWindow: cursor.cycleWindow ?? null, done: Array.isArray(cursor.doneSignals) && cursor.doneSignals.includes(label),
    window: state.window ?? cursor.cycleWindow ?? null, page: state.page ?? 1, pendingWindows: state.pendingWindows ?? [],
    incomplete: state.windowIncomplete === true,
    unresolved: Array.isArray(cursor.incompleteWindows) ? cursor.incompleteWindows.filter(v => object(v) && v.signal === label).map(v => (v as Record<string, unknown>).window) : [],
    pending: pending ? { itemIndex: pending.itemIndex, items: pending.items, size: pending.size, incomplete: pending.incomplete, saturated: pending.saturated, capped: pending.capped } : null });
}
export function koreanCursorSemantic(raw: unknown): string {
  const cursor = object(raw) ? raw : {};
  return discoveryHash({ window: cursor.window, page: cursor.page, pendingWindows: cursor.pendingWindows, unresolved: cursor.unresolved === true });
}
/** Mirrors the crawler's shared authentication/quota hold; an occupied page or completed preview is not shared. */
export function githubDiscoverySharedWait(raw: unknown, now: number): boolean {
  if (!object(raw) || raw.waiting === true || typeof raw.retryAt !== 'string' || !(Date.parse(raw.retryAt) > now)) return false;
  return raw.retryKind === 'rate_limited' || raw.retryKind === 'auth_unavailable'
    || !raw.retryKind && raw.phase !== 'retry' && !(Array.isArray(raw.incompleteWindows) && raw.incompleteWindows.length);
}
export function githubDiscoveryReceipts(raw: unknown, queries: { label: string; kind: string; query: string }[],
  discover: Parameters<typeof githubDiscoveryGeneration>[1], source: "github-full" | "github-latest",
  options: { progressed?: ReadonlySet<string>; acknowledged?: ReadonlySet<string>; intent?: DiscoveryIntent } = {}): DiscoveryCheckpointInput[] {
  const cursor = object(raw) ? raw : {};
  const resumeAt = typeof cursor.retryAt === "string" && Number.isFinite(Date.parse(cursor.retryAt)) ? cursor.retryAt : null;
  const failed = typeof cursor.retryKind === "string" && !["rate_limited", "auth_unavailable", "discovery_busy"].includes(cursor.retryKind);
  return queries.map(query => ({ source, subject: discoveryHash(query.label), generation: githubDiscoveryGeneration(query, discover),
    semantic: githubDiscoverySemantic(raw, query.label), intent: options.intent ?? (failed ? "upstream_error" : cursor.waiting === true ? "caught_up"
      : resumeAt ? "backoff" : Array.isArray(cursor.doneSignals) && cursor.doneSignals.includes(query.label) ? "no_work" : "ready"),
    resumeAt, progressed: options.progressed?.has(query.label), acknowledged: options.acknowledged?.has(query.label) }));
}
export function validDiscoveryFailures(value: unknown): value is DiscoveryFailures {
  if (!object(value) || Object.keys(value).sort().join(",") !== "covered,failures,v" || value.v !== 1
    || !Array.isArray(value.covered) || !Array.isArray(value.failures) || value.covered.length > 7 || value.failures.length > 7) return false;
  const sources = new Set<string>(DISCOVERY_SOURCES), reasons = new Set<string>(DISCOVERY_FAILURE_REASONS);
  const covered = value.covered;
  if (!covered.every(v => typeof v === "string" && sources.has(v)) || new Set(covered).size !== covered.length) return false;
  const failed = new Set<string>();
  for (const v of value.failures) {
    if (!object(v) || Object.keys(v).sort().join(",") !== "reason,source" || typeof v.source !== "string" || !covered.includes(v.source)
      || typeof v.reason !== "string" || !reasons.has(v.reason) || failed.has(v.source)) return false;
    failed.add(v.source);
  }
  return true;
}
