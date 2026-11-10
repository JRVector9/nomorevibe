import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discussionUrl, shortLink, socialPostLabel } from "@/components/social/talk-format";
import type { SocialCollector } from "@/lib/operations/flow-overview-model";

/**
 * 콘텐츠 운영 SNS 탭(/admin/content?tab=social) — 본문 없는 X·Bluesky 글의 이름표, 출처별 수집기 줄.
 * 수집기 판정은 운영 홈 SNS 칸과 같은 buildSocialCollectors 이다.
 */
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), replica: vi.fn(), select: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction, select: mocks.select }, onReplica: mocks.replica }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
import { buildSocialCollectors, jobRuntimeState, readSocialCollectors, socialCollectorRuntime } from "@/lib/operations/flow-overview-read";
import { SocialCollectorStripView } from "@/app/(operator)/admin/content/SocialCollectorStrip";

const NOW = new Date("2026-11-10T03:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const post = (extra: Partial<Parameters<typeof socialPostLabel>[0]>) => ({
  source: "bluesky" as const, kind: "link" as const, title: "", externalId: "did:plc:abcdefghijklmnopqrstuvwx/3lbcdefghij2k",
  linkUrl: "https://github.com/acme/app", linkTarget: "repo" as const, repositoryKey: "acme/app" as string | null, ...extra,
});

