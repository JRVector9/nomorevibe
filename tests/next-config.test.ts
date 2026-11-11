import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.NEXT_DEPLOYMENT_ID;
  delete process.env.NMV_RELEASE_BUILD_ID;
  delete process.env.SKIP_NEXT_TYPECHECK;
  vi.resetModules();
});

describe("Next.js multi-instance configuration", () => {
  /**
   * 릴리스 값은 빌드 ID 로 쓴다 — deploymentId 면 정적 파일마다 `?dpl=` 이 붙어 배포마다 엣지·브라우저 캐시가 빈다(2026-11-11).
   * Next 는 환경변수 NEXT_DEPLOYMENT_ID 를 설정보다 앞세워 deploymentId 로 쓰므로 설정을 읽으면 그 이름이 사라져야 한다.
   */
  it("uses the shared release as the build ID, never as deploymentId", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "tree-7c78110";

    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
    expect(process.env.NEXT_DEPLOYMENT_ID).toBeUndefined();
    expect(await config.generateBuildId!()).toBe("tree-7c78110");
    // 같은 프로세스에서 설정을 다시 읽어도(빌드가 여러 번 읽는다) 같은 빌드 ID 다
    vi.resetModules();
    const { default: again } = await import("../next.config");
    expect(again.deploymentId).toBeUndefined();
    expect(await again.generateBuildId!()).toBe("tree-7c78110");
  });

  it("refuses a release value that cannot be a build directory name", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "tree/../../x";
    await expect(import("../next.config")).rejects.toThrow(/release build id/);
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
    // 상세는 4분 동안 그 사본, 그 뒤 하루 동안은 첫 요청이 지난 사본을 받으며 새로 받게 한다 — 고친 것·내린 것은 지우기가 없앤다
    expect(edge("/p/:slug")?.headers[0].value).toBe("max-age=240, stale-while-revalidate=86400, stale-if-error=3600");
    expect(edge("/en/p/:slug")?.headers[0].value).toBe("max-age=240, stale-while-revalidate=86400, stale-if-error=3600");
    expect(edge("/c/:category")?.headers[0].value).toBe("max-age=60, stale-while-revalidate=60, stale-if-error=3600");
    for (const source of ["/", "/popular", "/rankings/:key", "/p/:slug"]) {
      expect(edge(source)?.missing).toEqual([{ type: "cookie", key: "nmv_admin" }, { type: "cookie", key: "nmv_user" },
        { type: "cookie", key: "nmv_login_nonce" }, { type: "query", key: "q" },
        { type: "cookie", key: "nmv_render_recovery", value: "1" }]);
    }
    // 방문자 브라우저용 Cache-Control 은 건드리지 않는다
    expect(rules.flatMap((rule) => rule.headers).some((header) => header.key.toLowerCase() === "cache-control")).toBe(false);
    expect(rules.find(rule => rule.has?.some(condition => condition.type === "cookie" && condition.key === "nmv_render_recovery")))
      .toMatchObject({ source: "/:path*", has: [{ type: "cookie", key: "nmv_render_recovery", value: "1" }],
        headers: [{ key: "Cloudflare-CDN-Cache-Control", value: "no-store" }] });
  });

  it("does not invent a deployment ID or build ID for local builds", async () => {
    const { default: config } = await import("../next.config");

    expect(config.deploymentId).toBeUndefined();
    // null 이면 Next 가 빌드마다 임의 ID 를 짓는다
    expect(await config.generateBuildId!()).toBeNull();
  });

  /**
   * 정적 파일은 원 서버의 Cache-Control 만 따른다 — 있으면 `public, max-age=31536000, immutable`, 없는 파일(롤링 중 다른 판의 이름)의
   * 404 는 `private, no-cache, no-store` 라 Cloudflare 가 저장하지 않는다. `?dpl=` 이 없어진 뒤로 404 가 저장되면 그 이름이 1년 막히므로
   * Cloudflare 용 저장 시간을 /_next/static 에 붙이는 규칙이 생기지 않게 지킨다(쿠키 우회 규칙의 no-store 는 괜찮다).
   */
  it("never gives Next static files an edge cache time that a 404 would inherit", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const storing = rules.filter((rule) => rule.headers.some((header) => header.key === "Cloudflare-CDN-Cache-Control"
      && header.value !== "no-store"));
    for (const rule of storing) {
      expect(rule.source.startsWith("/_next"), rule.source).toBe(false);
      expect(rule.source.startsWith("/:"), rule.source).toBe(false);
    }
  });

  it("keeps the build's own type check unless CI says the same tree was already checked", async () => {
    expect((await import("../next.config")).default.typescript?.ignoreBuildErrors).toBe(false);
    vi.resetModules();
    process.env.SKIP_NEXT_TYPECHECK = "true";
    expect((await import("../next.config")).default.typescript?.ignoreBuildErrors).toBe(false);
    vi.resetModules();
    process.env.SKIP_NEXT_TYPECHECK = "1";
    expect((await import("../next.config")).default.typescript?.ignoreBuildErrors).toBe(true);
  });
});
