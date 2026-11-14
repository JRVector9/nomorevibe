import { afterEach, describe, expect, it, vi } from "vitest";
import { paginationRestartHref, publicListMaxPages, publicPaginationBlocked } from "@/lib/web/public-pagination";

const { sitemapRows } = vi.hoisted(() => ({ sitemapRows: vi.fn() }));
vi.mock("@/lib/db", () => ({
  onReplica: (read: () => unknown) => read(),
  db: { select: () => ({ from: () => ({ where: () => ({ orderBy: sitemapRows }) }) }) },
}));
import { productSitemapEntries } from "@/lib/domain/products/sitemap";

afterEach(() => vi.unstubAllEnvs());

describe("anti-scrape pagination limits", () => {
  it("allows initial slices and the configured inclusive boundary", () => {
    vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "100");
    for (const page of [undefined, "1", "2", "100"]) {
      expect(publicPaginationBlocked({ page }, "page")).toBe(false);
      expect(publicPaginationBlocked({ new: "1", page }, "home")).toBe(false);
    }
    for (const shown of [undefined, "9", "18", "900"]) {
      expect(publicPaginationBlocked({ shown, q: "PDF" }, "home")).toBe(false);
    }
  });

  it("blocks deep page and cumulative shown before they become DB offsets", () => {
    vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "100");
    expect(publicPaginationBlocked({ page: "101" }, "page")).toBe(true);
    expect(publicPaginationBlocked({ page: "101", new: "1" }, "home")).toBe(true);
    expect(publicPaginationBlocked({ shown: "901" }, "home")).toBe(true);
    // Each screen checks only the parameter actually used to load its list.
    expect(publicPaginationBlocked({ page: "999999", shown: "18" }, "home")).toBe(false);
    expect(publicPaginationBlocked({ shown: "999999", new: "1", page: "2" }, "home")).toBe(false);
  });

  it.each(["", "0", "-1", "1.5", "1e2", "Infinity", "NaN", " 2 ", "2x", "0x10", "01", "99999999999999999999999", ["2", "99999"]])(
    "rejects malformed or ambiguous input %j", (raw) => {
      expect(publicPaginationBlocked({ page: raw }, "page")).toBe(true);
      expect(publicPaginationBlocked({ shown: raw }, "home")).toBe(true);
    },
  );

  it("honors server configuration and defaults safely on invalid configuration", () => {
    vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "25");
    expect(publicPaginationBlocked({ shown: "225" }, "home")).toBe(false);
    expect(publicPaginationBlocked({ shown: "226" }, "home")).toBe(true);
    expect(publicPaginationBlocked({ page: "26" }, "page")).toBe(true);
    for (const value of ["", "0", "-1", "1e3", "not-a-number", String(Number.MAX_SAFE_INTEGER)]) {
      expect(publicListMaxPages(value)).toBe(100);
    }
  });

  it("restarts the same list retaining search, filters, locale and snapshot", () => {
    expect(paginationRestartHref("/en/c/dev", { q: "PDF tools", sort: "recent", shown: "901", page: "101", _rsc: "private" }))
      .toBe("/en/c/dev?q=PDF+tools&sort=recent");
    expect(paginationRestartHref("/rising", { page: "101", cycle: "2026-11-14", view: "cards" }))
      .toBe("/rising?cycle=2026-11-14&view=cards");
  });

  it("keeps sitemap product URLs beyond the list boundary available", async () => {
    vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "1");
    // A product far beyond either list window still uses the unchanged ID-range sitemap reader.
    const updatedAt = new Date("2026-11-14T00:00:00Z");
    sitemapRows.mockResolvedValueOnce([{ id: 20001, slug: "deep-product", name: "Deep", tagline: "Tool", description: null, updatedAt, contentEligible: true }]);
    const entries = await productSitemapEntries("ko", 2);
    expect(entries).toHaveLength(1);
    expect(new URL(entries[0].url).pathname).toBe("/p/deep-product");
    expect(entries[0].lastModified).toEqual(updatedAt);
  });
});