describe("본문 없는 SNS 글의 이름표", () => {
  it("제목이 있으면 제목, 없으면 출처와 가리킨 저장소로 붙인다", () => {
    expect(socialPostLabel(post({ source: "hn", title: "  Show HN: Doory  " }))).toBe("Show HN: Doory");
    expect(socialPostLabel(post({}))).toBe("Bluesky 게시물 · acme/app");
    expect(socialPostLabel(post({ source: "x", externalId: "1900000000000000001", linkTarget: "issue", linkUrl: "https://github.com/acme/app/issues/3" })))
      .toBe("X 게시물 · acme/app 이슈");
    expect(socialPostLabel(post({ linkTarget: "pull", linkUrl: "https://github.com/acme/app/pull/9" }))).toBe("Bluesky 게시물 · acme/app PR");
    expect(socialPostLabel(post({ linkTarget: "path", linkUrl: "https://github.com/acme/app/wiki" }))).toBe("Bluesky 게시물 · acme/app");
    expect(socialPostLabel(post({ source: "hn", kind: "show", externalId: "45001" }))).toBe("Show HN 게시물 · acme/app");
  });

  it("저장소가 아닌 글은 주소의 호스트·경로를 줄여 보이고, 글 자신만 가리키면 저장소 주소 없음", () => {
    expect(socialPostLabel(post({ linkTarget: "site", repositoryKey: null, linkUrl: "https://acme.github.io/app/?utm_source=bsky#top" })))
      .toBe("Bluesky 게시물 · acme.github.io/app");
    expect(socialPostLabel(post({ source: "x", externalId: "1900000000000000002", linkTarget: "site", repositoryKey: null, linkUrl: "https://www.example.com/" })))
      .toBe("X 게시물 · example.com");
    const own = { source: "x" as const, externalId: "1900000000000000003" };
    expect(socialPostLabel(post({ ...own, linkTarget: "site", repositoryKey: null, linkUrl: discussionUrl(own) }))).toBe("X 게시물 · 저장소 주소 없음");
    expect(socialPostLabel(post({ linkTarget: "site", repositoryKey: null, linkUrl: "javascript:alert(1)" }))).toBe("Bluesky 게시물 · 저장소 주소 없음");
  });

  it("긴 주소는 줄이고, 본문·글 ID 를 이름에 넣지 않는다", () => {
    const label = socialPostLabel(post({ linkTarget: "site", repositoryKey: null, linkUrl: `https://acme.github.io/${"deep/".repeat(20)}page` }));
    expect(label.startsWith("Bluesky 게시물 · acme.github.io/deep/")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toContain("did:plc");
    expect(shortLink("https://acme.github.io/%ED%95%9C%EA%B8%80/")).toBe("acme.github.io/한글");
    expect(shortLink("not a url")).toBeNull();
  });
});

const job = (extra: Partial<Parameters<typeof socialCollectorRuntime>[0] & object> = {}) =>
  ({ paused: false, runtimeLabel: "유휴", lastSuccessAt: minutesAgo(10), lastError: false, execution: "none" as const, ...extra });
const xReport = (patch: Record<string, unknown> = {}) => ({ v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 3,
  lastRunAt: minutesAgo(240), lastSuccessAt: minutesAgo(240), error: null, sentAt: Math.floor(NOW.getTime() / 1000), signedWith: "current", ...patch });
const rows = [{ source: "hn" as const, count: 205, recent: 4, last_seen: minutesAgo(5) }, { source: "bluesky" as const, count: 37042, recent: 900, last_seen: minutesAgo(30) },
  { source: "x" as const, count: 229, recent: 2, last_seen: minutesAgo(240) }];

describe("수집기 판정 — 운영 홈 SNS 칸과 같은 것", () => {
  it("유휴인 잡은 마지막 성공이 경보 기준(6주기·30분 바닥) 안이면 동작 중, 넘으면 수집 지연", () => {
    const hn = { now: NOW.getTime(), intervalMs: 30 * 60_000 };
    expect(socialCollectorRuntime(job(), true, false, hn)).toEqual({ status: "동작 중", tone: "green" });
    expect(socialCollectorRuntime(job({ lastSuccessAt: minutesAgo(179) }), true, false, hn)).toEqual({ status: "동작 중", tone: "green" });
    expect(socialCollectorRuntime(job({ lastSuccessAt: minutesAgo(181) }), true, false, hn)).toEqual({ status: "수집 지연", tone: "amber" });
    // 지금 돌고 있으면 실행 중, 사람이 멈췄거나 전체 수집이 꺼졌으면 수집 중지 — 지연으로 덮지 않는다
    expect(socialCollectorRuntime(job({ lastSuccessAt: minutesAgo(600), execution: "locked", runtimeLabel: "실행 중" }), true, false, hn).status).toBe("실행 중");
    expect(socialCollectorRuntime(job({ lastSuccessAt: minutesAgo(600), paused: true }), true, false, hn).status).toBe("수집 중지");
    expect(socialCollectorRuntime(job(), false, false, hn).status).toBe("수집 중지");
    expect(socialCollectorRuntime(job({ lastError: true, runtimeLabel: "오류" }), true, false, hn)).toEqual({ status: "오류", tone: "amber" });
  });

  it("jobs 한 행을 운영 홈 작업 판과 같은 멈춤·이름표·잠김으로 읽는다", () => {
    const base = { lockedAt: null, notBefore: null, lastRunAt: new Date(minutesAgo(10)), lastSuccessAt: new Date(minutesAgo(10)), lastError: null, requestedVersion: 0, processedVersion: 0 };
    expect(jobRuntimeState(base, NOW.getTime())).toEqual({ paused: false, runtimeLabel: "유휴", lastSuccessAt: minutesAgo(10), lastError: false, execution: "none" });
    expect(jobRuntimeState({ ...base, lockedAt: new Date(minutesAgo(1)) }, NOW.getTime())).toMatchObject({ runtimeLabel: "실행 중", execution: "locked" });
    expect(jobRuntimeState({ ...base, lockedAt: new Date(minutesAgo(5)) }, NOW.getTime())).toMatchObject({ runtimeLabel: "중단·회수 대기", execution: "stale" });
    expect(jobRuntimeState({ ...base, notBefore: new Date("2100-01-01T00:00:00Z") }, NOW.getTime())).toMatchObject({ paused: true });
  });

  it("출처마다 상태·주기·상세 링크 — X 는 외부 보고, GeekNews 는 수집 잡 없음", () => {
    const collectors = buildSocialCollectors({ rows, now: NOW, enabled: true,
      jobs: { "hn-talk": job(), "bluesky-talk": job({ lastSuccessAt: minutesAgo(13 * 60) }) },
      observations: [{ key: "x-status", value: xReport(), observedAt: minutesAgo(240) }] });
    const by = Object.fromEntries(collectors.map(row => [row.source, row]));
    expect(collectors.map(row => row.source)).toEqual(["hn", "bluesky", "x", "geeknews"]);
    expect(by.hn).toMatchObject({ status: "동작 중", tone: "green", note: "30분 주기 · crawler", statusHref: "/admin/status?tab=jobs&job=hn-talk", lastSuccessAt: minutesAgo(10), stored: 205 });
    expect(by.bluesky).toMatchObject({ status: "수집 지연", tone: "amber", note: "2시간 주기 · crawler", statusHref: "/admin/status?tab=jobs&job=bluesky-talk" });
    expect(by.x).toMatchObject({ status: "정상 보고", tone: "green", statusHref: "/admin/status?tab=crawlers", lastSuccessAt: minutesAgo(240) });
    expect(by.x.note).toContain("외부 수집기");
    expect(by.x.note).toContain("일일 보고 기준");
    expect(by.geeknews).toMatchObject({ status: "수집 잡 없음", tone: "gray", statusHref: null, lastSuccessAt: null, stored: 0 });
  });

  it("제 일을 못 한 회차가 이어지면 수집 미완료와 까닭, 잡·보고가 없으면 정상으로 보이지 않는다", () => {
    const degraded = { degraded: { code: "search_blocked", detail: null, critical: false, at: minutesAgo(5), streak: 3, since: minutesAgo(70) } };
    const collectors = buildSocialCollectors({ rows: [], now: NOW, enabled: true, jobs: { "hn-talk": job() },
      observations: [{ key: "job:hn-talk", value: degraded, observedAt: minutesAgo(5) }] });
    expect(collectors[0]).toMatchObject({ status: "수집 미완료", tone: "amber", note: "30분 주기 · crawler · search_blocked" });
    expect(collectors[1]).toMatchObject({ status: "작업 관측 미확인", tone: "gray" });
    expect(collectors[2]).toMatchObject({ status: "보고 없음", tone: "gray" });
    const late = buildSocialCollectors({ rows: [], now: NOW, enabled: true, jobs: {},
      observations: [{ key: "x-status", value: xReport(), observedAt: minutesAgo(27 * 60) }] });
    expect(late[2]).toMatchObject({ status: "보고 지연", tone: "amber" });
  });
});

describe("수집기 줄 읽기", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replica.mockImplementation((load: () => unknown) => load());
    mocks.transaction.mockImplementation((load: (tx: unknown) => unknown) => load({ execute: mocks.execute }));
    mocks.settings.mockResolvedValue({ enabled: true });
  });

  it("수집 잡 두 줄·관측·출처별 수만 복제본에서 읽고 제품 연결 수는 세지 않는다", async () => {
    const jobRow = { name: "hn-talk", lockedAt: null, notBefore: null, lastRunAt: new Date(), lastSuccessAt: new Date(), lastError: null, requestedVersion: 0, processedVersion: 0 };
    mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ source: "hn", count: 3, recent: 1, linked: 0, last_seen: null }]);
    mocks.select.mockImplementation(() => ({ from: () => ({ where: (condition: unknown) => {
      const text = new PgDialect().sqlToQuery(condition as never).sql;
      return Promise.resolve(text.includes('"jobs"') ? [jobRow] : []);
    } }) }));
    const status = await readSocialCollectors();
    expect(mocks.replica).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]).sql;
    expect(query).toContain("GROUP BY");
    expect(query).not.toContain("EXISTS");
    expect(status.collectors.map(row => [row.source, row.status])).toEqual([["hn", "동작 중"], ["bluesky", "작업 관측 미확인"], ["x", "보고 없음"], ["geeknews", "수집 잡 없음"]]);
    expect(status.collectors[0].stored).toBe(3);
  });
});

