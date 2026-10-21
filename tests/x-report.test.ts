import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXPostsReport, signXPosts } from "@/lib/operations/x-posts";
import { signXQuery } from "@/lib/operations/x-query";
import { parseXStatusReport, signXStatus } from "@/lib/operations/x-status";
import { runXCollector, X_COLLECTOR_QUERY } from "@/lib/social/x-collector";
import { xSearchQuery, type XObservation } from "@/lib/social/x-pilot";
import { sendSigned, xPostsReportFrom, xStatusReportFrom } from "@/lib/social/x-report";

const SECRET = "x-status-current-secret-0123456789abcdef";
const report = { secret: SECRET, statusUrl: "https://nomorevibe.test/api/ops/x-status", postsUrl: "https://nomorevibe.test/api/ops/x-posts", queryUrl: null };
const instant = Date.parse("2026-10-15T04:00:00Z"), observedAt = new Date(instant).toISOString();
const metrics = { like_count: 10, reply_count: 2, retweet_count: 3, quote_count: 4 };
const observed = { ...metrics, impression_count: null, bookmark_count: null };
const observation = (id: string, patch: Partial<XObservation> = {}): XObservation => ({ id, createdAt: "2026-10-15T01:00:00Z", observedAt,
  availability: "available", repositories: ["Owner/Skill-Repo"], linkStatus: "single", metrics: observed, ...patch });
const post = (id = "123", repos = ["owner/skill-repo"]) => ({ id, created_at: "2026-10-15T01:00:00Z",
  text: "private-raw-text", author_id: "private-author", entities: { urls: repos.map(repo => ({ expanded_url: `https://github.com/${repo}` })) },
  public_metrics: metrics });

type Sent = { url: string; body: string; timestamp: number; signature: string };
function recorder(status = 200) {
  const sent: Sent[] = [];
  const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), body: String(init?.body), timestamp: Number(headers.get("x-nmv-timestamp")), signature: headers.get("x-nmv-signature") ?? "" });
    return new Response(null, { status });
  });
  return { sent, send: send as unknown as typeof fetch };
}

describe("보고 만들기", () => {
  it("게시물 보고는 저장소 하나·반응 네 칸이 다 있는 공개 글만, 사용 불가는 ID만 담는다", () => {
    const payload = xPostsReportFrom([
      observation("123"),
      observation("124", { linkStatus: "ambiguous", repositories: ["a/b", "c/d"] }),
      observation("125", { metrics: { ...observed, quote_count: null } }),
      observation("126", { availability: "unavailable", repositories: [], linkStatus: "none" }),
      observation("127", { availability: "unknown" }),
      observation("128", { createdAt: null }),
      observation("123"),
    ], observedAt);
    expect(payload).toEqual({ v: 1, observedAt, unavailable: ["126"],
      posts: [{ id: "123", createdAt: "2026-10-15T01:00:00.000Z", repository: "Owner/Skill-Repo", metrics: { like: 10, reply: 2, repost: 3, quote: 4 } }] });
    expect(JSON.stringify(payload)).not.toMatch(/private/);
    expect(parseXPostsReport(payload, Math.floor(instant / 1000))).toEqual(payload);
  });

  it("하루 상태는 예약 장부로 읽기 수를, 하루 한도 도달은 오류로 보지 않는다", () => {
    const base = { live: true, candidates: 3, lastRunAt: observedAt, lastSuccessAt: observedAt } as const;
    expect(xStatusReportFrom({ ...base, status: "completed", reservedToday: true }))
      .toEqual({ v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 3, lastRunAt: observedAt, lastSuccessAt: observedAt, error: null });
    expect(xStatusReportFrom({ ...base, status: "blocked", reason: "daily_limit", reservedToday: true }).error).toBeNull();
    expect(xStatusReportFrom({ ...base, status: "stopped", reason: "http_error", reservedToday: true }).error).toBe("http_error");
    expect(xStatusReportFrom({ ...base, status: "blocked", reason: "Not A Code", reservedToday: false }))
      .toMatchObject({ error: "unknown", reads: { used: 0 } });
    expect(xStatusReportFrom({ ...base, live: false, status: "planned", reservedToday: false })).toMatchObject({ mode: "dry-run", error: null });
  });

  it("보내기는 응답 코드나 실패 종류만 돌려준다", async () => {
    const sign = (timestamp: number, body: string) => signXStatus(SECRET, timestamp, body);
    expect(await sendSigned(report.statusUrl, sign, {}, recorder(429).send)).toBe(429);
    expect(await sendSigned(report.statusUrl, sign, {}, vi.fn().mockRejectedValue(new Error("private-token")))).toBe("network");
    const timeout = Object.assign(new Error("slow"), { name: "TimeoutError" });
    expect(await sendSigned(report.statusUrl, sign, {}, vi.fn().mockRejectedValue(timeout))).toBe("timeout");
  });
});

