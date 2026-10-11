import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRequest, type GithubRequestOptions } from "@/lib/github/client";
import { githubRepositoryPath, isGithubNumericId, parseGithubRepository, parseGithubRepositoryResponse } from "@/lib/github/repositories";

const token = "ghu_test_secret_12345678901234567890";
const issue: GithubRequestOptions = { path: "/repos/owner/repo/issues", token, auth: "installation", method: "POST", body: { title: "Bug report", body: "A reproducible problem" } };
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});
const respond = (response: Response) => { const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch); return fetch; };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("integration transport boundary", () => {
  it.each([null, undefined, "invalid", [], {}])("returns a safe local rejection for malformed runtime options", async options => {
    const fetch = respond(json({}));
    expect(await githubRequest(options as unknown as GithubRequestOptions)).toMatchObject({ outcome: "confirmed_rejection", status: null, code: "github_invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fixes the API origin, version, headers and no-store policy for a personal star", async () => {
    const fetch = respond(new Response(null, { status: 204 }));
    expect(await githubRequest({ path: "/user/starred/Owner/Repo", token, method: "PUT" })).toEqual({
      outcome: "confirmed_success", status: 204, data: null, code: null, retryAt: null, requestId: null,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/user/starred/Owner/Repo");
    expect(init).toMatchObject({ method: "PUT", redirect: "manual", cache: "no-store", headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Length": "0",
    } });
    expect(Object.keys(init.headers).sort()).toEqual(["Accept", "Authorization", "Content-Length", "User-Agent", "X-GitHub-Api-Version"]);
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "https://evil.example/repos/owner/repo", "//evil.example/repos/owner/repo", "/repos/owner/repo#fragment",
    "/repos/owner/../repo", "/repos/owner/%2e%2e/repo", "/repos/owner/%2frepo", "/repos/owner\\repo",
    "/repos/owner/repo?access_token=secret", "/repos/owner/repo?", "/repos/owner/repo\n", "/user/starred/owner/repo/extra",
    "/repositories/0", "/repositories/9007199254740992", "/app/installations/-1", "/repos/owner/repo/issues?page=0",
    "/repos/owner/repo/issues?per_page=101", "/repos/owner/repo/issues?state=bogus", "/repos/owner/repo/issues?page=1&page=2",
  ])("rejects unsafe or unsupported API path %s before dispatch", async path => {
    const fetch = respond(json({}));
    expect(await githubRequest({ path, token })).toMatchObject({ outcome: "confirmed_rejection", status: null, code: "github_invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/user/starred/owner/repo", auth: "installation", method: "PUT" },
    { path: "/user/starred/owner/repo", auth: "app" },
    { path: "/repos/owner/repo/issues", auth: "user", method: "POST", body: issue.body },
    { path: "/repos/owner/repo", method: "DELETE" },
    { path: "/app/installations/12", auth: "user" },
    { path: "/installation/repositories", auth: "user" },
    { path: "/user", method: "PATCH" },
    { path: "/user", headers: { Authorization: "Bearer other" } },
    { path: "/user", token: "bad\r\nInjected: true" },
  ])("rejects an actor, method or header outside the endpoint policy", async input => {
    const fetch = respond(json({}));
    expect(await githubRequest({ token, ...input } as GithubRequestOptions)).toMatchObject({ outcome: "confirmed_rejection", status: null, code: "github_invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { title: "valid", body: "valid", labels: ["unexpected"] }, { title: "valid", body: "valid", assignees: ["somebody"] },
    { title: "", body: "valid" }, { title: "x".repeat(121), body: "valid" },
    { title: "valid", body: "x".repeat(16_001) }, { title: "valid", body: 12 },
  ])("rejects issue payload fields outside the agreed text-only contract", async body => {
    const fetch = respond(json({ id: 10 }, 201));
    expect(await githubRequest({ ...issue, body } as GithubRequestOptions)).toMatchObject({ outcome: "confirmed_rejection", code: "github_invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restricts installation token minting to explicit numeric repositories and Issues permissions", async () => {
    const fetch = respond(json({ token: "ghs_separate_installation_token" }, 201));
    const options: GithubRequestOptions = { path: "/app/installations/12/access_tokens", token, auth: "app", method: "POST",
      body: { repository_ids: [42], permissions: { issues: "write", metadata: "read" } } };
    expect(await githubRequest(options)).toMatchObject({ outcome: "confirmed_success", status: 201 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(options.body);
    for (const body of [undefined, {}, { repository_ids: [0], permissions: { issues: "write" } },
      { repository_ids: [42, 42], permissions: { issues: "write" } }, { repository_ids: [42], permissions: { contents: "write" } }]) {
      expect(await githubRequest({ ...options, body } as GithubRequestOptions)).toMatchObject({ outcome: "confirmed_rejection", code: "github_invalid_request" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: "/repos/owner/repo/issues?state=all&per_page=100&page=2", auth: "installation" },
    { path: "/user/installations?per_page=100&page=2" }, { path: "/user/installations/12/repositories?page=2" },
    { path: "/installation/repositories?per_page=100&page=2", auth: "installation" }, { path: "/app/installations/12", auth: "app" },
  ])("supports bounded reconciliation and installation reads", async input => {
    respond(json({ id: 12 }));
    expect(await githubRequest({ token, ...input } as GithubRequestOptions)).toMatchObject({ outcome: "confirmed_success", status: 200, data: { id: 12 } });
  });
});

describe("transport outcomes", () => {
  it("returns parsed success data while preserving only safe response metadata", async () => {
    respond(json({ id: 10 }, 201, { "x-github-request-id": "1234:ABCD:12", "x-token": token }));
    expect(await githubRequest(issue)).toEqual({ outcome: "confirmed_success", status: 201, data: { id: 10 }, code: null, retryAt: null, requestId: "1234:ABCD:12" });
  });

  it.each([[401, "github_unauthorized"], [403, "github_forbidden"], [404, "github_not_found"], [410, "github_gone"], [422, "github_validation_failed"]])(
    "classifies HTTP %s as a confirmed rejection without disclosing upstream messages", async (status, code) => {
      respond(json({ message: `secret ${token}` }, status as number, { "x-github-request-id": token }));
      const result = await githubRequest(issue);
      expect(result).toEqual({ outcome: "confirmed_rejection", status, code, retryAt: null, requestId: null });
      expect(JSON.stringify(result)).not.toContain(token);
    });

  it.each([403, 429])("honors Retry-After for a confirmed %s rate limit", async status => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    respond(json({ message: "rate limited" }, status, { "retry-after": "120", "x-ratelimit-reset": "1800000180", "x-ratelimit-remaining": "0" }));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "confirmed_rejection", code: "github_rate_limited", retryAt: 1_800_000_180_000 });
  });

  it("recognizes a secondary 403 rate limit without Retry-After and uses a conservative retry time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    respond(json({ message: "You have exceeded a secondary rate limit." }, 403));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "confirmed_rejection", code: "github_rate_limited", retryAt: 1_800_000_060_000 });
  });

  it.each([500, 502, 503])("keeps POST HTTP %s ambiguous and never retries", async status => {
    const fetch = respond(json({ message: token }, status));
    expect(await githubRequest(issue)).toEqual({ outcome: "unknown", status, code: "github_server_error", retryAt: null, requestId: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a network failure ambiguous without exposing its error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`connection lost: ${token}`)); vi.stubGlobal("fetch", fetch);
    expect(await githubRequest(issue)).toEqual({ outcome: "unknown", status: null, code: "github_network_error", retryAt: null, requestId: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds the complete dispatch even if fetch does not cooperate with abort", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    const result = githubRequest({ ...issue, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ outcome: "unknown", code: "github_timeout", status: null });
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("bounds a stalled response body and cancels its stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ pull() {}, cancel }), { status: 201 }));
    const result = githubRequest({ ...issue, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ outcome: "unknown", code: "github_timeout", status: 201 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves a confirmed 403 rejection when its diagnostic body stalls", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ pull() {}, cancel }), { status: 403 }));
    const result = githubRequest({ ...issue, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ outcome: "confirmed_rejection", code: "github_forbidden", status: 403 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["https://evil.example/repos/owner/repo", "https://api.github.com/repositories/42"])("never follows a repository redirect to %s", async location => {
    const fetch = respond(new Response(null, { status: 301, headers: { location } }));
    expect(await githubRequest({ path: "/repos/owner/repo", token })).toMatchObject({ outcome: "confirmed_rejection", code: "github_redirect", status: 301 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay POST after a redirect", async () => {
    const fetch = respond(new Response(null, { status: 307, headers: { location: "https://api.github.com/repositories/42/issues" } }));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "unknown", code: "github_redirect", status: 307 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized declared success body before reading it", async () => {
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ pull() {}, cancel }), { status: 201, headers: { "content-length": String(2 * 1024 * 1024 + 1) } }));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "unknown", code: "github_response_too_large", status: 201 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("limits streamed bytes even with an incorrect Content-Length", async () => {
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array([1]));
    }, cancel }), { status: 201, headers: { "content-length": "1" } }));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "unknown", code: "github_response_too_large", status: 201 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["{broken", "", "<html>failure</html>"])("keeps an unparseable POST response ambiguous", async body => {
    respond(new Response(body, { status: 201 }));
    expect(await githubRequest(issue)).toMatchObject({ outcome: "unknown", code: "github_invalid_json", status: 201 });
  });

  it("does not treat an unexpected star response as a confirmed write", async () => {
    respond(json({}, 200));
    expect(await githubRequest({ path: "/user/starred/owner/repo", method: "PUT", token })).toMatchObject({ outcome: "unknown", code: "github_unexpected_response", status: 200 });
  });
});

describe("repository identity", () => {
  const repository = { id: 42, name: "Repo", full_name: "Owner/Repo", owner: { login: "Owner" },
    html_url: "https://github.com/Owner/Repo", private: false, archived: false, has_issues: true,
    permissions: { admin: true, maintain: false, push: true, pull: true, triage: false } };

  it("parses a public GitHub repository URL and canonicalizes clone suffixes", () => {
    expect(parseGithubRepository("https://github.com/Owner/Repo.git/")).toEqual({ owner: "Owner", repo: "Repo", fullName: "Owner/Repo", htmlUrl: "https://github.com/Owner/Repo" });
    expect(githubRepositoryPath({ owner: "Owner", repo: "Repo" })).toBe("/repos/Owner/Repo");
  });

  it.each(["https://github.com.evil.example/owner/repo", "https://user:secret@github.com/owner/repo", "http://github.com/owner/repo",
    "https://github.com/owner/repo/issues", "https://github.com/owner/repo?token=secret", "https://github.com/owner/repo#readme",
    "https://github.com/owner/%2frepo", "https://github.com/owner/../repo", "https://github.com/-owner/repo",
    "https://github.com/owner/..", "https://github.com/owner/extra/../repo", " https://github.com/owner/repo", "https://github.com/owner/repo\\extra"])("rejects an unsafe repository URL %s", url => {
    expect(parseGithubRepository(url)).toBeNull();
  });

  it("validates numeric identity and canonical metadata before following a renamed repository", () => {
    expect(parseGithubRepositoryResponse(repository, 42)).toEqual({ id: 42, owner: "Owner", repo: "Repo", fullName: "Owner/Repo", htmlUrl: "https://github.com/Owner/Repo",
      private: false, archived: false, hasIssues: true, permissions: { admin: true, maintain: false, push: true } });
    expect(parseGithubRepositoryResponse({ ...repository, name: "Renamed", full_name: "Owner/Renamed", html_url: "https://github.com/Owner/Renamed" }, 42)).toMatchObject({ id: 42, repo: "Renamed" });
    expect(parseGithubRepositoryResponse({ ...repository, id: 43 }, 42)).toBeNull();
  });

  it.each([0, -1, 1.5, "42", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric repository ID %s", id => {
    expect(isGithubNumericId(id)).toBe(false);
    expect(parseGithubRepositoryResponse({ ...repository, id })).toBeNull();
  });

  it.each([
    { full_name: "other/repo" }, { html_url: "https://evil.example/Owner/Repo" }, { private: "false" }, { archived: null },
    { has_issues: undefined }, { owner: { login: "bad/owner" } }, { permissions: { admin: "true" } },
  ])("rejects inconsistent or untyped authoritative repository metadata", changed => {
    expect(parseGithubRepositoryResponse({ ...repository, ...changed }, 42)).toBeNull();
  });
});
