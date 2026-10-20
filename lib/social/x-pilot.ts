/** Private first acceptance pilot. No database, pagination, retries, scoring, or link fetching. */
export const X_PILOT_QUERY = 'url:github.com (launch OR launched OR "built with" OR "vibe coding") has:links';
const SEARCH = "https://api.x.com/2/tweets/search/recent";
const LOOKUP = "https://api.x.com/2/tweets";
const FIELDS = "id,created_at,entities,public_metrics,withheld";
const MAX_BYTES = 1024 * 1024;
const DEADLINE_MS = 20_000;
const METRICS = ["like_count", "reply_count", "retweet_count", "quote_count", "impression_count", "bookmark_count"] as const;
type Metric = typeof METRICS[number];
type Availability = "available" | "unavailable" | "unknown";
type Failure = "timeout" | "transport_error" | "http_error" | "body_too_large" | "invalid_response";
export type XPilotOptions = { live?: boolean; useCaseApproved?: boolean; token?: string; query?: string;
  fieldsParameter?: "tweet.fields" | "post.fields"; lookupIds?: readonly string[]; searchOnly?: boolean };
export type XObservation = { id: string; createdAt: string | null; observedAt: string; availability: Availability;
  repositories: string[]; linkStatus: "none" | "single" | "ambiguous"; metrics: Record<Metric, number | null> };
type RequestRecord = { endpoint: "recent-search" | "lookup"; reservedPosts: number; status: number | null;
  outcome: "ok" | "http" | Exclude<Failure, "http_error">; retryAfterSeconds?: number };
export type XPilotResult = { mode: "dry-run" | "live"; status: "planned" | "skipped" | "completed" | "stopped"; reason?: string;
  needsLiveValidation: true; plan: { query: string; startTime: string; fieldsParameter: string; searchLimit: 10;
    maxRequests: 1 | 3; maxPostResources: 10 | 30; endpoints: string[] } | null; reservedPosts: number;
  requests: RequestRecord[]; observations: XObservation[];
  summary: { available: number; unavailable: number; unknown: number; singleRepoPosts: number; ambiguousRepoPosts: number;
    metricsComplete: number; metricsPartial: number } };
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const postId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const nullMetrics = () => Object.fromEntries(METRICS.map(key => [key, null])) as Record<Metric, number | null>;
const accessDenied = (value: Json | null) => Boolean(value?.withheld || value?.unavailable === true || value?.access === "unavailable");
function deniedIds(value: Json, ids: readonly string[]): Set<string> {
  const denied = new Set<string>();
  for (const item of Array.isArray(value.data) ? value.data : []) if (object(item) && postId(item.id)
    && ids.includes(item.id) && accessDenied(item)) denied.add(item.id);
  for (const error of Array.isArray(value.errors) ? value.errors : []) if (object(error) && postId(error.resource_id)
    && ids.includes(error.resource_id) && typeof error.type === "string"
    && /\/(resource-not-found|not-authorized-for-resource|disallowed-resource|resource-unavailable)$/.test(error.type)) denied.add(error.resource_id);
  return denied;
}

function repository(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
    const [owner, raw] = url.pathname.split("/").slice(1, 3);
    const repo = raw?.replace(/\.git$/i, "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner ?? "") || !/^[a-z0-9_.-]{1,100}$/i.test(repo ?? "")
      || [".", ".."].includes(repo) || /^(features|topics|collections|sponsors|marketplace|settings|login|logout|signup|search|orgs|users|apps|about|pricing|enterprise|security|site)$/i.test(owner)) return null;
    return `${owner}/${repo}`.toLowerCase();
  } catch { return null; }
}

