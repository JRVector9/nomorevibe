import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseXPostsReport, signXPosts, xPoints, X_POSTS_MAX_POSTS } from "@/lib/operations/x-posts";
import { signXStatus, X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";

vi.mock("@/lib/db", () => ({ db: {} }));
const { verifyXPostsRequest, xSocialPosts } = await import("@/lib/operations/x-posts-receive");

const SECRET = "x-status-current-secret-0123456789abcdef", OLD = "x-status-previous-secret-0123456789abcdef";
const NOW = Date.parse("2026-10-21T00:10:05Z"), NOW_S = Math.floor(NOW / 1000);
const post = (id = "1980000000000000001", patch: Record<string, unknown> = {}) => ({
  id, createdAt: "2026-10-20T12:00:00.000Z", repository: "Acme/Tool", metrics: { like: 40, reply: 6, repost: 9, quote: 2 }, ...patch,
});
const report = (patch: Record<string, unknown> = {}) => ({ v: 1, observedAt: "2026-10-21T00:10:01.000Z", posts: [post()], unavailable: [], ...patch });
function signed(body: unknown, options: { secret?: string; sign?: typeof signXPosts; timestamp?: number; type?: string } = {}) {
  const raw = JSON.stringify(body), timestamp = options.timestamp ?? NOW_S;
  return new Request("https://nomorevibe.test/api/ops/x-posts", { method: "POST", body: raw, headers: {
    "content-type": options.type ?? "application/json", "x-nmv-timestamp": String(timestamp),
    "x-nmv-signature": (options.sign ?? signXPosts)(options.secret ?? SECRET, timestamp, raw) } });
}

describe("게시물 보고 형식", () => {
  it("정해진 칸만 받는다", () => {
    expect(parseXPostsReport(report(), NOW_S)).toEqual(report());
    expect(parseXPostsReport({ ...report(), text: "private" }, NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [{ ...post(), author: "private" }] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [post("01")] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [post(undefined, { repository: "acme/.." })] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [post(undefined, { metrics: { like: -1, reply: 0, repost: 0, quote: 0 } })] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [post(undefined, { metrics: { like: 1, reply: 0, repost: 0 } })] }), NOW_S)).toBeNull();
  });

  it("시각은 보낸 시각보다 뒤일 수 없고, 글은 관측보다 먼저다", () => {
    expect(parseXPostsReport(report({ observedAt: "2026-10-21T00:20:00.000Z" }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [post(undefined, { createdAt: "2026-10-21T00:10:02.000Z" })] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ observedAt: "2026-02-30T00:00:00.000Z" }), NOW_S)).toBeNull();
  });

  it("한 게시물은 한 번만, 개수는 10개까지", () => {
    expect(parseXPostsReport(report({ posts: [post(), post()] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ unavailable: ["1980000000000000001"] }), NOW_S)).toBeNull();
    const many = Array.from({ length: X_POSTS_MAX_POSTS + 1 }, (_, index) => post(`19800000000000000${10 + index}`));
    expect(parseXPostsReport(report({ posts: many }), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [], unavailable: ["1980000000000000009"] }), NOW_S)).toMatchObject({ unavailable: ["1980000000000000009"] });
  });

  it("점수는 좋아요 + 재게시×2, 댓글 칸은 답글 — 저장소 열쇠는 소문자, 제목은 비운다", () => {
    expect(xPoints({ like: 40, reply: 6, repost: 9, quote: 2 })).toEqual({ points: 58, comments: 6 });
    expect(xSocialPosts(parseXPostsReport(report(), NOW_S)!)).toEqual([{
      externalId: "1980000000000000001", kind: "link", title: "", linkUrl: "https://github.com/Acme/Tool", linkTarget: "repo",
      repositoryKey: "acme/tool", postedAt: new Date("2026-10-20T12:00:00.000Z"), frontPage: false, points: 58, comments: 6,
    }]);
  });
});

