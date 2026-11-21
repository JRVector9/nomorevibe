import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductTalk, TalkBoard, TalkEntry } from "@/lib/social/talk";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";

/**
 * 화제·시즌 랭킹 채우기 API(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에서 뺀 칸을 브라우저가 받는 같은 출처 API.
 * 공개 API 읽기 관문(수집 도구·학습 봇 거절, 다른 사이트 요청 거절, IP 별 읽기 한도)을 그대로 거치고, 화면이 그리는 칸만 돌려준다.
 * DB 는 부르지 않는다 — 한도 표와 화제·시즌·제품 읽기만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  talkVisibility: vi.fn(),
  listTalk: vi.fn(),
  productTalk: vi.fn(),
  getProductIdentity: vi.fn(),
  getSeasonByKey: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  rateLimitWindow: mocks.rateLimitWindow,
}));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: mocks.talkVisibility }));
vi.mock("@/lib/social/talk", async (original) => ({
  ...await original<typeof import("@/lib/social/talk")>(),
  listTalk: mocks.listTalk,
  productTalk: mocks.productTalk,
}));
vi.mock("@/lib/domain/products/detail-view", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/detail-view")>(),
  getProductIdentity: mocks.getProductIdentity,
}));
vi.mock("@/lib/domain/ranking/view", () => ({ getSeasonByKey: mocks.getSeasonByKey }));

const boardModule = await import("@/app/api/talk-board/route");
const productTalkRoute = await import("@/app/api/products/[slug]/talk/route");
const rankingsRoute = await import("@/app/api/rankings/[key]/route");
const { reviveTalk } = await import("@/lib/social/talk-wire");
const { readTalkBoard } = await import("@/lib/social/home-talk");
/** 경로 매개변수가 없는 route — withRoute 의 둘째 인자는 빈 params */
const boardRoute = { GET: (req: Request) => boardModule.GET(req, { params: Promise.resolve({}) } as never) };

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PUBLIC_IP = "198.51.100.24";
const NOW = new Date("2026-11-15T03:00:00Z");

function request(path: string, init: { ua?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  headers.set("user-agent", init.ua ?? BROWSER);
  headers.set("x-forwarded-for", PUBLIC_IP);
  return new Request(`https://nomorevibe.test${path}`, { headers });
}

const post = (id: number, over: Partial<TalkEntry["posts"][number]> = {}): TalkEntry["posts"][number] => ({
  id: 70_000 + id, source: "hn", externalId: String(5000 + id), kind: "show", title: `SENTINEL_POST_TITLE ${id}`, linkTarget: "repo",
  postedAt: new Date("2026-11-14T00:00:00Z"), points: 987_654, comments: 321, frontPage: true, ...over,
});
const growth = {
  delta: 4_321, basis: "mention" as const, from: 100, fromAt: new Date("2026-11-13T00:00:00Z"), to: 4_421, toAt: new Date("2026-11-15T00:00:00Z"),
  points: [{ stars: 100, at: new Date("2026-11-13T00:00:00Z") }, { stars: 4_421, at: new Date("2026-11-15T00:00:00Z") }],
};
const entry = (rank: number, homeDecision: TalkEntry["homeDecision"] = null): TalkEntry => ({
  rank, repositoryKey: `sentinel-owner/repo-${rank}`, score: 12.5, sources: ["hn"], byMaker: true, starGrowth: rank === 1 ? growth : null, homeDecision,
  posts: [post(rank)],
  product: { id: 95_000 + rank, slug: `talk-${rank}`, name: `Talk ${rank}`, translationName: `Talk ${rank}`, tagline: `Talk tagline ${rank}`, taglineKo: null,
    taglineSource: "maker", category: "SENTINEL_CAT", repoUrl: `https://github.com/sentinel-owner/repo-${rank}`,
    ogImage: `https://sentinel.example/og-${rank}.png`, stars: 987_654, aiLevel: 2, accessMode: "website" },
});
const board = (entries: TalkEntry[]): TalkBoard => ({ mode: "now", entries, unlisted: { active: 2, unknown: 1 }, checkedAt: new Date("2026-11-15T02:30:00Z") });

const season: SeasonSummary = {
  key: "2026-W46", cadence: "weekly", startsAt: new Date("2026-11-08T15:00:00Z"), endsAt: new Date("2026-11-15T15:00:00Z"),
  isTransition: false, effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: null, state: "active",
};
const rankingItem = {
  id: 95_401, slug: "ranked", name: "Ranked", tagline: "Ranked tagline", taglineSource: "maker", taglineKo: null, category: "SENTINEL_CAT", builder: null,
  builderClaim: "reported", stack: [], ogImage: "https://sentinel.example/ranked.png", makerName: "SENTINEL_MAKER", repoUrl: "https://github.com/sentinel/ranked",
  listedAt: new Date("2026-11-01T00:00:00Z"), status: "verified", unclaimed: false, health: { down: true, since: null },
  rank: 3, validClicks: 42, uniqueVisitors: 17, recentUniqueVisitors: 6, previousUniqueVisitors: 4, scoreMode: "valid_visits",
  changePercent: -12, cooldownFactorBasisPoints: 7_500, previousRank: 5,
} as unknown as RankingListItem;

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  mocks.talkVisibility.mockReset().mockResolvedValue({ visible: true, preview: false });
  mocks.listTalk.mockReset().mockResolvedValue(board([entry(1), entry(2, "approved"), entry(3, "talk_only")]));
  mocks.productTalk.mockReset().mockResolvedValue({
    posts: [post(1), post(2, { linkTarget: "issue" })], qualifies: true, rank: 4, sources: ["hn"], starGrowth: growth, checkedAt: NOW,
  } satisfies ProductTalk);
  mocks.getProductIdentity.mockReset().mockResolvedValue({ id: 95_001, slug: "talk-1", repoUrl: "https://github.com/sentinel-owner/repo-1" });
  mocks.getSeasonByKey.mockReset().mockResolvedValue({ season, items: [rankingItem] });
});

