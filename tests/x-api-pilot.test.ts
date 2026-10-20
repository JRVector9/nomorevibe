import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runXPilot } from "@/lib/social/x-pilot";
import { parseXPilotArgs, writeXPilotOutput } from "@/scripts/x-api-pilot";

const at = new Date("2026-10-14T05:00:00Z");
const live = { live: true, useCaseApproved: true, token: "secret-fixture-token" };
const response = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers });
const emptySearch = { meta: { result_count: 0 } };
const post = (id: string, repositories = ["Owner/Repo"]) => ({ id, created_at: "2026-10-14T01:00:00Z", text: "raw-secret-post-text",
  author_id: "raw-secret-author", entities: { urls: repositories.map(repo => ({ expanded_url: `https://github.com/${repo}` })) },
  public_metrics: { like_count: 0, reply_count: 2, retweet_count: 3, quote_count: 4, impression_count: 5, bookmark_count: 6 } });
afterEach(() => vi.useRealTimers());

it("search-only collection reads ten posts once without an immediate lookup", async () => {
  const request = vi.fn().mockImplementation(() => Promise.resolve(response({ data: [post("123")] })));
  const result = await runXPilot({ ...live, searchOnly: true }, { request });
  expect(result).toMatchObject({ status: "completed", reservedPosts: 10,
    plan: { maxRequests: 1, maxPostResources: 10 }, observations: [{ id: "123" }] });
  expect(request).toHaveBeenCalledOnce();
  expect(new URL(request.mock.calls[0][0]).pathname).toBe("/2/tweets/search/recent");
  expect(new URL(request.mock.calls[0][0]).searchParams.get("sort_order")).toBe("recency");
});

it("asks for relevancy order only when selected, and rejects other orders before HTTP", async () => {
  const request = vi.fn().mockImplementation(() => Promise.resolve(response({ data: [post("123")] })));
  const result = await runXPilot({ ...live, searchOnly: true, sortOrder: "relevancy" }, { request });
  expect(result).toMatchObject({ status: "completed", plan: { sortOrder: "relevancy" } });
  expect(new URL(request.mock.calls[0][0]).searchParams.get("sort_order")).toBe("relevancy");
  const other = vi.fn();
  expect(await runXPilot({ ...live, sortOrder: "popular" as "recency" }, { request: other }))
    .toMatchObject({ status: "skipped", reason: "invalid_sort_order", plan: null });
  expect(other).not.toHaveBeenCalled();
});

it("search-only collection rejects supplied lookup IDs before HTTP", async () => {
  const request = vi.fn();
  expect(await runXPilot({ ...live, searchOnly: true, lookupIds: ["123"] }, { request }))
    .toMatchObject({ status: "skipped", reason: "invalid_lookup_ids", requests: [] });
  expect(request).not.toHaveBeenCalled();
});

it("defaults to a zero-HTTP dry-run with a bounded one-page plan", async () => {
  const request = vi.fn();
  const result = await runXPilot({}, { request, now: () => at.getTime() });
  expect(result).toMatchObject({ mode: "dry-run", status: "planned", reservedPosts: 0, requests: [], observations: [], needsLiveValidation: true,
    plan: { maxRequests: 3, maxPostResources: 30, searchLimit: 10, startTime: "2026-10-13T05:00:00.000Z", fieldsParameter: "tweet.fields", sortOrder: "recency" } });
  expect(request).not.toHaveBeenCalled();
});

it.each([
  [{ live: true, token: "fixture" }, "use_case_not_approved"],
  [{ live: true, useCaseApproved: true }, "bearer_token_missing"],
  [{ ...live, token: "bad\nheader" }, "bearer_token_invalid"],
] as const)("skips a live run when its gate is incomplete: %s", async (options, reason) => {
  const request = vi.fn();
  expect(await runXPilot(options, { request })).toMatchObject({ status: "skipped", reason, requests: [] });
  expect(request).not.toHaveBeenCalled();
});

