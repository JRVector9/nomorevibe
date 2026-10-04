import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactRow } from "@/components/home/CompactRow";
import type { ProductListItem } from "@/lib/domain/products/view";

const item = (slug: string, extra: Partial<ProductListItem> = {}): ProductListItem => ({
  slug, name: slug, tagline: `${slug} does things`, taglineSource: "maker", category: "Games",
  builder: null, builderClaim: "guessed", stack: [], ogImage: null, makerName: null,
  repoUrl: `https://github.com/acme/${slug}`, listedAt: new Date("2026-10-02T00:00:00Z"), status: "seeded",
  unclaimed: true, stars: 990, starsAt: new Date("2026-10-02T00:00:00Z"), starsPrevious: 1,
  starsPreviousAt: new Date("2026-10-01T00:00:00Z"), ...extra,
});

describe("가로 띠", () => {
  it("제목·설명·보기 링크와 작은 카드를 그린다", () => {
    const html = renderToStaticMarkup(createElement(CompactRow, {
      id: "rising", title: "지금 뜨는 프로젝트", note: "마지막 확인 사이 스타가 가장 많이 늘었습니다",
      more: { href: "/?sort=weekly", label: "1,574개 모두 보기" }, items: [item("a"), item("b")], trailing: "category",
    }));
    expect(html).toContain('id="rising"');
    expect(html).toContain("지금 뜨는 프로젝트");
    expect(html).toContain("1,574개 모두 보기");
    expect(html).toContain("★ 990");
    expect(html).toContain("+989");
    expect(html).toContain("게임");
  });
  it("아무것도 없으면 구획 자체를 내지 않는다", () => {
    expect(renderToStaticMarkup(createElement(CompactRow, { id: "new", title: "x", items: [], trailing: "listed" }))).toBe("");
  });
});