const routes = [
  ["talk-board", "/api/talk-board?mode=now&locale=ko", (req: Request) => boardRoute.GET(req)],
  ["products/[slug]/talk", "/api/products/talk-1/talk", (req: Request) => productTalkRoute.GET(req, { params: Promise.resolve({ slug: "talk-1" }) })],
  ["rankings/[key]", "/api/rankings/2026-W46", (req: Request) => rankingsRoute.GET(req, { params: Promise.resolve({ key: "2026-W46" }) })],
] as const;

describe("채우기 API — 공개 API 읽기 관문을 그대로", () => {
  it.each(routes)("%s: 수집 도구·학습 봇·다른 사이트 요청은 403, 한도를 넘으면 429 — 읽기 전에 막는다", async (_name, path, call) => {
    for (const ua of ["curl/8.7.1", "python-requests/2.32.3", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"]) {
      expect((await call(request(path, { ua }))).status).toBe(403);
    }
    expect((await call(request(path, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 90 });
    const limited = await call(request(path));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
    expect(mocks.listTalk).not.toHaveBeenCalled();
    expect(mocks.productTalk).not.toHaveBeenCalled();
    expect(mocks.getSeasonByKey).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: 엣지·브라우저에 담지 않는다. 내부 id·저장소 열쇠·점수·홈 결정은 싣지 않는다", async (_name, path, call) => {
    const response = await call(request(path, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toMatch(/"id":\d/);
    for (const key of ['"repositoryKey":', '"score":', '"homeDecision":', '"repoUrl":', '"makerName":', '"frontPage":', '"byMaker":', '"translationName":'])
      expect(text).not.toContain(key);
    expect(text).not.toContain("sentinel-owner/repo");
  });
});

describe("/api/talk-board", () => {
  it("mode=now|week: /talk 목록을 그 순서대로 — 표지·분류·스타·글·곡선·확인 시각·공개 전 수", async () => {
    const response = await boardRoute.GET(request("/api/talk-board?mode=now&locale=ko"));
    const body = JSON.parse(await response.text(), reviveTalk);
    expect(body.preview).toBe(false);
    expect(body.checkedAt).toEqual(new Date("2026-11-15T02:30:00Z"));
    expect(body.unlisted).toEqual({ active: 2, unknown: 1 });
    expect(body.entries.map((item: { slug: string; rank: number }) => [item.slug, item.rank])).toEqual([["talk-1", 1], ["talk-2", 2], ["talk-3", 3]]);
    expect(Object.keys(body.entries[0]).sort()).toEqual(["category", "name", "ogImage", "posts", "rank", "slug", "sources", "starGrowth", "stars"].sort());
    expect(Object.keys(body.entries[0].posts[0]).sort()).toEqual(["comments", "externalId", "kind", "linkTarget", "points", "postedAt", "source", "title"]);
    expect(body.entries[0].posts[0].postedAt).toBeInstanceOf(Date);
    expect(body.entries[0].starGrowth.points[1].at).toBeInstanceOf(Date);
    expect(body.entries[0]).toMatchObject({ ogImage: "https://sentinel.example/og-1.png", category: "SENTINEL_CAT", stars: 987_654 });

    await boardRoute.GET(request("/api/talk-board?mode=week&locale=ko"));
    expect(mocks.listTalk).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "week" }));
  });

  it("mode=home: 홈 대표 구획에 오른 항목만 — 허용된 대표가 맨 앞, talk_only 는 빠진다", async () => {
    const body = await (await boardRoute.GET(request("/api/talk-board?mode=home&locale=ko"))).json();
    expect(body.entries.map((item: { slug: string }) => item.slug)).toEqual(["talk-2", "talk-1"]);
    expect(body.checkedAt).toBeNull();
    expect(body.unlisted).toBeNull();
    expect(mocks.listTalk).toHaveBeenCalledWith(expect.objectContaining({ mode: "now", limit: 20 }));
  });

  it("화면과 같은 열쇠로 30초 함께 읽는다 — 화면이 읽은 뒤 API 는 DB 를 다시 읽지 않는다", async () => {
    await readTalkBoard("now", NOW, 20);
    await boardRoute.GET(request("/api/talk-board?mode=home&locale=ko"));
    await readTalkBoard("week", NOW);
    await boardRoute.GET(request("/api/talk-board?mode=week&locale=ko"));
    expect(mocks.listTalk).toHaveBeenCalledTimes(2);
  });

  it("화제 화면이 꺼져 있으면 404(담지 않는다), 관리자 미리보기면 preview, 모르는 mode 는 400", async () => {
    mocks.talkVisibility.mockResolvedValueOnce({ visible: false, preview: false });
    const hidden = await boardRoute.GET(request("/api/talk-board?mode=now"));
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listTalk).not.toHaveBeenCalled();
    mocks.talkVisibility.mockResolvedValueOnce({ visible: true, preview: true });
    expect((await (await boardRoute.GET(request("/api/talk-board?mode=now"))).json()).preview).toBe(true);
    expect((await boardRoute.GET(request("/api/talk-board?mode=all"))).status).toBe(400);
  });
});

describe("/api/products/[slug]/talk", () => {
  const call = (slug: string) => productTalkRoute.GET(request(`/api/products/${slug}/talk`), { params: Promise.resolve({ slug }) });

  it("자격 글이 있으면 띠가 그리는 칸 — 글·순위·출처·곡선·확인 시각", async () => {
    const body = JSON.parse(await (await call("talk-1")).text(), reviveTalk);
    expect(body.preview).toBe(false);
    expect(Object.keys(body.talk).sort()).toEqual(["checkedAt", "posts", "qualifies", "rank", "sources", "starGrowth"]);
    expect(body.talk.posts.map((item: { linkTarget: string }) => item.linkTarget)).toEqual(["repo", "issue"]);
    expect(body.talk.checkedAt).toEqual(NOW);
    expect(mocks.productTalk).toHaveBeenCalledWith(95_001, "https://github.com/sentinel-owner/repo-1", expect.any(Date));
  });

  it("자격 글이 없으면 talk 는 null, 없는 제품은 404, 화제 화면이 꺼져 있으면 404", async () => {
    mocks.productTalk.mockResolvedValueOnce({ posts: [post(1)], qualifies: false, rank: null, sources: ["hn"], starGrowth: null, checkedAt: NOW });
    expect(await (await call("talk-1")).json()).toEqual({ preview: false, talk: null });
    mocks.getProductIdentity.mockResolvedValueOnce(null);
    expect((await call("missing")).status).toBe(404);
    mocks.talkVisibility.mockResolvedValueOnce({ visible: false, preview: false });
    expect((await call("talk-1")).status).toBe(404);
  });
});

describe("/api/rankings/[key]", () => {
  const call = (key: string) => rankingsRoute.GET(request(`/api/rankings/${key}`), { params: Promise.resolve({ key }) });

  it("표가 채우는 칸만 — 점수·변동·가중치·지난 순위·상태 배지·응답 없음", async () => {
    const body = await (await call("2026-W46")).json();
    expect(body).toEqual({ items: [{
      slug: "ranked", status: "verified", unclaimed: false, down: true, validClicks: 42, uniqueVisitors: 17,
      changePercent: -12, cooldownFactorBasisPoints: 7_500, previousRank: 5,
    }] });
    expect(mocks.getSeasonByKey).toHaveBeenCalledWith("2026-W46");
  });

  it("없는 시즌은 404", async () => {
    mocks.getSeasonByKey.mockResolvedValueOnce(null);
    expect((await call("2099-W01")).status).toBe(404);
  });
});
