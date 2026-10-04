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
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const mainCard = (p: ProductListItem) => renderToStaticMarkup(<ProjectCard product={p} saved={false}
  onToggleSave={() => {}} browseState={{ sort: "recent" }} />);

describe("home card activity", () => {
  it("shows public updates, the push date without a clock, and a measured zero separately", () => {
    const html = mainCard({ ...product, activity });
    expect(text(html)).toContain("최근 업데이트");
    expect(text(html)).toContain("최근 푸시");
    expect(text(html)).toContain("7일 푸시");
    expect(text(html)).toContain("0회");
    expect(html).toContain('dateTime="2026-10-04T01:30:00.000Z"');
    expect(html).toMatch(/<dt>최근 푸시<\/dt><dd><time[^>]*>2026\.10\.04<\/time><\/dd>/);
    expect(text(html)).not.toContain("10:30");
    expect(text(html)).not.toContain("KST");
  });

  it("keeps uncollected push counts absent while preserving a known push timestamp", () => {
    const html = mainCard({ ...product, activity: { ...activity, pushCount: null, pushObservedAt: null } });
    expect(text(html)).toContain("최근 푸시");
    expect(text(html)).not.toContain("7일 푸시");
    expect(text(html)).not.toContain("0회");
    expect(text(mainCard(product))).not.toContain("최근 푸시");
  });

  it("keeps the compact card's existing content and adds known activity", () => {
    const html = renderToStaticMarkup(<CompactCard product={{ ...product, activity }} trailing="category" />);
    expect(text(html)).toContain("A public product");
    expect(text(html)).toContain("최근 업데이트");
    expect(text(html)).toContain("최근 푸시");
    expect(text(html)).toContain("7일 푸시");
    expect(html).toMatch(/<dt>최근 푸시<\/dt><dd><time[^>]*>10\.04<\/time><\/dd>/);
    expect(text(html)).not.toContain("10:30");
  });

  it("identifies the category before the introduction in both card sizes", () => {
    for (const html of [mainCard(product), renderToStaticMarkup(<CompactCard product={product} trailing="category" />)]) {
      expect(html).toContain('<p class="card-category">개발 도구</p>');
      expect(html.indexOf('class="card-category"')).toBeLessThan(html.indexOf('class="' + (html.includes('project-tagline') ? 'project-tagline' : 'compact-tagline') + '"'));
      expect(text(html).match(/개발 도구/g)).toHaveLength(1);
    }
  });

  it("always labels AI introductions in both home card sizes", () => {
    const ai = { ...product, taglineSource: "ai_both" as const };
    expect(text(mainCard(ai))).toContain("AI가 요약 ·");
    expect(text(renderToStaticMarkup(<CompactCard product={ai} trailing="category" />))).toContain("AI가 요약 ·");
    expect(text(mainCard(product))).not.toContain("AI가 요약");
  });
});