describe("SNS 탭의 수집기 줄", () => {
  const collector = (extra: Partial<SocialCollector>): SocialCollector => ({ source: "hn", label: "Hacker News", status: "동작 중", tone: "green",
    lastSuccessAt: minutesAgo(10), lastSeenAt: minutesAgo(5), stored: 205, new24h: 4, note: "30분 주기 · crawler", href: "/admin/status?tab=jobs&job=hn-talk",
    statusHref: "/admin/status?tab=jobs&job=hn-talk", ...extra });

  it("출처마다 상태·주기·마지막 성공·상세 링크를 보인다", () => {
    const html = renderToStaticMarkup(<SocialCollectorStripView data={{ measuredAt: NOW.toISOString(), collectors: [
      collector({}),
      collector({ source: "bluesky", label: "Bluesky", status: "수집 지연", tone: "amber", note: "2시간 주기 · crawler", statusHref: "/admin/status?tab=jobs&job=bluesky-talk" }),
      collector({ source: "x", label: "X", status: "정상 보고", note: "외부 수집기 · 매일 09:10 KST · 일일 보고 기준", statusHref: "/admin/status?tab=crawlers" }),
      collector({ source: "geeknews", label: "GeekNews", status: "수집 잡 없음", tone: "gray", lastSuccessAt: null, stored: 0, new24h: 0, note: "보관 글만 표시 · 현재 자동 잡 미등록", statusHref: null }),
    ] }} />);
    expect(html).toContain('aria-label="SNS 출처별 수집기 상태"');
    expect(html.match(/<li /g)).toHaveLength(4);
    expect(html).toContain('<span class="tag green">동작 중</span>');
    expect(html).toContain('<span class="tag amber">수집 지연</span>');
    expect(html).toContain('<span class="tag gray">수집 잡 없음</span>');
    expect(html).toContain('href="/admin/status?tab=jobs&amp;job=hn-talk"');
    expect(html).toContain('href="/admin/status?tab=jobs&amp;job=bluesky-talk"');
    expect(html).toContain('href="/admin/status?tab=crawlers">X 보고 상세 →');
    expect(html).toContain('href="/admin/content?tab=social&amp;source=geeknews"');
    expect(html).toContain("마지막 수집 성공");
    expect(html).toContain("보관 글 0건");
    // GeekNews 는 수집 잡이 없다 — 상세 링크·마지막 성공을 지어내지 않는다
    expect(html.split("GeekNews")[1]).not.toContain("작업 상세");
    expect(html.split("GeekNews")[1]).not.toContain("마지막 수집 성공");
  });

  it("못 읽으면 정상으로 보이지 않게 미확인이라고 말한다", () => {
    const html = renderToStaticMarkup(<SocialCollectorStripView data={null} />);
    expect(html).toContain("수집기 상태를 읽지 못했습니다");
    expect(html).toContain('href="/admin/status?tab=jobs"');
    expect(html).not.toContain("동작 중");
  });
});

