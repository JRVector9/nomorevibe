import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXPostsReport, signXPosts } from "@/lib/operations/x-posts";
import { parseXStatusReport, signXStatus } from "@/lib/operations/x-status";
import { runXCollector, X_COLLECTOR_MIN_LIKES, X_COLLECTOR_QUERY } from "@/lib/social/x-collector";
import { X_QUERY_MAX_LENGTH, xSearchQuery, type XObservation } from "@/lib/social/x-pilot";
import { sendSigned, xPostsReportFrom, xStatusReportFrom, type XReportConfig } from "@/lib/social/x-report";

const SECRET = "x-status-current-secret-0123456789abcdef";
const report = { secret: SECRET, statusUrl: "https://nomorevibe.test/api/ops/x-status", postsUrl: "https://nomorevibe.test/api/ops/x-posts" } satisfies XReportConfig;
const popular = { source: "popular", minLikes: 50 } as const;
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
  it("게시물 보고(v2)는 반응 네 칸이 다 있는 공개 글을 저장소가 없거나 여럿이어도 싣고(5곳까지), 사용 불가는 ID만 담는다", () => {
    const six = ["a/one", "b/two", "c/three", "d/four", "e/five", "f/six"];
    const payload = xPostsReportFrom([
      observation("123"),
      observation("124", { linkStatus: "ambiguous", repositories: ["a/b", "c/d"] }),
      observation("125", { metrics: { ...observed, quote_count: null } }),
      observation("126", { availability: "unavailable", repositories: [], linkStatus: "none" }),
      observation("127", { availability: "unknown" }),
      observation("128", { createdAt: null }),
      observation("129", { repositories: [], linkStatus: "none" }),
      observation("130", { linkStatus: "ambiguous", repositories: six }),
      observation("123"),
    ], observedAt);
    const createdAt = "2026-10-15T01:00:00.000Z", counts = { like: 10, reply: 2, repost: 3, quote: 4 };
    expect(payload).toEqual({ v: 2, observedAt, unavailable: ["126"], posts: [
      { id: "123", createdAt, repositories: ["Owner/Skill-Repo"], metrics: counts },
      { id: "124", createdAt, repositories: ["a/b", "c/d"], metrics: counts },
      { id: "129", createdAt, repositories: [], metrics: counts },
      { id: "130", createdAt, repositories: six.slice(0, 5), metrics: counts },
    ] });
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

  it("검색어를 주면 v3(검색어 칸 query), 없으면 v1 — 웹의 엄격한 형식 검사를 그대로 지난다", () => {
    const base = { live: true, status: "completed", candidates: 3, reservedToday: true, lastRunAt: observedAt, lastSuccessAt: observedAt } as const;
    const v3 = xStatusReportFrom({ ...base, query: popular });
    expect(v3).toEqual({ v: 3, mode: "live", reads: { used: 10, limit: 10 }, candidates: 3, lastRunAt: observedAt, lastSuccessAt: observedAt,
      error: null, query: { source: "popular", minLikes: 50 } });
    expect(parseXStatusReport(JSON.parse(JSON.stringify(v3)), Math.floor(instant / 1000))).toEqual(v3);
    expect(xStatusReportFrom(base)).not.toHaveProperty("query");
    expect(xStatusReportFrom(base).v).toBe(1);
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
      { id: "123", createdAt: "2026-10-15T01:00:00.000Z", repositories: ["owner/skill-repo"], metrics: { like: 10, reply: 2, repost: 3, quote: 4 } }]);
    expect(parseXStatusReport(JSON.parse(daily.body), daily.timestamp))
      .toMatchObject({ v: 3, mode: "live", reads: { used: 10, limit: 10 }, candidates: 1, lastSuccessAt: observedAt, error: null, query: popular });
    for (const item of sent) expect(item.body).not.toMatch(/private-raw-text|private-author|private-token/);
    expect(await status()).toMatchObject({ status: "completed", reports: { posts: 200, status: 200 } });
  });

  it("dry-run 은 하루 상태만 보낸다", async () => {
    const { sent, send } = recorder();
    await runXCollector({ ...options(), live: false }, { send });
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ v: 3, mode: "dry-run", reads: { used: 0 }, lastSuccessAt: observedAt, error: null, query: popular });
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