it.each([
  [{ query: "x".repeat(513) }, "invalid_query"],
  [{ query: "" }, "invalid_query"],
  [{ lookupIds: ["https://attacker.test"] }, "invalid_lookup_ids"],
  [{ lookupIds: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, "invalid_lookup_ids"],
  [{ fieldsParameter: "author.fields" as "tweet.fields" }, "invalid_fields_parameter"],
] as const)("rejects invalid options before HTTP: %s", async (options, reason) => {
  const request = vi.fn();
  expect(await runXPilot({ ...live, ...options }, { request })).toMatchObject({ status: "skipped", reason, plan: null });
  expect(request).not.toHaveBeenCalled();
});

it.each(["tweet.fields", "post.fields"] as const)("uses only the explicitly selected %s spelling", async fieldsParameter => {
  const request = vi.fn().mockResolvedValue(response(emptySearch));
  const result = await runXPilot({ ...live, fieldsParameter, query: "url:github.com launch" }, { request, now: () => at.getTime() });
  const [destination, init] = request.mock.calls[0];
  const url = new URL(destination);
  expect(url.origin + url.pathname).toBe("https://api.x.com/2/tweets/search/recent");
  expect(url.searchParams.get(fieldsParameter)).toBe("id,created_at,entities,public_metrics,withheld");
  expect(url.searchParams.has(fieldsParameter === "tweet.fields" ? "post.fields" : "tweet.fields")).toBe(false);
  expect(url.searchParams.get("max_results")).toBe("10");
  expect(url.searchParams.get("query")).toBe("(url:github.com launch) -is:retweet");
  expect(url.searchParams.has("next_token")).toBe(false);
  expect(init).toMatchObject({ redirect: "manual", headers: { authorization: "Bearer secret-fixture-token" } });
  expect(result).toMatchObject({ status: "completed", reservedPosts: 10, needsLiveValidation: true });
});

it.each([{}, { errors: [{ detail: "raw-secret-error" }] }, { data: [] },
  { meta: { result_count: 0 }, errors: [{ detail: "raw-secret-error" }] }])(
  "review regression: rejects HTTP 200 search responses without a successful endpoint structure: %s", async value => {
    const request = vi.fn().mockResolvedValue(response(value));
    const result = await runXPilot(live, { request });
    expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", observations: [] });
    expect(result.requests[0]).toMatchObject({ status: 200, outcome: "invalid_response" });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("raw-secret-error");
  });

it.each([{}, { errors: [{ resource_id: "123", type: "https://api.x.com/2/problems/resource-not-found" }] }])(
  "review regression: rejects HTTP 200 lookup responses without successful data: %s", async value => {
    const request = vi.fn().mockResolvedValueOnce(response(emptySearch)).mockResolvedValueOnce(response(value));
    const result = await runXPilot({ ...live, lookupIds: ["123"] }, { request });
    expect(result).toMatchObject({ status: "stopped", reason: "invalid_response" });
    expect(result.observations).toEqual("errors" in value
      ? [expect.objectContaining({ id: "123", availability: "unavailable", repositories: [], linkStatus: "none" })] : []);
    expect(result.requests[1]).toMatchObject({ status: 200, outcome: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(2);
  });

it.each([emptySearch, { ...emptySearch, data: [] }])(
  "review regression: accepts valid empty search metadata without assuming access or deletion: %s", async value => {
    const request = vi.fn().mockResolvedValue(response(value));
    expect(await runXPilot(live, { request })).toMatchObject({ status: "completed", observations: [] });
    expect(request).toHaveBeenCalledOnce();
  });

it("review regression: preserves legitimate partial search data while discarding error details", async () => {
  const request = vi.fn().mockResolvedValue(response({ data: [post("123", [])], errors: [{ detail: "raw-secret-error" }] }));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "completed", observations: [{ id: "123", availability: "available" }] });
  expect(JSON.stringify(result)).not.toContain("raw-secret-error");
  expect(request).toHaveBeenCalledOnce();
});

it.each(["resource-not-found", "not-authorized-for-resource", "disallowed-resource", "resource-unavailable"])(
  "review regression: clears searched metrics and links when an errors-only lookup explicitly reports %s", async type => {
    const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response({
      errors: [{ resource_id: "123", type: `https://api.x.com/2/problems/${type}`, detail: "raw-secret-error" }],
    }));
    const result = await runXPilot(live, { request });
    expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", reservedPosts: 11,
      observations: [{ id: "123", availability: "unavailable", repositories: [], linkStatus: "none" }] });
    expect(Object.values(result.observations[0].metrics)).toEqual([null, null, null, null, null, null]);
    expect(result.requests[1]).toMatchObject({ status: 200, outcome: "invalid_response" });
    expect(JSON.stringify(result)).not.toMatch(/raw-secret|deleted|detail/);
    expect(request).toHaveBeenCalledTimes(2);
  });

