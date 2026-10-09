import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCard } from "@/components/home/ProjectCard";
import { CompactCard } from "@/components/home/CompactCard";
import type { ProductListItem } from "@/lib/domain/products/view";

const product: ProductListItem = {
  slug: "activity-product", name: "Activity Product", tagline: "A public product", taglineSource: "maker",
  category: "Dev", builder: null, builderClaim: "reported", stack: [], ogImage: "/api/og-cache/activity-product",
  makerName: null, repoUrl: "https://github.com/maker/product", listedAt: new Date("2026-10-01T00:00:00Z"),
  status: "verified", unclaimed: false, stars: 10, starsAt: null, starsPrevious: null, starsPreviousAt: null,
};
const activity = {
  updatedAt: "2026-10-03T12:00:00.000Z", pushedAt: "2026-10-04T01:30:00.000Z",
  pushCount: 0, pushObservedAt: "2026-10-04T03:00:00.000Z",
};
const NOW = new Date("2026-10-07T02:00:00.000Z");
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const mainCard = (p: ProductListItem) => renderToStaticMarkup(<ProjectCard product={p} saved={false}
  onToggleSave={() => {}} browseState={{ sort: "recent" }} now={NOW} />);

describe("home card activity", () => {
  it("shows only the latest update as one '최근 업데이트 n일 전' piece, with the exact time in the tooltip", () => {
    const html = mainCard({ ...product, activity });
    // 공개 업데이트(10/3)보다 코드 업데이트(10/4 10:30 KST)가 늦다 — 그 하나만
    expect(text(html)).toContain("최근 업데이트 3일 전");
    expect(html).toContain('dateTime="2026-10-04T01:30:00.000Z"');
    expect(html).toContain('title="최근 코드 업데이트 10월 4일 10:30"');
    // 날짜 여러 줄·빈 집계·KST·옛말은 카드에 없다
    for (const gone of ["최근 푸시", "7일 푸시", "0회", "KST", "card-activity"]) expect(html).not.toContain(gone);
  });

  it("uses the public update when it is the later one, and draws nothing for uncollected activity", () => {
    const later = mainCard({ ...product, activity: { ...activity, updatedAt: "2026-10-06T23:00:00.000Z", pushCount: null, pushObservedAt: null } });
    expect(text(later)).toContain("최근 업데이트 3시간 전");
    expect(later).toContain('title="최근 업데이트 10월 7일 08:00"');
    expect(text(mainCard(product))).not.toContain("업데이트");
  });

  it("keeps the compact card to its one meta line without activity", () => {
    const html = renderToStaticMarkup(<CompactCard product={{ ...product, activity }} trailing="category" />);
    expect(text(html)).toContain("A public product");
    expect(text(html)).toContain("★ 10");
    expect(text(html)).toContain("개발 도구");
    expect(text(html)).not.toContain("업데이트");
    expect(text(html)).not.toContain("0회");
  });

  it("always labels AI introductions in both home card sizes", () => {
    const ai = { ...product, taglineSource: "ai_both" as const };
    expect(text(mainCard(ai))).toContain("AI가 요약 ·");
    expect(text(renderToStaticMarkup(<CompactCard product={ai} trailing="category" />))).toContain("AI가 요약 ·");
    expect(text(mainCard(product))).not.toContain("AI가 요약");
  });
});
