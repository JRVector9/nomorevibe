import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { SeasonSummary } from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";

/**
 * 사이트 틀(UX-10·UX-21·UX-26·UX-09) — 아래 탭·푸터·없는 주소·오류 화면·게재 기준·푸터 시즌 줄.
 * 서버 컴포넌트는 그린 HTML 을 보고, DB·Next 요청 API 는 가짜로 바꾼다.
 */
const mocks = vi.hoisted(() => ({
  pathname: "/",
  push: vi.fn(),
  getPublicList: vi.fn(),
  getCurrentSeason: vi.fn(),
  getSeasonHistory: vi.fn(),
  seasonKeysWithEntries: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/domain/products/public-reads", () => ({
  publicRead: (_kind: string, _key: unknown[], load: () => Promise<unknown>) => load(),
}));
vi.mock("@/lib/domain/products/view", () => ({ getPublicList: mocks.getPublicList }));
vi.mock("@/lib/domain/ranking/view", () => ({
  RANKING_STALE_MS: 2 * 60 * 60 * 1000,
  getCurrentSeason: mocks.getCurrentSeason,
  getSeasonHistory: mocks.getSeasonHistory,
}));
vi.mock("@/lib/domain/ranking/season-entries", () => ({ seasonKeysWithEntries: mocks.seasonKeysWithEntries }));

const { MobileNav } = await import("@/components/home/MobileNav");
const { SiteFooter } = await import("@/components/home/SiteFooter");
const { default: NotFound, metadata: notFoundMetadata } = await import("@/app/not-found");
const { default: RouteError } = await import("@/app/error");
const { default: GlobalError } = await import("@/app/global-error");
const { default: PolicyPage, metadata: policyMetadata } = await import("@/app/policy/page");
const { default: SeasonFooterSlot } = await import("@/app/@seasonfooter/page");

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const render = async (pending: Promise<React.ReactNode> | React.ReactNode) => {
  const node = await pending;
  return renderToStaticMarkup(createElement(() => node));
};

beforeEach(() => {
  mocks.pathname = "/";
  mocks.push.mockReset();
  mocks.getPublicList.mockReset();
  mocks.getCurrentSeason.mockReset();
  mocks.getSeasonHistory.mockReset();
  mocks.seasonKeysWithEntries.mockReset();
});

describe("모바일 아래 탭", () => {
  it("발견·검색·인기·저장 순서이고 인기는 /popular 로 간다 — 공개 탭은 없다", () => {
    const html = renderToStaticMarkup(createElement(MobileNav));
    const labels = [...html.matchAll(/<\/svg>([^<]+)<\/(?:a|button)>/g)].map((match) => match[1]);

    expect(labels).toEqual(["발견", "검색", "인기", "저장"]);
    expect(hrefs(html)).toEqual(["/", "/popular"]);
    expect(html).not.toContain("/launch");
    expect(html).not.toContain("#popular");
    // 발견(격자)과 인기는 다른 그림이다
    expect(html.match(/<rect /g)).toHaveLength(4);
  });

  it("지금 있는 탭을 켠다 — 분야 화면은 발견, /popular 는 인기", () => {
    mocks.pathname = "/c/finance";
    expect(renderToStaticMarkup(createElement(MobileNav))).toContain('class="active" href="/"');
    mocks.pathname = "/popular";
    expect(renderToStaticMarkup(createElement(MobileNav))).toContain('class="active" href="/popular"');
    mocks.pathname = "/p/some";
    expect(renderToStaticMarkup(createElement(MobileNav))).not.toContain("active");
  });

  it("관리자 화면에서는 그리지 않는다", () => {
    mocks.pathname = "/admin/products";
    expect(renderToStaticMarkup(createElement(MobileNav))).toBe("");
  });
});

describe("푸터", () => {
  it("한국어 슬로건과 게재 기준 링크(/policy#listing)", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter, null, null));
    expect(html).toContain("만들고, 세상에 내놓으세요.");
    expect(html).not.toContain("Build something");
    expect(hrefs(html)).toContain("/policy#listing");
    expect(html).not.toContain("/launch#policy");
  });
});

const rising = (slug: string): ProductListItem => ({
  slug, name: `Rising ${slug}`, tagline: `${slug} 소개`, taglineSource: "maker", category: "Dev",
  builder: null, builderClaim: "guessed", stack: [], ogImage: null, makerName: null, repoUrl: null,
  listedAt: new Date("2026-10-01T00:00:00Z"), status: "seeded", unclaimed: true,
});