describe("게시물 보고 v2 — 검색이 돌려준 글을 버리지 않는다(2026-10-21)", () => {
  const v2post = (id: string, repositories: string[], patch: Record<string, unknown> = {}) => ({
    id, createdAt: "2026-10-20T12:00:00.000Z", repositories, metrics: { like: 40, reply: 6, repost: 9, quote: 2 }, ...patch,
  });
  const v2 = (posts: unknown[], patch: Record<string, unknown> = {}) => ({ v: 2, observedAt: "2026-10-21T00:10:01.000Z", posts, unavailable: [], ...patch });

  it("저장소 0~5곳을 싣는 글을 받는다 — v1 칸이 섞이거나, 6곳 이상이거나, 대소문자만 다른 겹침이면 거절한다", () => {
    const body = v2([v2post("1980000000000000001", ["Acme/Tool"]), v2post("1980000000000000002", ["a/b", "c/d"]), v2post("1980000000000000003", [])]);
    expect(parseXPostsReport(body, NOW_S)).toEqual(body);
    expect(parseXPostsReport(v2([post()]), NOW_S)).toBeNull();
    expect(parseXPostsReport(report({ posts: [v2post("1980000000000000001", ["a/b"])] }), NOW_S)).toBeNull();
    expect(parseXPostsReport(v2([v2post("1980000000000000001", ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"])]), NOW_S)).toBeNull();
    expect(parseXPostsReport(v2([v2post("1980000000000000001", ["Acme/Tool", "acme/tool"])]), NOW_S)).toBeNull();
    expect(parseXPostsReport(v2([v2post("1980000000000000001", ["acme/.."])]), NOW_S)).toBeNull();
    expect(parseXPostsReport(v2([v2post("1980000000000000001", ["a/b"], { text: "private" })]), NOW_S)).toBeNull();
    expect(parseXPostsReport({ ...v2([]), v: 3 }, NOW_S)).toBeNull();
  });

  it("저장소 하나는 repo 글, 여럿이면 처음 나오는 공개 제품의 저장소 글, 공개 제품이 없거나 저장소가 없으면 site 글(열쇠 없음)", () => {
    const parsed = parseXPostsReport(v2([
      v2post("1980000000000000001", ["Acme/Tool"]),
      v2post("1980000000000000002", ["other/lib", "Ours/Product", "ours/second"]),
      v2post("1980000000000000003", ["other/lib", "more/lib"]),
      v2post("1980000000000000004", []),
    ]), NOW_S)!;
    const base = { kind: "link", title: "", postedAt: new Date("2026-10-20T12:00:00.000Z"), frontPage: false, points: 58, comments: 6 };
    expect(xSocialPosts(parsed, new Set(["ours/product", "ours/second"]))).toEqual([
      { ...base, externalId: "1980000000000000001", linkUrl: "https://github.com/Acme/Tool", linkTarget: "repo", repositoryKey: "acme/tool" },
      { ...base, externalId: "1980000000000000002", linkUrl: "https://github.com/Ours/Product", linkTarget: "repo", repositoryKey: "ours/product" },
      { ...base, externalId: "1980000000000000003", linkUrl: "https://github.com/other/lib", linkTarget: "site", repositoryKey: null },
      { ...base, externalId: "1980000000000000004", linkUrl: "https://x.com/i/web/status/1980000000000000004", linkTarget: "site", repositoryKey: null },
    ]);
    // 공개 제품을 모르면(확인 전) 여러 저장소 글은 공개 화면에 오르지 않는 site 글이다
    expect(xSocialPosts(parsed)[1]).toMatchObject({ linkTarget: "site", repositoryKey: null });
  });

  it("옛 수집기의 v1 보고는 예전과 똑같이 저장소 글이 된다", () => {
    expect(xSocialPosts(parseXPostsReport(report(), NOW_S)!, new Set())).toEqual(xSocialPosts(parseXPostsReport(report(), NOW_S)!));
    expect(xSocialPosts(parseXPostsReport(report(), NOW_S)!)[0]).toMatchObject({ linkTarget: "repo", repositoryKey: "acme/tool" });
  });
});

describe("게시물 보고 받기 — DB 앞 검사", () => {
  beforeEach(() => { vi.stubEnv(X_STATUS_SECRET_ENV, SECRET); vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, OLD); });
  afterEach(() => vi.unstubAllEnvs());
  const refused = async (request: Request) => {
    const checked = await verifyXPostsRequest(request, NOW);
    return checked.ok ? 200 : checked.response.status;
  };

  it("비밀이 없으면 없는 주소(404)다", async () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, "");
    expect(await refused(signed(report()))).toBe(404);
  });

  it("지금 비밀과 직전 비밀로 서명한 보고를 받는다", async () => {
    expect(await verifyXPostsRequest(signed(report()), NOW)).toMatchObject({ ok: true, value: { signedWith: "current", sentAt: NOW_S } });
    expect(await verifyXPostsRequest(signed(report(), { secret: OLD }), NOW)).toMatchObject({ ok: true, value: { signedWith: "previous" } });
  });

  it("하루 보고의 서명은 이 주소에서 통하지 않는다", async () => {
    expect(await refused(signed(report(), { sign: signXStatus }))).toBe(401);
    expect(await refused(signed(report(), { secret: "wrong-secret-0123456789abcdef0123456789" }))).toBe(401);
  });

  it("시각이 5분 넘게 어긋나거나, JSON 이 아니거나, 형식이 틀리면 거절한다", async () => {
    expect(await refused(signed(report(), { timestamp: NOW_S - 301 }))).toBe(401);
    expect(await refused(signed(report(), { type: "text/plain" }))).toBe(415);
    expect(await refused(signed({ ...report(), extra: 1 }))).toBe(400);
  });
});
