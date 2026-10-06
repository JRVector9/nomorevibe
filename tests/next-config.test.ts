import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.NEXT_DEPLOYMENT_ID;
  vi.resetModules();
});

describe("Next.js multi-instance configuration", () => {
  it("uses the shared deployment ID supplied for a release", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "release-7c78110";

    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBe("release-7c78110");
  });

  it("tags cacheable public pages so Cloudflare can purge them by name", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const tagOf = (source: string) => rules.find((rule) => rule.source === source)?.headers
      .find((header) => header.key === "Cache-Tag")?.value;

    expect(tagOf("/")).toBe("html,lists");
    expect(tagOf("/popular")).toBe("html,lists");
    expect(tagOf("/rankings/:key")).toBe("html,lists");
    expect(tagOf("/p/:slug")).toBe("html,p-:slug");
    // CloudFront 는 같은 값을 x-amz-meta-cache-tag 에서 읽는다(Cloudflare 가 Cache-Tag 를 떼므로)
    const amzOf = (source: string) => rules.find((rule) => rule.source === source)?.headers
      .find((header) => header.key === "x-amz-meta-cache-tag")?.value;
    for (const source of ["/", "/popular", "/rankings/:key", "/p/:slug"]) expect(amzOf(source)).toBe(tagOf(source));
  });

  it("tells only Cloudflare how long to keep public pages, never for admins or searches", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const edge = (source: string) => rules.find((rule) => rule.source === source
      && rule.headers.some((header) => header.key === "Cloudflare-CDN-Cache-Control"));

    expect(edge("/")?.headers[0].value).toBe("max-age=60, stale-while-revalidate=60, stale-if-error=3600");
    expect(edge("/popular")?.headers[0].value).toBe("max-age=60, stale-while-revalidate=60, stale-if-error=3600");
    expect(edge("/rankings/:key")?.headers[0].value).toBe("max-age=60, stale-while-revalidate=60, stale-if-error=3600");
    // 상세는 4분 + 지난 사본 1분 — 늦어도 5분
    expect(edge("/p/:slug")?.headers[0].value).toBe("max-age=240, stale-while-revalidate=60, stale-if-error=3600");
    for (const source of ["/", "/popular", "/rankings/:key", "/p/:slug"]) {
      expect(edge(source)?.missing).toEqual([{ type: "cookie", key: "nmv_admin" }, { type: "query", key: "q" }]);
    }
  });

  it("tells CloudFront the same lifetimes in Cache-Control, only for plain HTML or matching RSC requests", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const cdnRules = rules.filter((rule) => rule.headers.some((header) => header.key === "Cache-Control"));
    const value = (rule: (typeof rules)[number], key: string) => rule.headers.find((header) => header.key === key)?.value;
    const personal = [{ type: "cookie", key: "nmv_admin" }, { type: "query", key: "q" }];

    // 경로마다 HTML 하나·RSC 하나 — 그 밖의 규칙은 Cache-Control 을 건드리지 않는다
    expect(cdnRules.map((rule) => rule.source)).toEqual(["/", "/", "/popular", "/popular", "/rankings/:key", "/rankings/:key", "/p/:slug", "/p/:slug"]);
    for (const rule of cdnRules) {
      const seconds = rule.source === "/p/:slug" ? 240 : 60;
      expect(value(rule, "Cache-Control")).toBe(`public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=60, stale-if-error=3600`);
      // 브라우저에는 지금처럼 저장하지 말라고 — CloudFront 함수가 이 값으로 되돌린다
      expect(value(rule, "X-NMV-Browser-Cache")).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
    }
    const [html, rsc] = cdnRules.filter((rule) => rule.source === "/p/:slug");
    expect(html.has).toBeUndefined();
    expect(html.missing).toEqual([...personal, { type: "header", key: "rsc" }, { type: "query", key: "_rsc" }]);
    expect(rsc.has).toEqual([{ type: "header", key: "rsc", value: "1" }, { type: "query", key: "_rsc" }]);
    expect(rsc.missing).toEqual(personal);
  });

  it("does not invent a deployment ID for local builds", async () => {
    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
  });
});
