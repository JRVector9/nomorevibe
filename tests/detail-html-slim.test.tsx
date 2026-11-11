import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FreshnessView, ProductUpdateView, PublicProduct } from "@/lib/domain/products/detail-view";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { HomePulseView } from "@/components/home/types";

/**
 * 상세·홈 HTML 줄이기(2026-11-11) — 브라우저 부품에는 읽는 칸만, 닫힌 창의 속은 열 때.
 * 보이는 첫 화면은 그대로이고 RSC 데이터(HTML 안 self.__next_f)에 실리는 값만 줄인다.
 */

const navigation = vi.hoisted(() => ({ metric: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(navigation.metric ? `metric=${navigation.metric}` : ""),
}));

const { detailClientProduct, detailFreshness, timelineSummary, TIMELINE_LIMIT } = await import("@/components/product-detail/client-data");
const { compactCardItem } = await import("@/components/home/compact-item");
const { LicenseDialog } = await import("@/components/product-detail/LicenseDialog");
const { MethodologyDialog } = await import("@/components/home/MethodologyDialog");

const product: PublicProduct = {
  id: 7, slug: "simple-hwp", url: "https://github.com/example/simple-hwp", accessMode: "installable", name: "Simple HWP",
  tagline: "Reads HWP files", taglineSource: "maker", description: "A very long description ".repeat(40), category: "Productivity",
  builder: null, stack: ["TypeScript"], ogImage: "/api/og-cache/simple-hwp", makerName: null, repoUrl: "https://github.com/example/simple-hwp",
  status: "seeded", source: "crawler", claimedAt: null, verifiedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"), stars: 120, starsAt: new Date("2026-11-10T00:00:00Z"), starsPrevious: 100,
  starsPreviousAt: new Date("2026-11-09T00:00:00Z"), auditHoldAt: null, repoGone: false, aiEvidence: true, takedownPending: false,
  taglineKo: "HWP 파일을 읽습니다", translationName: "Simple HWP", translationEligible: true,
};

describe("상세 브라우저 부품에 넘기는 값", () => {
  it("제품은 부품이 읽는 칸만 — 긴 설명·내부 시각·색인 판단 값은 서버에 남는다", () => {
    const client = detailClientProduct(product);
    expect(Object.keys(client).sort()).toEqual(["accessMode", "category", "createdAt", "makerName", "name", "ogImage", "repoGone", "repoUrl",
      "slug", "stack", "stars", "status", "tagline", "taglineKo", "taglineSource", "translation", "url"]);
    expect(JSON.stringify(client)).not.toContain("A very long description");
  });

  it("출처는 어디서·언제 읽었는지만 — 원본 수집 값(GitHub 응답 사본)은 넘기지 않는다", () => {
    const raw = { kind: "repository", provider: "github", state: "current", label: "최신", lastSuccessAt: new Date("2026-11-10T00:00:00Z"),
      lastFailureAt: null, nextAttemptAt: new Date(), normalizedFacts: { _githubCollection: { etag: "secret-ish" } } } as unknown as FreshnessView;
    expect(detailFreshness([raw])).toEqual([{ provider: "github", lastSuccessAt: raw.lastSuccessAt }]);
  });

  it("업데이트는 그릴 세 줄과 두 수만", () => {
    const now = new Date("2026-11-11T00:00:00Z");
    const updates: ProductUpdateView[] = Array.from({ length: 50 }, (_, index) => ({
      id: index, sourceKind: "activity_digest", sourceLabel: "자동 감지", canonicalUrl: null, title: `update ${index}`,
      summary: "long summary ".repeat(30), beforeAfter: { stars: { before: 1, after: 2 } },
      publishedAt: new Date(now.getTime() - index * 2 * 86_400_000), observedAt: now, makerEditedAt: null,
    }));
    const summary = timelineSummary(updates, now);
    expect(summary.rows).toHaveLength(TIMELINE_LIMIT);
    expect(summary).toMatchObject({ total: 50, recent: 16 });
    expect(JSON.stringify(summary)).not.toContain("long summary");
  });

  it("상세 화면은 부품에 고른 값을 넘긴다", () => {
    const source = readFileSync("app/(public)/[locale]/(content)/p/[slug]/page.tsx", "utf8");
    for (const part of ["ProductHero", "FactsStrip", "InfoCard", "PreviewFigure"]) expect(source).toMatch(new RegExp(`<${part} product=\\{clientProduct\\}`));
    expect(source).toContain("freshness={detailFreshness(detail.freshness)}");
    expect(source).toContain("<UpdateTimeline summary={timelineSummary(detail.updates, now)}");
    expect(source).toContain("<RelatedRow category={product.category} items={relatedCards}");
    // 서버 부품(소개·README)은 원래 제품을 받는다 — 설명·발췌는 서버에서만 쓴다
    expect(source).toContain("<IntroSection product={product}");
    expect(source).toContain("<ReadmeSection product={product}");
  });
});