it("review regression: generic errors cannot establish resource unavailability", async () => {
  const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response({
    errors: [{ resource_id: "123", type: "https://api.x.com/2/problems/upstream-error", detail: "raw-secret-error" }],
  }));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "invalid_response" });
  expect(result.observations[0].availability).not.toBe("unavailable");
  expect(JSON.stringify(result)).not.toMatch(/raw-secret|deleted|detail/);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["search", "lookup"] as const)("review regression: denial dominates duplicate %s IDs in either order", async endpoint => {
  for (const marker of [{ withheld: { country_codes: ["US"] } }, { access: "unavailable" }, { unavailable: true }]) {
    const normal = post("123"), denied = { ...normal, ...marker };
    for (const data of [[normal, denied], [denied, normal]]) {
      const request = endpoint === "search" ? vi.fn().mockResolvedValueOnce(response({ data })).mockResolvedValueOnce(response({ data: [normal] }))
        : vi.fn().mockResolvedValueOnce(response(emptySearch)).mockResolvedValueOnce(response({ data }));
      const result = await runXPilot({ ...live, lookupIds: endpoint === "lookup" ? ["123", "456"] : [] }, { request });
      expect(result.status).toBe("completed");
      const found = result.observations.find(item => item.id === "123")!;
      expect(found).toMatchObject({ availability: "unavailable", repositories: [], linkStatus: "none" });
      expect(Object.values(found.metrics)).toEqual([null, null, null, null, null, null]);
      expect(request).toHaveBeenCalledTimes(endpoint === "search" ? 1 : 2);
    }
  }
});

it.each([
  [{ withheld: { country_codes: ["US"] } }, false], [{ withheld: { country_codes: ["US"] } }, true],
  [{ access: "unavailable" }, false], [{ access: "unavailable" }, true],
  [{ unavailable: true }, false], [{ unavailable: true }, true],
] as const)("round2 regression: one-ID excess duplicate applies denial %s with denied-first=%s", async (marker, deniedFirst) => {
  const normal = post("123"), denied = { ...normal, ...marker };
  const request = vi.fn().mockResolvedValueOnce(response({ data: [normal] }))
    .mockResolvedValueOnce(response({ data: deniedFirst ? [denied, normal] : [normal, denied] }));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", reservedPosts: 11,
    observations: [{ id: "123", availability: "unavailable", repositories: [], linkStatus: "none" }] });
  expect(Object.values(result.observations[0].metrics)).toEqual([null, null, null, null, null, null]);
  expect(result.requests.map(item => item.reservedPosts)).toEqual([10, 1]);
  expect(result.requests[1]).toMatchObject({ status: 200, outcome: "invalid_response" });
  expect(new URL(request.mock.calls[1][0]).searchParams.get("ids")).toBe("123");
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["resource-not-found", "not-authorized-for-resource", "disallowed-resource", "resource-unavailable"])(
  "round2 regression: requested-ID %s denial survives excess rows and ignores unsolicited IDs", async type => {
    const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response({
      data: [post("123"), { ...post("456"), withheld: { country_codes: ["US"] } }],
      errors: [{ resource_id: "123", type: `https://api.x.com/2/problems/${type}`, detail: "raw-secret-error" },
        { resource_id: "789", type: "https://api.x.com/2/problems/resource-not-found" }],
    }));
    const result = await runXPilot(live, { request });
    expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", reservedPosts: 11 });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ id: "123", availability: "unavailable", repositories: [], linkStatus: "none" });
    expect(Object.values(result.observations[0].metrics)).toEqual([null, null, null, null, null, null]);
    expect(JSON.stringify(result)).not.toMatch(/raw-secret|deleted|detail/);
    expect(request).toHaveBeenCalledTimes(2);
  });

