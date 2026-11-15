import Link from "next/link";
import { createElement, Fragment, Suspense, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TalkBoard, TalkEntry } from "@/lib/social/talk";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";

/**
 * 공개 HTML 이름·요약만(2026-11-15 사람 결정) — 화제(홈 대표 구획·/talk·상세 띠)와 시즌 랭킹 화면.
 * 서버 HTML 의 글자와 RSC 데이터(브라우저 부품 속성)에 제품 값은 slug·이름·요약(+목록 자리 번호)뿐이고,
 * 글 제목·점수·스타·표지 주소·분류·저장소 열쇠·상태 배지는 표식 값으로 넣어 0개인지 본다. DB 없이 실제 부품을 대역 값으로 그린다.
 *
 * RSC 흉내(tests/public-html-payload.test.tsx 와 같은 방식): 서버 부품은 펼치고 "use client" 파일의 부품(vitest.config.ts 가 경계 표시를 단다)과
 * next/link 는 경계로 보고 그 속성을 JSON 으로 모은다. 경계 속성 안의 부품은 다시 펼친다.
 */
type Flight = { clientJson: string[]; text: string[]; boundaries: string[] };

const CONTEXT = Symbol.for("react.context");
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");

function isClient(type: unknown): boolean {
  return type === Link || (typeof type === "function" && (type as { $$nmvClientBoundary?: boolean }).$$nmvClientBoundary === true);
}

function serializeProps(props: Record<string, unknown>, nested: unknown[]): string {
  return JSON.stringify(props, (_key, value: unknown) => {
    if (isValidElement(value)) { nested.push(value); return "$element"; }
    if (typeof value === "function") return "$function";
    return value;
  });
}

async function walk(node: unknown, out: Flight): Promise<void> {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") { out.text.push(String(node)); return; }
  if (Array.isArray(node)) { for (const child of node) await walk(child, out); return; }
  if (node instanceof Promise) { await walk(await node, out); return; }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  const { type, props } = element;
  if (isClient(type)) {
    const nested: unknown[] = [];
    out.boundaries.push(typeof type === "function" ? type.name : "Link");
    out.clientJson.push(serializeProps(props, nested));
    for (const child of [props.children].flat()) if (typeof child === "string" || typeof child === "number") out.text.push(String(child));
    for (const child of nested) await walk(child, out);
    return;
  }
  if (typeof type === "string") {
    for (const [key, value] of Object.entries(props)) {
      if (key === "children") continue;
      if (key === "dangerouslySetInnerHTML") out.text.push(String((value as { __html?: string })?.__html ?? ""));
      else if (typeof value === "string") out.text.push(value);
    }
    await walk(props.children, out);
    return;
  }
  if (type === Fragment) { await walk(props.children, out); return; }
  if (type === Suspense) { await walk(props.fallback, out); await walk(props.children, out); return; }
  if (typeof type === "function") { await walk((type as (props: unknown) => unknown)(props), out); return; }
  const exotic = type as unknown as { $$typeof?: symbol; type?: unknown; render?: (props: unknown, ref: unknown) => unknown };
  if (exotic.$$typeof === CONTEXT) { await walk(props.children, out); return; }
  if (exotic.$$typeof === MEMO) { await walk({ ...element, type: exotic.type }, out); return; }
  if (exotic.$$typeof === FORWARD_REF && exotic.render) { await walk(exotic.render(props, null), out); return; }
  await walk(props.children, out);
}

async function flight(node: unknown): Promise<Flight & { json: string; html: string }> {
  const out: Flight = { clientJson: [], text: [], boundaries: [] };
  await walk(node, out);
  return { ...out, json: out.clientJson.join("\n"), html: out.text.join(" ") };
}

/** 숨길 칸의 표식 — 서버 글자·RSC 데이터·SSR HTML 어디에도 없어야 한다 */
const SENTINELS = ["SENTINEL_POST_TITLE", "987654", "987,654", "https://sentinel.example", "SENTINEL_CAT", "sentinel-owner", "SENTINEL_MAKER", "4,321", "news.ycombinator.com"];
const leaked = (text: string) => SENTINELS.filter((sentinel) => text.includes(sentinel));

