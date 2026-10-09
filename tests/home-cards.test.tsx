import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactCard } from "@/components/home/CompactCard";
import { ProjectCard } from "@/components/home/ProjectCard";
import { ProjectTile } from "@/components/home/ProjectTile";
import { ProductIcon } from "@/components/ProductIcon";
import { StarMetric } from "@/components/StarMetric";
import { StatusBadge } from "@/components/TrustBadges";
import { BRAND } from "@/lib/copy/brand";
import { PREVIEW_IMAGE_LABEL, UNCLAIMED_LABEL } from "@/lib/copy/terms";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import type { ProductListItem } from "@/lib/domain/products/view";
import { formatPublicDate } from "@/lib/format/time";

/** 2026-10-08 UX 감사 UX-29(메타 한 줄·별 0·±0), UX-30(카드 하나 = 링크 하나), UX-32(아이콘 자리) */

const NOW = new Date("2026-10-09T03:00:00.000Z");
const product: ProductListItem = {
  slug: "card-product", name: "Card Product", tagline: "A product on a card", taglineSource: "maker",
  category: "Dev", builder: null, builderClaim: "reported", stack: [], ogImage: null,
  makerName: null, repoUrl: "https://github.com/maker/card-product", listedAt: new Date("2026-06-01T00:00:00Z"),
  status: "verified", unclaimed: false, stars: 120, starsAt: null, starsPrevious: null, starsPreviousAt: null,
  activity: { updatedAt: null, pushedAt: "2026-10-06T03:00:00.000Z", pushCount: 0, pushObservedAt: "2026-10-09T00:00:00.000Z" },
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const mainCard = (p: Partial<ProductListItem> = {}) => renderToStaticMarkup(<ProjectCard product={{ ...product, ...p }} saved={false}
  onToggleSave={() => {}} browseState={{ sort: "recent" }} now={NOW} />);
const compactCard = (p: Partial<ProductListItem> = {}, trailing: "category" | "listed" = "category") =>
  renderToStaticMarkup(<CompactCard product={{ ...product, ...p }} trailing={trailing} />);
/** 카드 안 /p/ 링크 — 키보드가 멈추는 것(tabindex=-1 이 아닌 것)과 아닌 것 */
const productLinks = (html: string) => [...html.matchAll(/<a [^>]*href="\/p\/card-product"[^>]*>/g)].map((match) => match[0]);
/** 한 요소의 안쪽 HTML(같은 태그가 안에 겹치지 않는 경우) */
const inner = (html: string, className: string, tag = "div") =>
  html.match(new RegExp(`<${tag} class="${className}"[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";

describe("카드 하나 = 링크 하나 (UX-30)", () => {
  it("lets the title link cover the card and keeps the cover link out of Tab order and screen readers", () => {
    const links = productLinks(mainCard());
    expect(links).toHaveLength(2);
    const focusable = links.filter((link) => !link.includes('tabindex="-1"'));
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toContain('class="card-link"');
    const cover = links.find((link) => link.includes('tabindex="-1"'))!;
    expect(cover).toContain('aria-hidden="true"');
    expect(cover).not.toContain("aria-label");
  });

  it("keeps the save button and the GitHub owner link as the only other stops", () => {
    const html = mainCard();
    expect(html).toMatch(/<button type="button" class="cover-saved"[^>]*aria-label="Card Product 저장"/);
    expect(html).toContain('<a class="card-owner" href="https://github.com/maker"');
    expect([...html.matchAll(/<a /g)]).toHaveLength(3);
  });

  it("gives compact cards a single focusable link too", () => {
    const links = productLinks(compactCard());
    expect(links.filter((link) => !link.includes('tabindex="-1"'))).toHaveLength(1);
    expect(links.find((link) => link.includes('tabindex="-1"'))).toContain('aria-hidden="true"');
  });
});

describe("메타 한 줄 (UX-29)", () => {
  it("draws '분야 · 최근 업데이트 n일 전' in one meta line next to the stars", () => {
    const html = mainCard();
    expect(html.match(/class="card-meta"/g)).toHaveLength(1);
    const meta = inner(html, "card-meta");
    expect(text(meta)).toBe("개발 도구 최근 업데이트 3일 전 ★ 120");
    // 줄을 늘리던 활동 목록·빈 집계는 없다
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("0회");
  });

  it("keeps the compact meta to one line with the listing day only on the new strip", () => {
    // 작은 카드는 서버에서 지금 시각으로 그린다 — 기대값도 같은 함수로
    const listedAt = new Date(Date.now() - 2 * 86_400_000);
    expect(text(inner(compactCard({ listedAt }, "listed"), "card-meta card-meta-compact card-dots", "p")))
      .toBe(`★ 120 개발 도구 ${formatPublicDate(listedAt, new Date())}`);
    expect(text(inner(compactCard(), "card-meta card-meta-compact card-dots", "p"))).toBe("★ 120 개발 도구");
  });

  it("hides a zero star count and says '새 프로젝트' only for a recent listing", () => {
    const fresh = mainCard({ stars: 0, listedAt: new Date("2026-10-01T00:00:00Z") });
    expect(fresh).not.toContain("★");
    expect(text(fresh)).toContain("새 프로젝트");
    expect(fresh).toContain('title="10월 1일 등록"');
    const old = mainCard({ stars: 0, listedAt: new Date("2026-06-01T00:00:00Z") });
    expect(old).not.toContain("★");
    expect(old).not.toContain("새 프로젝트");
  });

  it("never prints '±0' and formats real changes with separators", () => {
    const observed = { starsAt: "2026-10-08T12:00:00Z", starsPreviousAt: "2026-10-07T12:00:00Z" };
    const flat = renderToStaticMarkup(<StarMetric value={{ stars: 990, starsPrevious: 990, ...observed }} now={NOW} />);
    expect(flat).not.toContain("±0");
    expect(flat).not.toContain("<small");
    const up = renderToStaticMarkup(<StarMetric value={{ stars: 12_345, starsPrevious: 11_111, ...observed }} now={NOW} />);
    expect(text(up)).toBe("★ 12,345 +1,234");
    expect(up).toContain("이전 측정 대비 +1,234 (10월 7일 21:00 → 10월 8일 21:00)");
  });

  it("reads PostgreSQL timestamp text as UTC in the star tooltip", () => {
    const value = { stars: 5, starsPrevious: 4 };
    expect(renderToStaticMarkup(<StarMetric value={{ ...value, starsAt: "2026-09-13 13:00:00", starsPreviousAt: "2026-09-12 13:00:00" }} now={NOW} />))
      .toBe(renderToStaticMarkup(<StarMetric value={{ ...value, starsAt: "2026-09-13T13:00:00Z", starsPreviousAt: "2026-09-12T13:00:00Z" }} now={NOW} />));
  });
});

describe("아이콘 자리 (UX-32)", () => {
  const thumb = (kind: string, w = 256, h = 256) => `/api/og-cache/card-product?thumbnail=${kind}&w=${w}&h=${h}&v=1`;
  const icon = (ogImage: string | null, name = "Card Product", category?: string) =>
    renderToStaticMarkup(<ProductIcon name={name} ogImage={ogImage} size={80} category={category} />);

  it("shows only site icons and GitHub avatars as images", () => {
    expect(icon(thumb("site_icon", 32, 32))).toContain("<img");
    expect(icon(thumb("github_avatar"))).toContain("<img");
    for (const banner of [thumb("og", 1200, 630), thumb("repository_image", 512, 128), thumb("repository_image", 400, 400),
      thumb("default", 320, 320), "/api/og-cache/card-product", "https://tracker.example/og.png"]) {
      expect(icon(banner)).not.toContain("<img");
      expect(icon(banner)).toContain("product-monogram");
    }
  });

  it("falls back to a monogram tile coloured by the category token", () => {
    const html = icon(null, "card product", "Dev");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("background:var(--tile-day)");
    expect(text(html)).toBe("C");
    expect(icon(null, "x", "Finance")).toContain("background:var(--tile-invoice)");
    expect(text(icon(null, "@scope/pkg"))).toBe("S");
    expect(text(icon(null, "모아 2"))).toBe("모");
    // 분야를 모르면 이름으로 — 같은 이름은 늘 같은 색
    expect(icon(null, "Same")).toBe(icon(null, "Same"));
  });

  it("puts banners and README images in the card cover, never in the icon square", () => {
    const tile = (ogImage: string | null) =>
      renderToStaticMarkup(<ProjectTile slug="card-product" name="Card Product" ogImage={ogImage} size={64} category="Dev" />);
    expect(tile(thumb("og", 1200, 630))).toMatch(/<img [^>]*class="tile-preview"/);
    expect(tile(thumb("repository_image", 400, 400))).toMatch(/<img [^>]*class="tile-preview tile-preview-readme"/);
    expect(tile(thumb("site_icon", 64, 64))).toMatch(/<span class="tile-icon"><img /);
    for (const none of [null, thumb("default", 320, 320)]) {
      expect(tile(none)).not.toContain("<img");
      expect(tile(none)).toContain("background:var(--tile-day)");
    }
  });
});

describe("카드의 용어 (UX-14)", () => {
  it("uses the shared terms and brand", () => {
    const unclaimed = renderToStaticMarkup(<StatusBadge status="seeded" unclaimed />);
    expect(unclaimed).toContain(UNCLAIMED_LABEL);
    expect(unclaimed).not.toContain("미클레임");
    expect(renderToStaticMarkup(<StatusBadge status="verified" unclaimed={false} />)).toContain(`${BRAND}가 직접 확인`);
    expect(thumbnailPresentation("/api/og-cache/x?thumbnail=og&w=1200&h=630").label).toBe(PREVIEW_IMAGE_LABEL);
  });
});
