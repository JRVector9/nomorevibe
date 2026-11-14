import { afterEach, describe, expect, it } from "vitest";
import { GET, dynamic } from "@/app/llms.txt/route";
import { isLocaleExcludedPath, localePath } from "@/lib/i18n/routing";

afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; });
describe("anti-scrape SEO llms.txt", () => {
  it("keeps the machine URL outside locale rewrites and canonical redirects", () => {
    expect(isLocaleExcludedPath("/llms.txt")).toBe(true);
    expect(localePath("ko", "/llms.txt")).toBe("/llms.txt");
    expect(localePath("en", "/llms.txt")).toBe("/llms.txt");
  });
  it("preserves existing machine endpoint matching without capturing similar public paths", () => {
    for (const path of ["/api", "/admin", "/_next", "/go", "/badge", "/webhooks", "/oauth"]) {
      expect(isLocaleExcludedPath(path)).toBe(true);
      expect(isLocaleExcludedPath(`${path}/child`)).toBe(true);
      expect(isLocaleExcludedPath(`${path}-product`)).toBe(false);
    }
    for (const path of ["/feed.xml", "/sitemap.xml", "/sitemap", "/sitemaps", "/robots.txt", "/llms.txt", "/manifest.webmanifest", "/install.sh", "/skill.md"]) {
      expect(isLocaleExcludedPath(path)).toBe(true);
      expect(isLocaleExcludedPath(`${path}/child`)).toBe(true);
      expect(isLocaleExcludedPath(`${path}-product`)).toBe(false);
    }
    for (const path of ["/p/llms.txt", "/p/sitemap.xml", "/c/robots.txt", "/rankings/llms.txt", "/feedback/llms.txt"]) expect(isLocaleExcludedPath(path)).toBe(false);
  });
  it("responds with compact, cacheable navigation, citation guidance and training refusal", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://nomorevibe.com/";
    const response = GET();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=3600");
    expect(text).toContain("# NoMoreVibe");
    expect(text).toContain("canonical URL");
    expect(text).toContain("credit the maker and original sources");
    expect(text).toContain("training datasets is prohibited");
    for (const path of ["/popular", "/rising", "/p/<slug>", "/policy", "/sitemap.xml", "/robots.txt"]) expect(text).toContain(`https://nomorevibe.com${path}`);
    expect(text).not.toContain("localhost");
    expect(Buffer.byteLength(text)).toBeLessThan(3000);
    expect(dynamic).toBe("force-dynamic");
  });
  it("reads the canonical origin at request time", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://first.test";
    expect(await GET().text()).toContain("https://first.test/sitemap.xml");
    process.env.NEXT_PUBLIC_SITE_URL = "https://second.test/";
    expect(await GET().text()).toContain("https://second.test/sitemap.xml");
  });
});