describe("수집기가 보고를 보낸다", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "x-report-")); });
  afterEach(() => vi.restoreAllMocks());
  const options = () => ({ stateDir, live: true, useCaseApproved: true, token: "private-token", now: () => instant, report });
  const status = async () => JSON.parse(await readFile(join(stateDir, "status.json"), "utf8"));

  it("실제 수집이 끝나면 게시물과 하루 상태를 각자의 서명으로 보낸다", async () => {
    const { sent, send } = recorder();
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [post()] })));
    expect(await runXCollector(options(), { request, send })).toMatchObject({ status: "completed" });
    expect(sent.map(item => item.url)).toEqual([report.postsUrl, report.statusUrl]);
    const [posts, daily] = sent;
    expect(posts.signature).toBe(signXPosts(SECRET, posts.timestamp, posts.body));
    expect(daily.signature).toBe(signXStatus(SECRET, daily.timestamp, daily.body));
    expect(parseXPostsReport(JSON.parse(posts.body), posts.timestamp)?.posts).toEqual([
      { id: "123", createdAt: "2026-10-15T01:00:00.000Z", repository: "owner/skill-repo", metrics: { like: 10, reply: 2, repost: 3, quote: 4 } }]);
    expect(parseXStatusReport(JSON.parse(daily.body), daily.timestamp))
      .toMatchObject({ mode: "live", reads: { used: 10, limit: 10 }, candidates: 1, lastSuccessAt: observedAt, error: null });
    for (const item of sent) expect(item.body).not.toMatch(/private-raw-text|private-author|private-token/);
    expect(await status()).toMatchObject({ status: "completed", reports: { posts: 200, status: 200 } });
  });

  it("dry-run 은 하루 상태만 보낸다", async () => {
    const { sent, send } = recorder();
    await runXCollector({ ...options(), live: false }, { send });
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ mode: "dry-run", reads: { used: 0 }, lastSuccessAt: observedAt, error: null });
  });

  it("같은 날 다시 돌면 게시물은 보내지 않고, 하루 한도는 오류가 아니다", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [post()] })));
    await runXCollector(options(), { request, send: recorder().send });
    const { sent, send } = recorder();
    expect(await runXCollector({ ...options(), now: () => instant + 60_000 }, { request, send })).toMatchObject({ reason: "daily_limit" });
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ reads: { used: 10 }, lastSuccessAt: observedAt, error: null });
  });

  it("검색이 실패하면 게시물은 보내지 않고 오류 코드를 알린다", async () => {
    const { sent, send } = recorder();
    await runXCollector(options(), { request: vi.fn().mockRejectedValue(new Error("private-token")), send });
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body).error).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("보내기가 실패해도 수집 결과와 예약 장부는 그대로이고 status.json 에만 남는다", async () => {
    const send = vi.fn().mockRejectedValue(new Error("private-token")) as unknown as typeof fetch;
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [post()] })));
    expect(await runXCollector(options(), { request, send })).toMatchObject({ status: "completed", reservedPosts: 10 });
    expect(await status()).toMatchObject({ reports: { posts: "network", status: "network" } });
    expect(await readFile(join(stateDir, "status.json"), "utf8")).not.toContain("private-token");
  });

  it("보고 설정이 없으면 아무것도 보내지 않는다", async () => {
    const { sent, send } = recorder();
    await runXCollector({ ...options(), report: undefined, live: false }, { send });
    expect(sent).toEqual([]);
    expect(await status()).not.toHaveProperty("reports");
  });
});