/** RSC 데이터의 제품 객체 — slug 를 가진 객체의 열쇠는 slug·name·summary·lang·rank 와 자리 종류(mode·size)뿐 */
const ALLOWED_KEYS = new Set(["slug", "name", "summary", "lang", "rank", "mode", "size"]);
function productKeys(json: string): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.slug === "string") for (const key of Object.keys(record)) if (!ALLOWED_KEYS.has(key)) keys.add(key);
      Object.values(record).forEach(visit);
    }
  };
  for (const line of json.split("\n")) if (line) visit(JSON.parse(line));
  return [...keys];
}

// ---------------------------------------------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ talkVisibility: vi.fn(), listTalk: vi.fn(), getSeasonByKey: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), after: () => {}, connection: async () => {} }));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: mocks.talkVisibility, talkPublicEnabled: () => true }));
vi.mock("@/lib/social/talk", async (original) => ({ ...await original<typeof import("@/lib/social/talk")>(), listTalk: mocks.listTalk }));
vi.mock("@/lib/domain/ranking/view", () => ({ getSeasonByKey: mocks.getSeasonByKey }));

const { TalkHero } = await import("@/components/social/TalkHero");
const { TalkBandSlot, loadProductTalk } = await import("@/components/social/TalkBandSlot");
const { loadTalkBoard } = await import("@/components/social/TalkFill");
const { RankingTable, loadSeasonRows } = await import("@/components/RankingTable");
const { default: TalkPage } = await import("@/app/(public)/[locale]/(content)/talk/page");
const { default: RankingSeasonPage } = await import("@/app/(public)/[locale]/(content)/rankings/[key]/page");
const { getTranslator } = await import("@/lib/i18n/dictionary");
const { talkBoardResponse, productTalkData } = await import("@/lib/social/talk-wire");
const { rankingRowData } = await import("@/lib/domain/ranking/season-rows");

const post = (id: number): TalkEntry["posts"][number] => ({
  id: 70_000 + id, source: "hn", externalId: String(5000 + id), kind: "show", title: `SENTINEL_POST_TITLE ${id}`, linkTarget: "repo",
  postedAt: new Date("2026-11-14T00:00:00Z"), points: 987_654, comments: 987_654, frontPage: true,
});
const growth = {
  delta: 4_321, basis: "mention" as const, from: 987_654, fromAt: new Date("2026-11-13T00:00:00Z"), to: 991_975, toAt: new Date("2026-11-15T00:00:00Z"),
  points: [{ stars: 987_654, at: new Date("2026-11-13T00:00:00Z") }, { stars: 991_975, at: new Date("2026-11-15T00:00:00Z") }],
};
const entry = (rank: number): TalkEntry => ({
  rank, repositoryKey: `sentinel-owner/repo-${rank}`, score: 12.5, sources: ["hn"], byMaker: true, starGrowth: growth, homeDecision: rank === 1 ? "approved" : null,
  posts: [post(rank)],
  product: { id: 95_000 + rank, slug: `talk-${rank}`, name: `Talk Name ${rank}`, translationName: `Talk Name ${rank}`, tagline: `Talk summary ${rank}`,
    taglineKo: `화제 요약 ${rank}`, taglineSource: "maker", category: "SENTINEL_CAT", repoUrl: `https://github.com/sentinel-owner/repo-${rank}`,
    ogImage: `https://sentinel.example/og-${rank}.png`, stars: 987_654, aiLevel: 2, accessMode: "website" },
});
const board: TalkBoard = { mode: "now", entries: [entry(1), entry(2), entry(3)], unlisted: { active: 987_654, unknown: 0 }, checkedAt: new Date("2026-11-15T02:30:00Z") };