describe("가로 띠 카드 값", () => {
  const item: ProductListItem & { starGrowth?: { gain: number; stars: number; baselineStars: number; observedAt: string; baselineObservedAt: string } } = {
    id: 3, translationName: "Card", slug: "card", name: "Card", tagline: "A card", taglineSource: "maker", taglineKo: "카드", category: "Dev",
    accessMode: "website", builder: "claude", builderClaim: "guessed", stack: ["Go"], ogImage: null, makerName: "maker", repoUrl: "https://github.com/a/b",
    repoRenamedTo: null, listedAt: new Date("2026-10-01T00:00:00Z"), status: "seeded", unclaimed: true, stars: 10, starsAt: null,
    starsPrevious: 8, starsPreviousAt: null, health: { down: false, since: null }, activity: { updatedAt: null, pushedAt: null, pushCount: null, pushObservedAt: null },
    aiLevel: 2,
  };

  it("카드가 그리는 칸만 넘기고, 한국어 소개는 한국어 화면에만", () => {
    const ko = compactCardItem(item, "ko");
    expect(Object.keys(ko).sort()).toEqual(["accessMode", "aiLevel", "category", "listedAt", "name", "ogImage", "slug", "stars", "starsAt",
      "starsPrevious", "starsPreviousAt", "tagline", "taglineKo", "taglineSource"]);
    expect(compactCardItem(item, "en")).not.toHaveProperty("taglineKo");
  });

  it("8시간 증가가 있으면 스타 관측 넷 대신 그것만", () => {
    const growth = { ...item, starGrowth: { gain: 2, stars: 10, baselineStars: 8, observedAt: "2026-11-11T00:00:00Z", baselineObservedAt: "2026-11-10T16:00:00Z" } };
    const card = compactCardItem(growth, "ko");
    expect(card.starGrowth).toEqual(growth.starGrowth);
    expect(card).not.toHaveProperty("starsPrevious");
  });

  it("같은 목록 행은 같은 카드 객체 — 두 번 그려도 RSC 데이터에 한 번만 실린다", () => {
    expect(compactCardItem(item, "ko")).toBe(compactCardItem(item, "ko"));
    expect(compactCardItem(item, "en")).not.toBe(compactCardItem(item, "ko"));
  });
});

describe("닫힌 창의 속은 열 때 그린다", () => {
  it("라이선스 창 — 단추와 빈 창만 서버가 그리고 비교 표는 없다", () => {
    const html = renderToStaticMarkup(createElement(LicenseDialog, {
      license: { state: "observed_only", label: "GitHub에서 확인", maker: null,
        observed: { value: "MIT License", spdxId: "MIT", url: null, sourceLabel: "GitHub에서 확인" } },
      source: null, repositoryUrl: "https://github.com/example/simple-hwp", label: "MIT",
    }));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/<dialog[^>]*><\/dialog>/);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("opensource.org");
    const source = readFileSync("components/product-detail/LicenseDialog.tsx", "utf8");
    // 처음 열 때 속을 먼저 그리고 연다 — showModal 이 창 속 제목·첫 초점을 찾는다
    expect(source.indexOf("flushSync(() => setMounted(true))")).toBeLessThan(source.indexOf("node.showModal()"));
  });

  const pulse: HomePulseView = {
    asOf: "2026-10-10T00:00:00Z", asOfLabel: "10월 10일", timezone: "Asia/Seoul", methodVersion: "1",
    born: { current: 1, previous: 1, change: null }, updates: { projects: 0, releases: 0 }, active: [], categories: [], tools: null, total: 10,
  };

  it("집계 기준 창 — 주소에 metric 이 없으면 본문을 그리지 않고, 있으면 서버도 그린다", () => {
    navigation.metric = "";
    const closed = renderToStaticMarkup(createElement(MethodologyDialog, { pulse }));
    expect(closed).toContain('id="dialog-title"');
    expect(closed).not.toContain("modal-body");
    navigation.metric = "all";
    expect(renderToStaticMarkup(createElement(MethodologyDialog, { pulse }))).toContain("modal-body");
  });
});
