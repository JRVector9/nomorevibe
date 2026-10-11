import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XMLParser } from "fast-xml-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";

/**
 * 2026-10-08 점검 남은 것(10-11 재확인) — /launch 배지 대비(A11Y-02)·제목 단계(A11Y-05),
 * 랭킹 시즌 표 라벨 줄바꿈(ROB-04), 게재 기준 AI 문구(UX-21), 피드 항목 제목(SEO-05).
 * DB·Next 요청 API 는 가짜로 바꾼다.
 */
const mocks = vi.hoisted(() => ({
  listRecentlyDiscovered: vi.fn(),
  getSeasonByKey: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("@/lib/domain/products/repository", () => ({ listRecentlyDiscovered: mocks.listRecentlyDiscovered }));
vi.mock("@/lib/domain/ranking/view", () => ({ getSeasonByKey: mocks.getSeasonByKey }));

const { default: LaunchPage } = await import("@/app/launch/page");
const { default: PolicyPage } = await import("@/app/policy/page");
const { default: RankingSeasonPage, generateMetadata: rankingMetadata } = await import("@/app/rankings/[key]/page");
const { SeasonPolicy } = await import("@/components/SeasonPolicy");
const { GET: feed } = await import("@/app/feed.xml/route");

/** 그린 HTML 의 제목 단계를 차례대로 */
const headingLevels = (html: string) => [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
/** 앞 제목보다 두 단계 이상 깊어지는 곳이 없어야 한다 */
const skips = (levels: number[]) => levels.filter((level, index) => index > 0 && level > levels[index - 1] + 1);

beforeEach(() => {
  mocks.listRecentlyDiscovered.mockReset();
  mocks.getSeasonByKey.mockReset();
});

describe("/launch", () => {
  it("'/nomorevibe' 배지 글자는 accent-ink — accent 는 accent-soft 위 4.0:1 로 AA 미달", async () => {
    const html = renderToStaticMarkup(await LaunchPage());
    const badge = html.match(/<span class="([^"]*)">\/nomorevibe<\/span>/);
    expect(badge?.[1]).toContain("text-accent-ink");
    expect(badge?.[1].split(" ")).not.toContain("text-accent");
  });

  it("h1 다음에 h3 로 건너뛰지 않는다", async () => {
    const levels = headingLevels(renderToStaticMarkup(await LaunchPage()));
    expect(levels[0]).toBe(1);
    expect(skips(levels)).toEqual([]);
  });
});

const season: SeasonSummary = {
  key: "2026-W41", cadence: "weekly", startsAt: new Date("2026-10-04T15:00:00Z"), endsAt: new Date("2026-10-11T15:00:00Z"),
  isTransition: false, effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: null, state: "active",
};

describe("랭킹 시즌", () => {
  it("집계 기준 라벨은 줄바꿈하지 않고, 값 쪽이 줄어든다", () => {
    const html = renderToStaticMarkup(createElement(SeasonPolicy, { season, now: new Date("2026-10-09T00:00:00Z") }));
    const dts = [...html.matchAll(/<dt class="([^"]*)">([^<]*)<\/dt>/g)];
    expect(dts.map((match) => match[2])).toContain("유효 방문 기준");
    for (const [, className] of dts) expect(className).toContain("whitespace-nowrap");
    for (const [, className] of html.matchAll(/<dd class="([^"]*)">/g)) expect(className).toContain("min-w-0");
  });

  it("h1 → h2(집계 기준) → h3(묶음 제목) — 단계를 건너뛰지 않는다", async () => {
    mocks.getSeasonByKey.mockResolvedValue({ season, items: [] });

    const html = renderToStaticMarkup(await RankingSeasonPage({ params: Promise.resolve({ key: "2026-W41" }) } as PageProps<"/rankings/[key]">));

    expect(html).toContain(">집계 기준</h2>");
    const levels = headingLevels(html);
    expect(levels.slice(0, 3)).toEqual([1, 2, 3]);
    expect(skips(levels)).toEqual([]);
  });

  it("없는 시즌은 홈 제목이 아니라 '페이지를 찾을 수 없습니다'", async () => {
    mocks.getSeasonByKey.mockResolvedValue(null);

    const metadata = await rankingMetadata({ params: Promise.resolve({ key: "2099-W01" }) } as PageProps<"/rankings/[key]">);

    expect(metadata.title).toBe("페이지를 찾을 수 없습니다 — nomorevibe");
  });
});

describe("게재 기준 — AI 근거", () => {
  it("공개 화면과 맞춘다 — 'AI' 표시 하나, 근거 링크는 싣지 않는다", async () => {
    const html = renderToStaticMarkup(await PolicyPage());
    const section = html.slice(html.indexOf('id="ai-evidence"'), html.indexOf('id="excluded"'));

    expect(section).not.toContain("근거 링크와 함께");
    expect(section).toContain("‘AI’ 표시가 붙습니다");
    expect(section).toContain("공개 화면에 싣지 않습니다");
    expect(section).toContain("AI 없이 만들었다는 뜻도 아닙니다");
    expect(section).toContain("지금 AI 코딩 도구로 개발하고 있으면");
    expect(section).not.toMatch(/[1-3]\s*단계/);
  });
});

/** listRecentlyDiscovered 가 돌려주는 행 — toListItem 이 읽는 값만 */
const row = (slug: string, status: "verified" | "seeded", extra: Record<string, unknown> = {}) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), status, tagline: `${slug} tagline`, taglineSource: "readme", taglineKo: null,
  category: "Dev", accessMode: "web", aiLevel: null, source: status === "verified" ? "skill" : "crawler", claimedAt: null,
  builder: null, stack: [], ogImage: null, makerName: null, repoUrl: null, repoRenamedTo: null, repoGone: false,
  stars: null, starsAt: null, starsPrevious: null, starsPreviousAt: null,
  listedAt: new Date("2026-10-10T00:00:00Z"), createdAt: new Date("2026-10-10T00:00:00Z"),
  ...extra,
});

describe("feed.xml", () => {
  it("항목 제목에 상태 꼬리표를 붙이지 않고, 상태는 분류로 싣는다", async () => {
    mocks.listRecentlyDiscovered.mockResolvedValue([
      row("mine", "verified"),
      row("found", "seeded", { taglineKo: "  한국어 한 줄 소개  " }),
    ]);

    const res = await feed(new Request("https://nomorevibe.test/feed.xml"), { params: Promise.resolve({}) });
    const xml = await res.text();
    const items = new XMLParser().parse(xml).rss.channel.item as { title: string; description: string; category: string[] }[];

    expect(items.map((item) => item.title)).toEqual(["Mine", "Found"]);
    expect(xml).not.toContain("— 운영자 미확인");
    expect(xml).not.toContain("— ✓ 검증됨");
    expect(items[0].category).toEqual(["Dev", "✓ 검증됨"]);
    expect(items[1].category).toEqual(["Dev", "운영자 미확인"]);
    // 상세 설명과 같은 순서 — 한국어 한 줄이 있으면 그것, 없으면 원문
    expect(items[0].description).toBe("mine tagline");
    expect(items[1].description).toBe("한국어 한 줄 소개");
  });
});