const season: SeasonSummary = {
  key: "2026-W46", cadence: "weekly", startsAt: new Date("2026-11-08T15:00:00Z"), endsAt: new Date("2026-11-15T15:00:00Z"),
  isTransition: false, effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: null, state: "active",
};
const rankingItem = {
  id: 95_401, slug: "ranked", name: "Ranked Name", tagline: "Ranked summary", taglineSource: "maker", taglineKo: "랭킹 요약", category: "SENTINEL_CAT", builder: null,
  builderClaim: "reported", stack: [], ogImage: "https://sentinel.example/ranked.png", makerName: "SENTINEL_MAKER", repoUrl: "https://github.com/sentinel-owner/ranked",
  listedAt: new Date("2026-11-01T00:00:00Z"), status: "verified", unclaimed: false, health: { down: true, since: null },
  rank: 3, validClicks: 987_654, uniqueVisitors: 17, recentUniqueVisitors: 6, previousUniqueVisitors: 4, scoreMode: "valid_visits",
  changePercent: -12, cooldownFactorBasisPoints: 7_500, previousRank: 5,
} as unknown as RankingListItem;

beforeEach(() => {
  mocks.talkVisibility.mockReset().mockResolvedValue({ visible: true, preview: false });
  mocks.listTalk.mockReset().mockResolvedValue(board);
  mocks.getSeasonByKey.mockReset().mockResolvedValue({ season, items: [rankingItem] });
});

/*
 * 받기 전 모양(서버 HTML)을 먼저 본다 — 채우기 값은 모듈에 남으므로(앱 안 이동 때 바로 그림) 채운 뒤 시험은 맨 뒤 describe 에 둔다.
 */
describe("서버 HTML·RSC 데이터에는 이름·요약만", () => {
  it("홈 대표 구획(TalkHero)", async () => {
    const hero = TalkHero({ lead: { ...entry(1), product: entry(1).product }, rest: [entry(2), entry(3)], sources: ["hn"],
      t: await getTranslator("ko", "browse"), locale: "ko", preview: false });
    const page = await flight(hero);
    for (const text of ["Talk Name 1", "화제 요약 1", "Talk Name 2", "/p/talk-3"]) expect(page.html + page.json).toContain(text);
    expect(leaked(page.html)).toEqual([]);
    expect(leaked(page.json)).toEqual([]);
    expect(productKeys(page.json)).toEqual([]);
    expect(page.boundaries).not.toContain("ProductTagline");
    // SSR HTML(브라우저 부품의 첫 그림 포함)도 같다 — 받기 전에는 글자 없는 자리
    const html = renderToStaticMarkup(hero);
    expect(leaked(html)).toEqual([]);
    expect(html).toContain('aria-busy="true"');
  });

  it("/talk", async () => {
    const node = await TalkPage({ searchParams: Promise.resolve({}) });
    const page = await flight(node);
    for (const text of ["Talk Name 1", "화제 요약 1", "Talk Name 3", "화제 요약 3", "/p/talk-2", "지금 1위"]) expect(page.html + page.json).toContain(text);
    expect(leaked(page.html)).toEqual([]);
    expect(leaked(page.json)).toEqual([]);
    expect(productKeys(page.json)).toEqual([]);
    const html = renderToStaticMarkup(node);
    expect(leaked(html)).toEqual([]);
    expect(html).not.toContain("화제가 된 순간");
    expect(html).not.toContain("마지막 확인");
    expect(html).toContain("집계 기준");
  });

  it("/rankings/[key]", async () => {
    const node = await RankingSeasonPage({ params: Promise.resolve({ locale: "ko", key: season.key }) } as PageProps<"/[locale]/rankings/[key]">);
    const page = await flight(node);
    expect(page.boundaries).toContain("RankingTable");
    const table = JSON.parse(page.clientJson[page.boundaries.indexOf("RankingTable")]);
    expect(table.rows).toEqual([{ slug: "ranked", name: "Ranked Name", summary: "랭킹 요약", lang: "ko", rank: 3 }]);
    expect(table.seasonKey).toBe("2026-W46");
    expect(table.details).toBeUndefined();
    for (const key of ['"status":', '"unclaimed":', '"health":', '"validClicks":', '"changePercent":', '"previousRank":', '"cooldownFactorBasisPoints":'])
      expect(page.json).not.toContain(key);
    expect(leaked(page.json)).toEqual([]);
    const html = renderToStaticMarkup(node);
    expect(leaked(html)).toEqual([]);
    // 시즌 규칙(접힘 안)에도 백분율이 있으니 표 부분만 본다
    const tableHtml = html.slice(0, html.indexOf("<details"));
    for (const text of ["✓ 검증됨", "응답 없음", "-12%", "75%", "지난 시즌 5위"]) expect(tableHtml).not.toContain(text);
    expect(html).toContain("Ranked Name");
    expect(html).toContain("랭킹 요약");
  });

  it("상세 화제 띠 자리(TalkBandSlot)는 slug 만 받고, 받기 전에는 아무것도 그리지 않는다", async () => {
    const page = await flight(createElement(TalkBandSlot, { slug: "talk-1" }));
    expect(page.clientJson).toEqual(['{"slug":"talk-1"}']);
    expect(renderToStaticMarkup(createElement(TalkBandSlot, { slug: "talk-1" }))).toBe("");
  });
});