it.each([
  { data: "invalid", errors: [{ resource_id: "123", type: "https://api.x.com/2/problems/resource-not-found" }] },
  { data: [null], errors: [{ resource_id: "123", type: "https://api.x.com/2/problems/resource-not-found" }] },
  { data: [{ ...post("123"), withheld: { country_codes: ["US"] } }], errors: "invalid" },
])("round2 regression: a parsed malformed lookup preserves recognized requested-ID denial: %s", async value => {
  const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response(value));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", reservedPosts: 11,
    observations: [{ id: "123", availability: "unavailable", repositories: [], linkStatus: "none" }] });
  expect(Object.values(result.observations[0].metrics)).toEqual([null, null, null, null, null, null]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("round2 regression: unsolicited denial and generic errors cannot deny the requested ID", async () => {
  const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response({
    data: [post("123"), { ...post("456"), unavailable: true }],
    errors: [{ resource_id: "123", type: "https://api.x.com/2/problems/upstream-error" },
      { resource_id: "789", type: "https://api.x.com/2/problems/resource-not-found" }],
  }));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "invalid_response", reservedPosts: 11 });
  expect(result.observations.map(item => [item.id, item.availability])).toEqual([["123", "available"]]);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["url:github.com (launch -is:retweet OR is:retweet)", "url:github.com launch -is:retweet"])(
  "review regression: applies a global repost filter outside the complete query: %s", async query => {
    const request = vi.fn().mockResolvedValue(response(emptySearch));
    const result = await runXPilot({ ...live, query }, { request });
    expect(new URL(request.mock.calls[0][0]).searchParams.get("query")).toBe(`(${query}) -is:retweet`);
    expect(result.status).toBe("completed");
    expect(request).toHaveBeenCalledOnce();
  });

it("review regression: includes the complete query wrapper and global filter in the 512-character limit", async () => {
  const request = vi.fn(), query = "x".repeat(512 - "() -is:retweet".length);
  const accepted = await runXPilot({ query }, { request });
  expect(accepted.status).toBe("planned");
  expect(accepted.plan!.query).toHaveLength(512);
  expect(await runXPilot({ ...live, query: query + "x" }, { request })).toMatchObject({ status: "skipped", reason: "invalid_query" });
  expect(request).not.toHaveBeenCalled();
});

it("reserves repeated post reads conservatively and never exceeds three requests or thirty resources", async () => {
  const found = Array.from({ length: 10 }, (_, i) => post(String(i + 1)));
  const request = vi.fn().mockResolvedValueOnce(response({ data: found, meta: { next_token: "ignored" } }))
    .mockResolvedValueOnce(response({ data: Array.from({ length: 10 }, (_, i) => post(String(i + 11))) }))
    .mockResolvedValueOnce(response({ data: found }));
  const result = await runXPilot({ ...live, lookupIds: Array.from({ length: 10 }, (_, i) => String(i + 11)) }, { request });
  expect(request).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ status: "completed", reservedPosts: 30 });
  expect(result.requests.map(item => item.reservedPosts)).toEqual([10, 10, 10]);
  for (const [destination] of request.mock.calls.slice(1)) {
    const url = new URL(destination);
    expect(url.origin + url.pathname).toBe("https://api.x.com/2/tweets");
    expect(url.searchParams.get("ids")!.split(",")).toHaveLength(10);
  }
  expect(result.observations).toHaveLength(20);
  expect(JSON.stringify(result)).not.toMatch(/raw-secret|secret-fixture-token|author_id|next_token/);
});

