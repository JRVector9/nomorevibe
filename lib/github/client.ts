import { isGithubNumericId, isGithubRepositoryName } from "./repositories";

export type GithubAuthKind = "user" | "installation" | "app" | "public";
export type GithubMethod = "GET" | "POST" | "PUT" | "DELETE";
export type GithubRequestBody =
  | { title: string; body: string }
  | { repository_ids: number[]; permissions: { issues: "write"; metadata?: "read" } };
export type GithubRequestOptions = {
  path: string;
  token?: string;
  auth?: GithubAuthKind;
  method?: GithubMethod;
  body?: GithubRequestBody;
  timeoutMs?: number;
};
export type GithubErrorCode =
  | "github_invalid_request" | "github_unauthorized" | "github_rate_limited"
  | "github_forbidden" | "github_not_found" | "github_gone" | "github_validation_failed"
  | "github_redirect" | "github_server_error" | "github_timeout" | "github_network_error"
  | "github_invalid_json" | "github_response_too_large" | "github_unexpected_response";
type GithubMetadata = { status: number | null; retryAt: number | null; requestId: string | null; redirectRepositoryId?: number };
export type GithubResult<T> =
  | (GithubMetadata & { outcome: "confirmed_success"; code: null; data: T | null })
  | (GithubMetadata & { outcome: "confirmed_rejection" | "unknown"; code: GithubErrorCode });

const API_ORIGIN = "https://api.github.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10_000;
type Endpoint = { expectedStatus: number; body: "none" | "issue" | "installation"; list?: "issues" | "repositories" };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)); }
function numericSegment(value: string) { return /^[1-9]\d*$/.test(value) && isGithubNumericId(Number(value)); }