describe("브라우저가 받은 뒤 채운다", () => {
  const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)));

  it("/talk: 표지·글·스타·곡선·확인 시각·타임라인·공개 전 수", async () => {
    const fetch = respond(talkBoardResponse(board, false));
    vi.stubGlobal("fetch", fetch);
    await loadTalkBoard("now", "ko");
    vi.unstubAllGlobals();
    expect(fetch).toHaveBeenCalledWith("/api/talk-board?mode=now&locale=ko", expect.anything());
    const html = renderToStaticMarkup(await TalkPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("SENTINEL_POST_TITLE 1");
    expect(html).toContain("987,654점 · 댓글 987,654");
    expect(html).toContain("+4,321");
    expect(html).toContain("화제가 된 순간");
    expect(html).toContain("마지막 확인");
    expect(html).toContain("출처 1곳");
    expect(html).toContain("화제인데 아직 공개되지 않은 저장소 987,654개");
    expect(html).not.toContain("aria-busy");
  });

  it("상세 화제 띠: 자격 글이 있으면 띠 전체를 그린다", async () => {
    const fetch = respond({ preview: false, talk: productTalkData({ posts: [post(1)], qualifies: true, rank: 2, sources: ["hn"], starGrowth: growth, checkedAt: board.checkedAt }) });
    vi.stubGlobal("fetch", fetch);
    await loadProductTalk("talk-1");
    vi.unstubAllGlobals();
    expect(fetch).toHaveBeenCalledWith("/api/products/talk-1/talk", expect.anything());
    const html = renderToStaticMarkup(createElement(TalkBandSlot, { slug: "talk-1" }));
    expect(html).toContain("SNS에서 화제 · 지금 2위");
    expect(html).toContain("SENTINEL_POST_TITLE 1");
    expect(html).toContain('href="https://news.ycombinator.com/item?id=5001"');
  });

  it("랭킹 표: 점수·변동·가중치·지난 순위·배지를 채운다", async () => {
    const fetch = respond({ items: [rankingRowData(rankingItem)] });
    vi.stubGlobal("fetch", fetch);
    await loadSeasonRows("2026-W46");
    vi.unstubAllGlobals();
    expect(fetch).toHaveBeenCalledWith("/api/rankings/2026-W46", expect.anything());
    const html = renderToStaticMarkup(createElement(RankingTable, {
      rows: [{ slug: "ranked", name: "Ranked Name", summary: "랭킹 요약", lang: "ko", rank: 3 }], seasonKey: "2026-W46", windowHours: 24, scoreMode: "valid_visits",
    }));
    for (const text of ["987,654", "-12%", "75%", "지난 시즌 5위", "✓ 검증됨", "응답 없음"]) expect(html).toContain(text);
    expect(html).not.toContain("aria-busy");
  });

  it("못 받으면 자리를 거둔다 — 대기 문구·오류 문구 없이 이름·요약·링크만 남는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    expect(await loadSeasonRows("2026-W47")).toBeNull();
    expect(await loadTalkBoard("week", "ko")).toBeNull();
    vi.unstubAllGlobals();
    // 실패는 담지 않으므로 다시 그리면 받기 전 모양(자리) — 자리를 거두는 것은 받은 뒤의 상태(done)로만 정해진다
    const html = renderToStaticMarkup(createElement(RankingTable, {
      rows: [{ slug: "ranked", name: "Ranked Name", summary: "랭킹 요약", rank: 3 }], details: [], windowHours: 24, scoreMode: "valid_visits",
    }));
    expect(html).toContain("Ranked Name");
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("987,654");
  });
});