describe("검색 저장소 묻기 — 우리 제품 저장소로 검색한다(2026-10-21)", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "x-query-")); });
  afterEach(() => vi.restoreAllMocks());
  const web = { ...report, queryUrl: "https://nomorevibe.test/api/ops/x-query" };
  const options = () => ({ stateDir, live: true, useCaseApproved: true, token: "private-token", now: () => instant, report: web });
  const status = async () => JSON.parse(await readFile(join(stateDir, "status.json"), "utf8"));
  const receipt = () => join(stateDir, "budget-2026-10-15.json");
  const answer = (repositories: string[], day = "2026-10-15") => new Response(JSON.stringify({ v: 1, day, repositories }), { status: 200 });
  /** 웹 흉내 — 묻기에는 reply 로, 보고에는 200 으로 */
  function webWith(reply: (body: string) => Promise<Response> | Response) {
    const sent: Sent[] = [];
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), body: String(init?.body), timestamp: Number(headers.get("x-nmv-timestamp")), signature: headers.get("x-nmv-signature") ?? "" });
      return String(url) === web.queryUrl ? reply(String(init?.body)) : new Response(null, { status: 200 });
    });
    return { sent, send: send as unknown as typeof fetch };
  }
  const searched = (request: ReturnType<typeof vi.fn>) => new URL((request.mock.calls as unknown as [string][])[0][0]).searchParams.get("query");
  const posts = [post("123", ["owner/skill-repo"]), post("124", ["acme/tool", "other/lib"]), post("125", []),
    { ...post("126"), withheld: { country_codes: ["US"] } }];
  const xSearch = () => vi.fn(async () => new Response(JSON.stringify({ data: posts })));

  it("예약 장부보다 먼저 묻고, 답한 저장소로 검색어를 만든다 — 보고는 v2(버리는 글 없음)·검색어 출처까지", async () => {
    const { sent, send } = webWith(async () => {
      await expect(readFile(receipt())).rejects.toThrow();
      return answer(["acme/tool", "owner/skill-repo"]);
    });
    const request = xSearch();
    expect(await runXCollector(options(), { request, send })).toMatchObject({ status: "completed", reservedPosts: 10, requests: 1, candidates: 1,
      query: { source: "products", repositories: 2, reason: null } });
    expect(searched(request)).toBe(xSearchQuery('url:"github.com/acme/tool" OR url:"github.com/owner/skill-repo"'));
    expect(sent.map(item => item.url)).toEqual([web.queryUrl, report.postsUrl, report.statusUrl]);
    const [asked, sentPosts, daily] = sent;
    expect(JSON.parse(asked.body)).toEqual({ v: 1, day: "2026-10-15" });
    expect(asked.signature).toBe(signXQuery(SECRET, asked.timestamp, asked.body));
    expect(parseXPostsReport(JSON.parse(sentPosts.body), sentPosts.timestamp)).toMatchObject({ v: 2, unavailable: ["126"], posts: [
      { id: "123", repositories: ["owner/skill-repo"] }, { id: "124", repositories: ["acme/tool", "other/lib"] }, { id: "125", repositories: [] }] });
    expect(parseXStatusReport(JSON.parse(daily.body), daily.timestamp)).toMatchObject({ v: 2, query: { source: "products", repositories: 2, reason: null } });
    for (const item of sent) expect(item.body).not.toMatch(/private-raw-text|private-author|private-token/);
    expect(await status()).toMatchObject({ query: { source: "products", repositories: 2, reason: null }, reports: { posts: 200, status: 200 } });
  });

  it("v2 글은 그날 검색한 우리 저장소를 앞에 두고 5곳까지 싣는다", async () => {
    const { sent, send } = webWith(() => answer(["zeta/ours"]));
    const many = post("130", ["a/one", "b/two", "c/three", "d/four", "e/five", "zeta/ours"]);
    await runXCollector(options(), { request: vi.fn(async () => new Response(JSON.stringify({ data: [many] }))), send });
    expect(JSON.parse(sent[1].body).posts[0].repositories).toEqual(["zeta/ours", "a/one", "b/two", "c/three", "d/four"]);
  });

  it.each([
    ["network", () => Promise.reject(new Error("private-token"))],
    ["timeout", () => Promise.reject(Object.assign(new Error("slow"), { name: "TimeoutError" }))],
    ["http_404", () => new Response("<html>not found</html>", { status: 404 })],
    ["http_503", () => new Response(JSON.stringify({ error: "x_query_unavailable" }), { status: 503 })],
    ["invalid_response", () => new Response("not json", { status: 200 })],
    ["invalid_response", () => answer(["acme/tool"], "2026-10-14")],
    ["invalid_response", () => answer(['acme/tool" OR from:someone'])],
  ] as const)("묻기가 실패하면(%s) 고정 검색어로 그날 읽기를 쓰고, 옛 웹일 수 있어 보고는 v1 로 보낸다", async (reason, reply) => {
    const { sent, send } = webWith(reply);
    const request = xSearch();
    expect(await runXCollector(options(), { request, send })).toMatchObject({ status: "completed", reservedPosts: 10, requests: 1,
      query: { source: "default", repositories: 0, reason } });
    expect(searched(request)).toBe(xSearchQuery(X_COLLECTOR_QUERY));
    expect(parseXPostsReport(JSON.parse(sent[1].body), sent[1].timestamp)).toMatchObject({ v: 1, posts: [{ id: "123", repository: "owner/skill-repo" }] });
    expect(JSON.parse(sent[2].body)).toMatchObject({ v: 1 });
    expect(JSON.parse(sent[2].body)).not.toHaveProperty("query");
    expect(await status()).toMatchObject({ query: { source: "default", reason } });
    expect(await readFile(join(stateDir, "status.json"), "utf8")).not.toContain("private-token");
  });

  it("빈 목록이면 고정 검색어 — 답한 웹은 새 판을 받으므로 보고는 v2", async () => {
    const { sent, send } = webWith(() => answer([]));
    const request = xSearch();
    expect(await runXCollector(options(), { request, send })).toMatchObject({ query: { source: "default", reason: "empty" } });
    expect(searched(request)).toBe(xSearchQuery(X_COLLECTOR_QUERY));
    expect(JSON.parse(sent[1].body)).toMatchObject({ v: 2 });
    expect(JSON.parse(sent[2].body)).toMatchObject({ v: 2, query: { source: "default", repositories: 0, reason: "empty" } });
  });

  it("묻는 주소가 없으면 예전 그대로 — 고정 검색어, v1 보고, 묻기 없음", async () => {
    const { sent, send } = webWith(() => answer(["acme/tool"]));
    expect(await runXCollector({ ...options(), report }, { request: xSearch(), send })).toMatchObject({ query: { source: "default", reason: "not_configured" } });
    expect(sent.map(item => item.url)).toEqual([report.postsUrl, report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ v: 1 });
  });

  it("묻기는 하루 장부를 바꾸지 않는다 — dry-run 은 묻기만 하고 X·예약이 없고, 같은 날 다시 돌면 X 를 부르지 않는다", async () => {
    const request = xSearch();
    const dry = webWith(() => answer(["acme/tool"]));
    expect(await runXCollector({ ...options(), live: false }, { request, send: dry.send })).toMatchObject({ status: "planned", reservedPosts: 0,
      query: { source: "products", repositories: 1 } });
    expect(request).not.toHaveBeenCalled();
    await expect(readFile(receipt())).rejects.toThrow();
    expect(JSON.parse(dry.sent[1].body)).toMatchObject({ v: 2, mode: "dry-run", reads: { used: 0 }, query: { source: "products" } });
    await runXCollector(options(), { request, send: webWith(() => answer(["acme/tool"])).send });
    expect(await runXCollector({ ...options(), now: () => instant + 60_000 }, { request, send: webWith(() => answer(["acme/tool"])).send }))
      .toMatchObject({ status: "blocked", reason: "daily_limit", requests: 0 });
    expect(request).toHaveBeenCalledOnce();
  });
});