it("extracts only exact trusted entity destinations and marks multi-repository posts ambiguous", async () => {
  const value = post("123", []);
  value.entities.urls = [
    { expanded_url: "https://github.com/OWNER/Repo" }, { expanded_url: "https://github.com/owner/repo.git" },
    { expanded_url: "https://github.com/other/tool/issues/1" }, { expanded_url: "https://github.com.evil.test/steal/token" },
    { expanded_url: "https://github.com@evil.test/steal/token" }, { expanded_url: "https://name:password@github.com/owner/private" },
    { expanded_url: "https://github.com/search?q=repo" }, { expanded_url: "https://github.com/features/actions" },
  ];
  const request = vi.fn().mockImplementation(async () => response({ data: [value] }));
  const result = await runXPilot(live, { request });
  expect(result.status).toBe("completed");
  expect(result.observations[0]).toMatchObject({ id: "123", repositories: ["other/tool", "owner/repo"], linkStatus: "ambiguous" });
  expect(result.summary.ambiguousRepoPosts).toBe(1);
  expect(request).toHaveBeenCalledTimes(2);
});

it("accepts an unwound entity URL without reading post text or fetching its destination", async () => {
  const value = { ...post("123", []), text: "https://github.com/text/ignored",
    entities: { urls: [{ url: "https://t.co/ignored", expanded_url: "https://landing.test", unwound_url: "https://github.com/Owner/Repo" }] } };
  const request = vi.fn().mockImplementation(async () => response({ data: [value] }));
  const result = await runXPilot(live, { request });
  expect(result.observations[0].repositories).toEqual(["owner/repo"]);
  expect(request.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["api.x.com", "api.x.com"]);
});

it("clears a previous link and metrics when the latest lookup omits the searched candidate", async () => {
  const request = vi.fn().mockResolvedValueOnce(response({ data: [post("123")] })).mockResolvedValueOnce(response({ data: [] }));
  const result = await runXPilot(live, { request });
  expect(result.observations[0]).toMatchObject({ id: "123", availability: "unknown", repositories: [], metrics: { like_count: null } });
  expect(result.status).toBe("completed");
});

it("distinguishes a missing public metric from an observed zero and rejects invalid numbers", async () => {
  const request = vi.fn().mockResolvedValue(response({ data: [{ id: "123", public_metrics: { like_count: 0, reply_count: -1, quote_count: "5" } }] }));
  const result = await runXPilot(live, { request });
  expect(result.observations[0].metrics).toEqual({ like_count: 0, reply_count: null, retweet_count: null,
    quote_count: null, impression_count: null, bookmark_count: null });
  expect(result.summary).toMatchObject({ metricsComplete: 0, metricsPartial: 1 });
});

it("deduplicates IDs and treats withheld data as unavailable without retaining metrics or links", async () => {
  const request = vi.fn().mockResolvedValue(response({ data: [{ ...post("123"), withheld: { country_codes: ["US"] } }, post("123")] }));
  const result = await runXPilot(live, { request });
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]).toMatchObject({ availability: "unavailable", repositories: [], linkStatus: "none", metrics: { like_count: null } });
  expect(request).toHaveBeenCalledOnce();
});