function observation(id: string, value: Json | null, observedAt: string, availability: Availability): XObservation {
  if (accessDenied(value)) availability = "unavailable";
  const metrics = nullMetrics(), repositories = new Set<string>();
  if (value && availability === "available") {
    if (object(value.public_metrics)) for (const key of METRICS) {
      const number = value.public_metrics[key];
      if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) metrics[key] = number;
    }
    const urls = object(value.entities) && Array.isArray(value.entities.urls) ? value.entities.urls : [];
    for (const item of urls) if (object(item)) for (const target of [item.expanded_url, item.unwound_url]) {
      const repo = repository(target);
      if (repo) repositories.add(repo);
    }
  }
  const keys = [...repositories].sort();
  const createdAt = typeof value?.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
    ? new Date(value.created_at).toISOString() : null;
  return { id, createdAt, observedAt, availability, repositories: keys,
    linkStatus: keys.length > 1 ? "ambiguous" : keys.length ? "single" : "none", metrics };
}

class PilotFailure extends Error { constructor(readonly reason: Failure) { super(reason); } }
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PilotFailure("timeout"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<Json> {
  const reader = response.body?.getReader();
  if (!reader) throw new PilotFailure("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0, complete = false;
  try {
    while (true) {
      const chunk = await untilAborted(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new PilotFailure("body_too_large");
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    if (!object(value)) throw new PilotFailure("invalid_response");
    return value;
  } catch (error) {
    if (error instanceof PilotFailure) throw error;
    throw new PilotFailure("invalid_response");
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value || value.length > 100) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(86_400, Math.ceil(seconds)) : undefined;
}

function summarize(observations: XObservation[]): XPilotResult["summary"] {
  return { available: observations.filter(item => item.availability === "available").length,
    unavailable: observations.filter(item => item.availability === "unavailable").length,
    unknown: observations.filter(item => item.availability === "unknown").length,
    singleRepoPosts: observations.filter(item => item.linkStatus === "single").length,
    ambiguousRepoPosts: observations.filter(item => item.linkStatus === "ambiguous").length,
    metricsComplete: observations.filter(item => METRICS.every(key => item.metrics[key] !== null)).length,
    metricsPartial: observations.filter(item => METRICS.some(key => item.metrics[key] === null)).length };
}

export async function runXPilot(options: XPilotOptions = {}, dependencies: { request?: typeof fetch; now?: () => number } = {}): Promise<XPilotResult> {
  const now = dependencies.now ?? Date.now;
  const result: XPilotResult = { mode: options.live ? "live" : "dry-run", status: "planned", needsLiveValidation: true,
    plan: null, requests: [], reservedPosts: 0, observations: [], summary: summarize([]) };
  const skip = (reason: string) => { result.status = "skipped"; result.reason = reason; return result; };
  const fieldsParameter = options.fieldsParameter ?? "tweet.fields";
  const rawQuery = (options.query ?? X_PILOT_QUERY).trim();
  const query = `(${rawQuery}) -is:retweet`;
  const provided = [...new Set(options.lookupIds ?? [])];
  if (!rawQuery || query.length > 512 || /[\u0000-\u001f\u007f]/.test(query)) return skip("invalid_query");
  if (!["tweet.fields", "post.fields"].includes(fieldsParameter)) return skip("invalid_fields_parameter");
  if (provided.length > 10 || provided.some(id => !postId(id)) || (options.searchOnly && provided.length)) return skip("invalid_lookup_ids");
  result.plan = { query, startTime: new Date(now() - 24 * 3600_000).toISOString(), fieldsParameter, searchLimit: 10,
    maxRequests: options.searchOnly ? 1 : 3, maxPostResources: options.searchOnly ? 10 : 30,
    endpoints: options.searchOnly ? [SEARCH] : [SEARCH, LOOKUP] };
  if (!options.live) return result;
  if (!options.useCaseApproved) return skip("use_case_not_approved");
  if (!options.token?.trim()) return skip("bearer_token_missing");
  if (/[\s\u007f]/.test(options.token) || options.token.length > 4096) return skip("bearer_token_invalid");
  const request = dependencies.request ?? fetch;
  const controller = new AbortController(), deadlineAt = Date.now() + DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const observations = new Map<string, XObservation>();
  const checkDeadline = () => { if (controller.signal.aborted || Date.now() >= deadlineAt) throw new PilotFailure("timeout"); };
  const read = async (endpoint: RequestRecord["endpoint"], ids: string[] = []): Promise<Json> => {
    checkDeadline();
    const reserve = endpoint === "recent-search" ? 10 : ids.length;
    if (result.requests.length >= result.plan!.maxRequests || result.reservedPosts + reserve > result.plan!.maxPostResources)
      throw new PilotFailure("invalid_response");
    const url = new URL(endpoint === "recent-search" ? SEARCH : LOOKUP);
    url.searchParams.set(fieldsParameter, FIELDS);
    if (endpoint === "recent-search") {
      url.searchParams.set("query", query); url.searchParams.set("max_results", "10");
      url.searchParams.set("sort_order", "recency"); url.searchParams.set("start_time", result.plan!.startTime);
    } else url.searchParams.set("ids", ids.join(","));
    const record: RequestRecord = { endpoint, reservedPosts: reserve, status: null, outcome: "ok" };
    result.requests.push(record); result.reservedPosts += reserve;
    try {
      const response = await untilAborted(request(url.href, { method: "GET", redirect: "manual", signal: controller.signal,
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json" } }), controller.signal);
      record.status = response.status;
      const delay = retryAfter(response.headers.get("retry-after"), now());
      if (delay !== undefined) record.retryAfterSeconds = delay;
      if (!response.ok) {
        record.outcome = "http";
        void response.body?.cancel().catch(() => {});
        throw new PilotFailure("http_error");
      }
      const value = await readJson(response, controller.signal);
      checkDeadline();
      if (endpoint === "lookup") for (const id of deniedIds(value, ids))
        observations.set(id, observation(id, null, new Date(now()).toISOString(), "unavailable"));
      if ((value.data !== undefined && !Array.isArray(value.data))
        || (value.errors !== undefined && !Array.isArray(value.errors))) throw new PilotFailure("invalid_response");
      const posts = value.data as unknown[] | undefined;
      const validEmpty = !(value.errors as unknown[] | undefined)?.length && (endpoint === "recent-search"
        ? object(value.meta) && value.meta.result_count === 0 : posts !== undefined);
      if (!posts?.length && !validEmpty) throw new PilotFailure("invalid_response");
      if ((posts?.length ?? 0) > reserve || (posts ?? []).some(item => !object(item) || !postId(item.id))) throw new PilotFailure("invalid_response");
      return value;
    } catch (error) {
      const failure = controller.signal.aborted ? "timeout" : error instanceof PilotFailure ? error.reason : "transport_error";
      record.outcome = failure === "http_error" ? "http" : failure;
      throw new PilotFailure(failure);
    }
  };
  const ingest = (value: Json, ids?: string[]) => {
    const found = new Map<string, Json>();
    for (const item of (value.data ?? []) as Json[]) if (!ids || ids.includes(item.id as string)) {
      const id = item.id as string;
      if (!found.has(id)) found.set(id, item);
    }
    const requested = ids ?? [...found.keys()], denied = deniedIds(value, requested);
    for (const id of requested) observations.set(id,
      observation(id, found.get(id) ?? null, new Date(now()).toISOString(), denied.has(id) ? "unavailable" : found.has(id) ? "available" : "unknown"));
  };
  try {
    const searched = await read("recent-search");
    ingest(searched);
    const candidates = [...observations.values()].filter(item => item.availability === "available" && item.repositories.length).map(item => item.id);
    const ids = options.searchOnly ? [] : [...new Set([...provided, ...candidates])];
    for (let offset = 0; offset < ids.length; offset += 10) {
      const batch = ids.slice(offset, offset + 10);
      ingest(await read("lookup", batch), batch);
    }
    result.status = "completed";
  } catch (error) {
    result.status = "stopped";
    result.reason = error instanceof PilotFailure ? error.reason : "invalid_response";
  } finally { clearTimeout(timer); }
  result.observations = [...observations.values()];
  result.summary = summarize(result.observations);
  return result;
}