describe("SNS 탭 목록·미리보기", () => {
  it("본문 없는 글을 「제목 없는 게시물」 대신 출처·가리킨 곳으로 부르고, 수집기 줄을 목록 위에 둔다", async () => {
    vi.resetModules();
    const listed = vi.fn();
    vi.doMock("@/lib/social/admin", () => ({ listTalkPostsWorkspacePage: listed, talkAdminFilter: () => ({ source: "all", state: "all", link: "all", talk: "all", sort: "recent" }) }));
    vi.doMock("@/lib/operations/flow-overview-read", () => ({ readSocialCollectors: async () => null }));
    vi.doMock("@/app/(operator)/admin/content/SocialCollectorStrip", () => ({ SocialCollectorStrip: () => <p>수집기 줄 자리</p> }));
    vi.doMock("@/app/(operator)/admin/content/PrototypeContentActions", () => ({ PrototypeContentActions: () => null, PrototypeHomeDecision: () => null }));
    vi.doMock("@/app/(operator)/admin/news/list", () => ({ listNewsPage: vi.fn(), newsFilter: vi.fn() }));
    vi.doMock("@/app/(operator)/admin/news/NewsSettingsForm", () => ({ NewsSettingsForm: () => null }));
    vi.doMock("@/app/(operator)/admin/ranking/RankingPolicyForm", () => ({ RankingPolicyForm: () => null }));
    vi.doMock("@/lib/domain/ranking/view", () => ({ getRankingAdminOverview: vi.fn() }));
    const base = { kind: "link", points: 3, comments: 1, postedAt: new Date(minutesAgo(30)), state: "visible", talk: { shown: false, reasons: ["공개 제품 아님"] } };
    listed.mockResolvedValue({ total: 3, rows: [
      { ...base, id: 11, source: "bluesky", externalId: "did:plc:abcdefghijklmnopqrstuvwx/3lbcdefghij2k", title: "", linkUrl: "https://acme.github.io/app/", linkTarget: "site", repositoryKey: null },
      { ...base, id: 12, source: "x", externalId: "1900000000000000001", title: "", linkUrl: "https://github.com/acme/app", linkTarget: "repo", repositoryKey: "acme/app" },
      { ...base, id: 13, source: "hn", externalId: "45001", title: "Show HN: Acme", linkUrl: "https://github.com/acme/app", linkTarget: "repo", repositoryKey: "acme/app" },
    ] });
    const { PrototypeSocialContent } = await import("@/app/(operator)/admin/content/PrototypeContentViews");
    const html = renderToStaticMarkup(await PrototypeSocialContent({ query: { tab: "social", sort: "recent" } }));
    expect(html).not.toContain("제목 없는 게시물");
    expect(html).toContain("Bluesky 게시물 · acme.github.io/app");
    expect(html).toContain("X 게시물 · acme/app");
    expect(html).toContain("Show HN: Acme");
    // 첫 글이 미리보기 — 이름표, 본문을 저장하지 않는다는 설명, 원문과 가리킨 곳 링크
    expect(html).toContain("<h3>Bluesky 게시물 · acme.github.io/app</h3>");
    expect(html).toContain("Bluesky 글은 본문·작성자를 저장하지 않아");
    expect(html).toContain('href="https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3lbcdefghij2k"');
    expect(html).toContain('href="https://acme.github.io/app/"');
    expect(html.indexOf("수집기 줄 자리")).toBeLessThan(html.indexOf("<table"));
    vi.resetModules();
  });
});