it("preserves explicit lookup unavailability separately from omitted unknown IDs", async () => {
  const request = vi.fn().mockResolvedValueOnce(response(emptySearch)).mockResolvedValueOnce(response({ data: [post("1", [])],
    errors: [{ resource_id: "2", type: "https://api.x.com/2/problems/resource-not-found", detail: "raw-secret-error" }] }));
  const result = await runXPilot({ ...live, lookupIds: ["1", "2", "3", "3"] }, { request });
  expect(result.observations).toHaveLength(3);
  expect(Object.fromEntries(result.observations.map(item => [item.id, item.availability])))
    .toEqual({ "1": "available", "2": "unavailable", "3": "unknown" });
  expect(JSON.stringify(result)).not.toMatch(/raw-secret-error|deleted|detail/);
});

it.each([302, 400, 401, 403, 429, 500])("stops on HTTP %s without retry, redirects, parameter fallback, or raw errors", async status => {
  const request = vi.fn().mockResolvedValue(response({ detail: "raw-secret-error" }, status,
    { "retry-after": "999999999", location: "https://attacker.test", "x-rate-limit-reset": "9999999999" }));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "http_error", reservedPosts: 10 });
  expect(result.requests[0]).toMatchObject({ status, outcome: "http", retryAfterSeconds: 86400 });
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toMatch(/raw-secret|attacker|detail|secret-fixture-token/);
});

it("records a future HTTP-date Retry-After with a bounded estimate", async () => {
  const request = vi.fn().mockResolvedValue(response({}, 429, { "retry-after": new Date(at.getTime() + 60_000).toUTCString() }));
  const result = await runXPilot(live, { request, now: () => at.getTime() });
  expect(result.requests[0].retryAfterSeconds).toBe(60);
});

it("bounds response bytes before parsing or retaining a hostile body", async () => {
  const request = vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "body_too_large", observations: [] });
  expect(request).toHaveBeenCalledOnce();
});

it("enforces one absolute deadline even when response body reading hangs", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const request = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })));
  const pending = runXPilot(live, { request });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toMatchObject({ status: "stopped", reason: "timeout" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
});

it("redacts transport exception details", async () => {
  const request = vi.fn().mockRejectedValue(new Error("secret-fixture-token raw-secret-error"));
  const result = await runXPilot(live, { request });
  expect(result).toMatchObject({ status: "stopped", reason: "transport_error" });
  expect(JSON.stringify(result)).not.toMatch(/secret-fixture|raw-secret/);
});

it("rejects malformed or over-limit API responses without further calls", async () => {
  for (const value of ["not-json", JSON.stringify({ data: "invalid" }), JSON.stringify({ data: Array.from({ length: 11 }, (_, i) => post(String(i + 1))) })]) {
    const request = vi.fn().mockResolvedValue(new Response(value));
    expect(await runXPilot(live, { request })).toMatchObject({ status: "stopped", reason: "invalid_response" });
    expect(request).toHaveBeenCalledOnce();
  }
});

it("parses explicit CLI gates, lookup IDs, field spelling, and output without credential arguments", () => {
  expect(parseXPilotArgs([])).toEqual({ live: false, useCaseApproved: false, fieldsParameter: "tweet.fields", lookupIds: [] });
  expect(parseXPilotArgs(["--live", "--use-case-approved", "--fields-parameter", "post.fields", "--lookup-ids", "1,2", "--output", "/private/tmp/observation.json"]))
    .toEqual({ live: true, useCaseApproved: true, fieldsParameter: "post.fields", lookupIds: ["1", "2"], output: "/private/tmp/observation.json" });
  for (const args of [["--token", "secret"], ["--fields-parameter", "bad"], ["--live", "--live"], ["--output"], ["--endpoint", "https://attacker.test"]])
    expect(() => parseXPilotArgs(args)).toThrow("Usage:");
});

it("exclusively creates a mode-0600 optional observation file and preserves an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomorevibe-x-pilot-test-"));
  const path = join(directory, "observations.json");
  const result = await runXPilot({});
  await writeXPilotOutput(path, result);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
  await expect(writeXPilotOutput(path, result)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
});