function endpointFor(path: string, method: GithubMethod, auth: GithubAuthKind): Endpoint | null {
  // Validate the raw path before URL parsing can normalize it. Only ASCII endpoint segments are accepted.
  if (!path.startsWith("/") || /[\\\x00-\x20%#]/.test(path)) return null;
  const [pathname, query, extra] = path.split("?");
  if (extra !== undefined || query === "") return null;
  const parts = pathname.split("/").slice(1);
  if (auth === "public" && (method !== "GET" || query !== undefined
    || !(parts[0] === "repos" && parts.length === 3 && isGithubRepositoryName(parts[1], parts[2]))
      && !(parts[0] === "repositories" && parts.length === 2 && numericSegment(parts[1])))) return null;
  let endpoint: Endpoint | null = null;
  if (parts[0] === "repos" && parts.length >= 3 && isGithubRepositoryName(parts[1], parts[2])) {
    if (parts.length === 3 && method === "GET" && auth !== "app") endpoint = { expectedStatus: 200, body: "none" };
    if (parts[3] === "issues" && auth !== "app") {
      if (parts.length === 4 && method === "GET") endpoint = { expectedStatus: 200, body: "none", list: "issues" };
      if (parts.length === 4 && method === "POST" && auth === "installation") endpoint = { expectedStatus: 201, body: "issue" };
      if (parts.length === 5 && numericSegment(parts[4]) && method === "GET") endpoint = { expectedStatus: 200, body: "none" };
    }
  } else if (parts[0] === "repositories" && parts.length === 2 && numericSegment(parts[1]) && method === "GET" && auth !== "app") {
    endpoint = { expectedStatus: 200, body: "none" };
  } else if (parts[0] === "user" && auth === "user") {
    if (parts.length === 1 && method === "GET") endpoint = { expectedStatus: 200, body: "none" };
    if (parts.length === 4 && parts[1] === "starred" && isGithubRepositoryName(parts[2], parts[3]) && ["GET", "PUT", "DELETE"].includes(method)) {
      endpoint = { expectedStatus: 204, body: "none" };
    }
    if (method === "GET" && parts[1] === "installations" && (parts.length === 2 || (parts.length === 4 && numericSegment(parts[2]) && parts[3] === "repositories"))) {
      endpoint = { expectedStatus: 200, body: "none", list: "repositories" };
    }
  } else if (pathname === "/installation/repositories" && method === "GET" && auth === "installation") {
    endpoint = { expectedStatus: 200, body: "none", list: "repositories" };
  } else if (parts[0] === "app" && auth === "app") {
    if (parts.length === 1 && method === "GET") endpoint = { expectedStatus: 200, body: "none" };
    if (parts[1] === "installations" && numericSegment(parts[2] ?? "")) {
      if (parts.length === 3 && method === "GET") endpoint = { expectedStatus: 200, body: "none" };
      if (parts.length === 4 && parts[3] === "access_tokens" && method === "POST") endpoint = { expectedStatus: 201, body: "installation" };
    }
  }
  if (!endpoint || (query !== undefined && !endpoint.list)) return null;
  if (query !== undefined) {
    const seen = new Set<string>();
    for (const [key, value] of new URLSearchParams(query)) {
      if (seen.has(key)) return null;
      seen.add(key);
      if (key === "page" && numericSegment(value)) continue;
      if (key === "per_page" && numericSegment(value) && Number(value) <= 100) continue;
      if (key === "state" && endpoint.list === "issues" && ["open", "closed", "all"].includes(value)) continue;
      return null;
    }
  }
  return endpoint;
}

function validBody(value: unknown, endpoint: Endpoint): boolean {
  if (endpoint.body === "none") return value === undefined;
  if (!record(value)) return false;
  if (endpoint.body === "issue") {
    return onlyKeys(value, ["title", "body"]) && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120
      && typeof value.body === "string" && value.body.trim().length > 0 && value.body.length <= 16_000;
  }
  return onlyKeys(value, ["repository_ids", "permissions"]) && Array.isArray(value.repository_ids)
    && value.repository_ids.length > 0 && value.repository_ids.length <= 100 && value.repository_ids.every(isGithubNumericId)
    && new Set(value.repository_ids).size === value.repository_ids.length && record(value.permissions)
    && onlyKeys(value.permissions, ["issues", "metadata"]) && value.permissions.issues === "write"
    && (value.permissions.metadata === undefined || value.permissions.metadata === "read");
}

function retryTime(headers: Headers): number | null {
  const retry = headers.get("retry-after"), reset = headers.get("x-ratelimit-reset");
  const candidates: number[] = [];
  if (retry !== null) {
    const time = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
    if (Number.isSafeInteger(time)) candidates.push(time);
  }
  if (headers.get("x-ratelimit-remaining") === "0" && reset !== null && /^\d+$/.test(reset)) {
    const time = Number(reset) * 1000;
    if (Number.isSafeInteger(time)) candidates.push(time);
  }
  return candidates.length ? Math.max(Date.now(), ...candidates) : null;
}

async function readJson(response: Response, signal: AbortSignal): Promise<{ data: unknown } | { code: "github_response_too_large" | "github_invalid_json" }> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    return { code: "github_response_too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { code: "github_invalid_json" };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancel(); return { code: "github_response_too_large" }; }
      chunks.push(value);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
      return { data: JSON.parse(text) as unknown };
    } catch { return { code: "github_invalid_json" }; }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** No credential discovery, automatic retries or redirects. An unknown write requires reconciliation. */
export async function githubRequest<T>(options: GithubRequestOptions): Promise<GithubResult<T>> {
  let metadata: GithubMetadata = { status: null, retryAt: null, requestId: null };
  const failure = (outcome: "confirmed_rejection" | "unknown", code: GithubErrorCode): GithubResult<T> => ({ ...metadata, outcome, code });
  // Reading optional diagnostic text cannot undo an already received HTTP rejection.
  const interrupted = (code: "github_timeout" | "github_network_error") => metadata.status === 403
    ? failure("confirmed_rejection", "github_forbidden") : failure("unknown", code);
  let endpoint: Endpoint | null, body: string | undefined;
  let method: GithubMethod, auth: GithubAuthKind;
  try {
    if (!record(options) || !onlyKeys(options, ["path", "token", "auth", "method", "body", "timeoutMs"])) return failure("confirmed_rejection", "github_invalid_request");
    method = options.method ?? "GET"; auth = options.auth ?? "user";
    if (typeof options.path !== "string" || (auth === "public" ? options.token !== undefined
      : typeof options.token !== "string" || !/^[A-Za-z0-9_.-]{20,4096}$/.test(options.token))
      || !["GET", "POST", "PUT", "DELETE"].includes(method) || !["user", "installation", "app", "public"].includes(auth)
      || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))) return failure("confirmed_rejection", "github_invalid_request");
    endpoint = endpointFor(options.path, method, auth);
    if (!endpoint || !validBody(options.body, endpoint)) return failure("confirmed_rejection", "github_invalid_request");
    body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && Buffer.byteLength(body) > 64 * 1024) return failure("confirmed_rejection", "github_invalid_request");
  } catch { return failure("confirmed_rejection", "github_invalid_request"); }
  const headers: Record<string, string> = { Accept: "application/vnd.github+json",
    "User-Agent": "NoMoreVibe/1.0", "X-GitHub-Api-Version": "2026-03-10" };
  if (auth !== "public") headers.Authorization = `Bearer ${options.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if ((method === "PUT" || method === "DELETE") && body === undefined) headers["Content-Length"] = "0";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<GithubResult<T>>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(interrupted("github_timeout")); }, Math.max(1, Math.min(options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS)));
  });
  const dispatch = async (): Promise<GithubResult<T>> => {
    const response = await fetch(`${API_ORIGIN}${options.path}`, { method, headers, body, redirect: "manual", signal: controller.signal, cache: "no-store" });
    const requestId = response.headers.get("x-github-request-id");
    metadata = { status: response.status, retryAt: null, requestId: requestId && /^[A-Fa-f0-9:]{1,100}$/.test(requestId) ? requestId : null };
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return failure("unknown", "github_timeout"); }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      if (method === "GET" && /^\/repos\/[^/]+\/[^/?]+$/.test(options.path)) {
        const destination = /^(?:https:\/\/api\.github\.com)?\/repositories\/([1-9]\d*)$/.exec(response.headers.get("location") ?? "");
        const repositoryId = destination && Number(destination[1]);
        if (isGithubNumericId(repositoryId)) metadata.redirectRepositoryId = repositoryId;
      }
      return failure(method === "GET" ? "confirmed_rejection" : "unknown", "github_redirect");
    }
    if (response.status >= 500 || response.status === 408) {
      void response.body?.cancel().catch(() => {});
      return failure("unknown", "github_server_error");
    }
    if (response.status >= 400) {
      let rateLimited = response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"));
      if (response.status === 403 && !rateLimited) {
        const parsed = await readJson(response, controller.signal);
        const message = "data" in parsed && record(parsed.data) ? parsed.data.message : undefined;
        rateLimited = typeof message === "string" && /secondary rate limit|abuse detection/i.test(message);
      } else { void response.body?.cancel().catch(() => {}); }
      if (rateLimited) { metadata.retryAt = retryTime(response.headers) ?? Date.now() + 60_000; return failure("confirmed_rejection", "github_rate_limited"); }
      const codes: Record<number, GithubErrorCode> = { 401: "github_unauthorized", 403: "github_forbidden", 404: "github_not_found", 410: "github_gone", 422: "github_validation_failed" };
      return failure("confirmed_rejection", codes[response.status] ?? "github_unexpected_response");
    }
    if (response.status !== endpoint.expectedStatus) {
      void response.body?.cancel().catch(() => {});
      return failure("unknown", "github_unexpected_response");
    }
    if (response.status === 204) return { ...metadata, outcome: "confirmed_success", code: null, data: null };
    const parsed = await readJson(response, controller.signal);
    if ("code" in parsed) return failure("unknown", parsed.code);
    return { ...metadata, outcome: "confirmed_success", code: null, data: parsed.data as T };
  };
  try {
    return await Promise.race([dispatch().catch(() => interrupted(controller.signal.aborted ? "github_timeout" : "github_network_error")), deadline]);
  } finally { clearTimeout(timer); }
}
