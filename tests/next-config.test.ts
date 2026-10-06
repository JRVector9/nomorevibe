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
    // 방문자 브라우저용 Cache-Control 은 건드리지 않는다
    expect(rules.flatMap((rule) => rule.headers).some((header) => header.key.toLowerCase() === "cache-control")).toBe(false);
  });

  it("does not invent a deployment ID for local builds", async () => {
    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
  });
});
