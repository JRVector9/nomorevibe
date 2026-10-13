import { describe, expect, it } from "vitest";

/** 등록 안내(/launch)와 sitemap 도 Cloudflare 가 저장하게 한다(PERF-05·SEO-07) */
describe("Cloudflare 저장 규칙 — /launch·/sitemap.xml", async () => {
  const { default: config } = await import("../next.config");
  const rules = await config.headers!();
  const header = (source: string, key: string) => rules
    .filter((rule) => rule.source === source)
    .flatMap((rule) => rule.headers.filter((item) => item.key === key).map((item) => ({ rule, value: item.value })));

  it("/launch 는 게재 기준처럼 10분, 배포 때 html 태그로 지운다", () => {
    expect(header("/launch", "Cache-Tag").map((item) => item.value)).toEqual(["html"]);
    const [edge] = header("/launch", "Cloudflare-CDN-Cache-Control");
    expect(edge.value).toBe("max-age=600, stale-while-revalidate=60, stale-if-error=3600");
    expect(edge.rule.missing).toEqual([{ type: "cookie", key: "nmv_admin" }, { type: "cookie", key: "nmv_user" },
      { type: "cookie", key: "nmv_login_nonce" }, { type: "query", key: "q" }]);
  });

  it("/sitemap.xml 은 한 시간, 제품이 내려가면 목록과 함께 지운다", () => {
    expect(header("/sitemap.xml", "Cache-Tag").map((item) => item.value)).toEqual(["html,lists"]);
    expect(header("/sitemap.xml", "Cloudflare-CDN-Cache-Control").map((item) => item.value))
      .toEqual(["max-age=3600, stale-while-revalidate=60, stale-if-error=3600"]);
  });
});