describe("검색어 — GitHub 주소가 있고 많이 퍼진 글만(2026-10-22)", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "x-popular-")); });
  afterEach(() => vi.restoreAllMocks());
  const options = () => ({ stateDir, live: true, useCaseApproved: true, token: "private-token", now: () => instant, report });
  const status = async () => JSON.parse(await readFile(join(stateDir, "status.json"), "utf8"));
  const receipt = () => join(stateDir, "budget-2026-10-15.json");
  const searched = (request: ReturnType<typeof vi.fn>) => new URL((request.mock.calls as unknown as [string][])[0][0]).searchParams;
  const posts = [post("123", ["owner/skill-repo"]), post("124", ["acme/tool", "other/lib"]), post("125", []),
    { ...post("126"), withheld: { country_codes: ["US"] } }];
  const xSearch = () => vi.fn(async () => new Response(JSON.stringify({ data: posts })));
  /** 웹 흉내 — 하루 상태 v3 에 statusV3 로 답한다(옛 웹이면 400). 나머지는 200 */
  function webWith(statusV3: number) {
    const sent: Sent[] = [];
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers), body = String(init?.body);
      sent.push({ url: String(url), body, timestamp: Number(headers.get("x-nmv-timestamp")), signature: headers.get("x-nmv-signature") ?? "" });
      return new Response(null, { status: String(url) === report.statusUrl && JSON.parse(body).v === 3 ? statusV3 : 200 });
    });
    return { sent, send: send as unknown as typeof fetch };
  }

  it("검색어는 url:github.com min_likes:50 하나 — 좋아요 하한은 이름 붙은 상수, 감싼 검색어도 짧다", () => {
    expect(X_COLLECTOR_MIN_LIKES).toBe(50);
    expect(X_COLLECTOR_QUERY).toBe("url:github.com min_likes:50");
    expect(xSearchQuery(X_COLLECTOR_QUERY)).toBe("(url:github.com min_likes:50) -is:retweet");
    expect(xSearchQuery(X_COLLECTOR_QUERY).length).toBeLessThan(X_QUERY_MAX_LENGTH);
    // 웹 검색 이름(min_faves·min_retweets)은 API 에서 400 이다
    expect(X_COLLECTOR_QUERY).not.toMatch(/min_faves|min_retweets/);
  });

  it("웹에 묻지 않고 한 요청·10건·관련도순으로 그 검색어를 보낸다 — 옛 설정에 묻는 주소가 남아 있어도", async () => {
    const { sent, send } = webWith(200);
    const leftover = { ...report, queryUrl: "https://nomorevibe.test/api/ops/x-query" } as XReportConfig;
    const request = xSearch();
    expect(await runXCollector({ ...options(), report: leftover }, { request, send })).toMatchObject({ status: "completed", reservedPosts: 10,
      requests: 1, httpStatus: 200, query: popular });
    expect(request).toHaveBeenCalledOnce();
    const params = searched(request);
    expect([params.get("query"), params.get("max_results"), params.get("sort_order")])
      .toEqual(["(url:github.com min_likes:50) -is:retweet", "10", "relevancy"]);
    // 보내는 곳은 두 보고 주소뿐 — 묻기(/api/ops/x-query)가 없다
    expect(sent.map(item => item.url)).toEqual([report.postsUrl, report.statusUrl]);
    expect(sent.some(item => item.url.includes("x-query"))).toBe(false);
  });

  it("검색이 돌려준 글은 버리지 않는다 — 게시물 v2 에 저장소 0~5곳, 하루 상태 v3·status.json 에 검색어 출처와 하한", async () => {
    const { sent, send } = webWith(200);
    expect(await runXCollector(options(), { request: xSearch(), send })).toMatchObject({ status: "completed", candidates: 1, query: popular });
    const [sentPosts, daily] = sent;
    expect(sentPosts.signature).toBe(signXPosts(SECRET, sentPosts.timestamp, sentPosts.body));
    expect(parseXPostsReport(JSON.parse(sentPosts.body), sentPosts.timestamp)).toMatchObject({ v: 2, unavailable: ["126"], posts: [
      { id: "123", repositories: ["owner/skill-repo"] }, { id: "124", repositories: ["acme/tool", "other/lib"] }, { id: "125", repositories: [] }] });
    expect(parseXStatusReport(JSON.parse(daily.body), daily.timestamp)).toMatchObject({ v: 3, query: { source: "popular", minLikes: 50 } });
    for (const item of sent) expect(item.body).not.toMatch(/private-raw-text|private-author|private-token|min_likes/);
    expect(await status()).toMatchObject({ query: { source: "popular", minLikes: 50 }, httpStatus: 200, reports: { posts: 200, status: 200 } });
    expect((await status()).reports).not.toHaveProperty("statusV1");
  });

  it("v3 를 모르는 웹(400)에는 하루 상태를 검색어 칸 없는 v1 로 한 번 더 보낸다 — 다른 실패는 다시 보내지 않는다", async () => {
    const old = webWith(400);
    await runXCollector(options(), { request: xSearch(), send: old.send });
    expect(old.sent.map(item => item.url)).toEqual([report.postsUrl, report.statusUrl, report.statusUrl]);
    const again = old.sent[2];
    expect(again.signature).toBe(signXStatus(SECRET, again.timestamp, again.body));
    expect(parseXStatusReport(JSON.parse(again.body), again.timestamp)).toMatchObject({ v: 1, mode: "live", reads: { used: 10 }, error: null });
    expect(JSON.parse(again.body)).not.toHaveProperty("query");
    expect(await status()).toMatchObject({ query: popular, reports: { posts: 200, status: 400, statusV1: 200 } });

    for (const reply of [429, 503]) {
      const { sent, send } = webWith(reply);
      await runXCollector({ ...options(), live: false }, { send });
      expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
      expect((await status()).reports).toEqual({ status: reply });
    }
  });

  it("X 가 검색어를 거절하면(400) 장부는 되돌리지 않고 http_error 와 httpStatus 를 남긴다 — 같은 날 다시 부르지 않는다", async () => {
    const { sent, send } = webWith(200);
    const request = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "private-provider-body" }] }), { status: 400 }));
    expect(await runXCollector(options(), { request, send })).toMatchObject({ status: "stopped", reason: "http_error", reservedPosts: 10,
      requests: 1, httpStatus: 400, query: popular });
    expect(JSON.parse(await readFile(receipt(), "utf8"))).toMatchObject({ reservedPosts: 10 });
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ v: 3, error: "http_error", reads: { used: 10 } });
    expect(await status()).toMatchObject({ status: "stopped", reason: "http_error", httpStatus: 400 });
    expect(await readFile(join(stateDir, "status.json"), "utf8")).not.toMatch(/private/);
    expect(await runXCollector({ ...options(), now: () => instant + 60_000 }, { request, send })).toMatchObject({ reason: "daily_limit", requests: 0 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("dry-run 은 X·예약 없이 하루 상태만 — 검색어 칸은 같다", async () => {
    const { sent, send } = webWith(200);
    const request = xSearch();
    expect(await runXCollector({ ...options(), live: false }, { request, send })).toMatchObject({ status: "planned", reservedPosts: 0,
      requests: 0, query: popular });
    expect(request).not.toHaveBeenCalled();
    await expect(readFile(receipt())).rejects.toThrow();
    expect(sent.map(item => item.url)).toEqual([report.statusUrl]);
    expect(JSON.parse(sent[0].body)).toMatchObject({ v: 3, mode: "dry-run", reads: { used: 0 }, query: popular });
    expect(await status()).not.toHaveProperty("httpStatus");
  });
});
