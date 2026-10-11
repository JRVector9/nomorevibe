import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactCard } from "@/components/home/CompactCard";
import { ProjectCard } from "@/components/home/ProjectCard";
import { ProjectTile } from "@/components/home/ProjectTile";
import { ProductIcon } from "@/components/ProductIcon";
import { ogVariantSrcSet, variantAtLeast, variantSize } from "@/lib/domain/products/og-variants";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 2026-10-08 점검 PERF-03(첫 줄 그림을 늦게 받음)·PERF-04(작은 칸에 큰 그림) */

const OG = "/api/og-cache/card-product?thumbnail=og&w=1200&h=630&v=1";
const ICON = (w: number) => `/api/og-cache/card-product?thumbnail=site_icon&w=${w}&h=${w}&v=1`;
const product: ProductListItem = {
  slug: "card-product", name: "Card Product", tagline: "A product on a card", taglineSource: "maker",
  category: "Dev", builder: null, builderClaim: "reported", stack: [], ogImage: OG,
  makerName: null, repoUrl: null, listedAt: new Date("2026-06-01T00:00:00Z"),
  status: "verified", unclaimed: false,
};
const img = (html: string) => html.match(/<img [^>]*>/)?.[0] ?? "";
const tile = (props: { size: 64 | 44; priority?: boolean; ogImage?: string | null }) =>
  img(renderToStaticMarkup(<ProjectTile slug="card-product" name="Card Product" ogImage={props.ogImage ?? OG} size={props.size} priority={props.priority} />));

describe("커버 그림 받는 차례 (PERF-03)", () => {
  it("기본은 늦게 받고, 첫 줄(priority)은 바로·먼저 받는다", () => {
    expect(tile({ size: 64 })).toContain('loading="lazy"');
    expect(tile({ size: 64 })).not.toContain("fetchPriority");
    const first = tile({ size: 64, priority: true });
    expect(first).toContain('loading="eager"');
    expect(first).toContain('fetchPriority="high"');
  });

  it("카드가 priority 를 커버까지 넘긴다", () => {
    const main = renderToStaticMarkup(<ProjectCard product={product} saved={false} onToggleSave={() => {}} browseState={{ sort: "recent" }} priority />);
    expect(img(main)).toContain('loading="eager"');
    expect(img(renderToStaticMarkup(<CompactCard product={product} trailing="category" priority />))).toContain('loading="eager"');
    expect(img(renderToStaticMarkup(<CompactCard product={product} trailing="category" />))).toContain('loading="lazy"');
  });
});

describe("칸 크기에 맞는 사본 (PERF-04)", () => {
  it("커버는 320·640 srcSet 과 칸 폭(sizes)을 준다 — 지금까지 받던 640 보다 크게 받지 않는다", () => {
    const big = tile({ size: 64 });
    expect(big).toContain('src="/api/og-cache/card-product.webp?thumbnail=og&amp;w=1200&amp;h=630&amp;v=1&amp;size=640"');
    expect(big).toContain('srcSet="/api/og-cache/card-product.webp?thumbnail=og&amp;w=1200&amp;h=630&amp;v=1&amp;size=320 320w, /api/og-cache/card-product.webp?thumbnail=og&amp;w=1200&amp;h=630&amp;v=1&amp;size=640 640w"');
    expect(big).toContain('sizes="(max-width: 652px) 100vw, (max-width: 1004px) 50vw, 340px"');
    expect(tile({ size: 44 })).toContain('sizes="(max-width: 640px) 75vw, 220px"');
  });

  it("작은 아이콘은 칸에 맞는 사본 — 28px 칸에 192px 를 받지 않는다", () => {
    const small = img(renderToStaticMarkup(<ProductIcon name="Card Product" ogImage={ICON(256)} size={28} />));
    expect(small).toContain("size=64");
    expect(small).not.toContain("srcSet");
    const mid = img(renderToStaticMarkup(<ProductIcon name="Card Product" ogImage={ICON(256)} size={44} />));
    expect(mid).toMatch(/src="[^"]*size=96"/);
    expect(mid).toMatch(/srcSet="[^"]*size=64 1x, [^"]*size=96 2x"/);
    // 상세 머리(80px)는 지금처럼 192 — 1배 화면은 96
    const hero = img(renderToStaticMarkup(<ProductIcon name="Card Product" ogImage={ICON(256)} size={80} />));
    expect(hero).toMatch(/src="[^"]*size=192"/);
    expect(hero).toMatch(/srcSet="[^"]*size=96 1x, [^"]*size=192 2x"/);
  });

  it("사본 크기 고르기와 허용 목록", () => {
    expect(variantAtLeast(28)).toBe(64);
    expect(variantAtLeast(56)).toBe(64);
    expect(variantAtLeast(160)).toBe(192);
    expect(variantAtLeast(5000)).toBe(1200);
    expect(variantSize("64")).toBe(64);
    // 우리 사본이 아니면 크기를 고를 수 없다
    expect(ogVariantSrcSet("https://cdn.example/x.png", [320, 640])).toBeNull();
    expect(ogVariantSrcSet(null, [320, 640])).toBeNull();
  });
});