describe("없는 주소", () => {
  it("한국어 안내·검색창·지금 뜨는 다섯·홈 링크", async () => {
    mocks.getPublicList.mockResolvedValue(["a", "b", "c", "d", "e"].map(rising));

    const html = await render(NotFound());

    expect(notFoundMetadata.title).toBe("페이지를 찾을 수 없습니다 — nomorevibe");
    expect(html).toContain("찾는 페이지가 없거나 내려갔습니다");
    expect(html).toMatch(/<form role="search"[^>]* action="\/" method="get"/);
    expect(html).toContain('name="q"');
    expect(html).toContain("지금 뜨는 프로젝트");
    expect(mocks.getPublicList).toHaveBeenCalledWith(5, { sort: "rising", rising: true });
    for (const slug of ["a", "b", "c", "d", "e"]) expect(hrefs(html)).toContain(`/p/${slug}`);
    expect(hrefs(html)).toContain("/");
    expect(html).not.toContain("This page could not be found");
  });

  it("목록을 못 읽어도 안내와 검색창은 선다", async () => {
    mocks.getPublicList.mockRejectedValue(new Error("db down"));

    const html = await render(NotFound());

    expect(html).toContain("찾는 페이지가 없거나 내려갔습니다");
    expect(html).toContain('name="q"');
    expect(html).not.toContain("지금 뜨는 프로젝트");
  });
});

describe("오류 화면", () => {
  it("본문 오류 — 한국어 문구와 다시 시도", () => {
    const html = renderToStaticMarkup(createElement(RouteError, { error: Object.assign(new Error("x"), { digest: "abc123" }), retry: () => {} }));
    expect(html).toContain("화면을 불러오지 못했습니다");
    expect(html).toContain(">다시 시도</button>");
    expect(html).toContain("오류 번호 abc123");
    expect(hrefs(html)).toEqual(["/"]);
  });

  it("루트 오류 — 문서째 그리고 제목·다시 시도를 단다", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: new Error("x"), retry: () => {} }));
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain("<title>오류 — nomorevibe</title>");
    expect(html).toContain("사이트를 불러오지 못했습니다");
    expect(html).toContain(">다시 시도</button>");
    expect(html).not.toContain("오류 번호");
  });
});

describe("게재 기준", () => {
  it("다른 화면이 가리키는 앵커를 모두 갖고, 이메일 주소를 싣지 않는다", async () => {
    const html = await render(PolicyPage());

    expect(policyMetadata.title).toBe("게재 기준 — nomorevibe");
    for (const id of ["listing", "ai-evidence", "excluded", "unclaimed", "takedown", "contact"]) {
      expect(html).toContain(`id="${id}"`);
      expect(hrefs(html)).toContain(`#${id}`);
    }
    expect(html).toContain("24시간 안에 확인");
    expect(html).toContain("확인하기 전에도 바로 검색엔진 노출을 멈춥니다");
    expect(html).toContain("운영자 미확인");
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(html).not.toContain("mailto:");
  });
});

const season = (key: string, state: SeasonSummary["state"]): SeasonSummary => ({
  key, cadence: "weekly", startsAt: new Date("2026-10-04T15:00:00Z"), endsAt: new Date("2026-10-11T15:00:00Z"),
  isTransition: false, effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: null, state,
});

describe("푸터 시즌 줄", () => {
  it("이번 시즌에 순위가 없으면 줄째로 그리지 않는다", async () => {
    mocks.getCurrentSeason.mockResolvedValue(season("2026-W41", "active"));
    mocks.getSeasonHistory.mockResolvedValue([season("2026-W40", "closed")]);
    mocks.seasonKeysWithEntries.mockResolvedValue([]);

    expect(await SeasonFooterSlot()).toBeNull();
    expect(mocks.seasonKeysWithEntries).toHaveBeenCalledWith(["2026-W41", "2026-W40"]);
  });

  it("순위가 있으면 이름으로 그리고, 빈 지난 시즌으로는 보내지 않는다", async () => {
    mocks.getCurrentSeason.mockResolvedValue(season("2026-W41", "active"));
    mocks.getSeasonHistory.mockResolvedValue([season("2026-W40", "closed")]);
    mocks.seasonKeysWithEntries.mockResolvedValue(["2026-W41"]);

    const html = await render(SeasonFooterSlot());

    expect(html).toContain("2026년 41주");
    expect(html).not.toContain("KST");
    expect(hrefs(html)).toEqual(["/rankings/2026-W41"]);
  });

  it("지난 시즌에도 순위가 있으면 링크를 둔다", async () => {
    mocks.getCurrentSeason.mockResolvedValue(season("2026-W41", "active"));
    mocks.getSeasonHistory.mockResolvedValue([season("2026-W40", "closed")]);
    mocks.seasonKeysWithEntries.mockResolvedValue(["2026-W40", "2026-W41"]);

    expect(hrefs(await render(SeasonFooterSlot()))).toEqual(["/rankings/2026-W41", "/rankings/2026-W40"]);
  });
});
