import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker/Dokploy 배포용 — .next/standalone만 복사해도 동작하게
  output: "standalone",

  // 두 웹 인스턴스와 롤링 배포 사이의 asset/action 버전 불일치를 감지한다.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,

  /**
   * DB 드라이버를 번들에 넣지 않고 node_modules에 남긴다.
   *
   * 기본 동작은 서버 의존성을 번들에 인라인하는 것인데, 그러면 standalone의
   * node_modules에 이 패키지들이 없어서 빌드 산출물 밖의 스크립트가 쓸 수 없다.
   * 마이그레이션 실행기(scripts/migrate.mjs)가 이것들을 import한다.
   *
   * DB 드라이버는 외부화하는 것이 권장 방식이기도 하다.
   */
  serverExternalPackages: ["postgres", "drizzle-orm"],

  // skill/SKILL.md는 빌드 산출물이 아니므로 명시적으로 포함시켜야 /skill.md가 런타임에 읽을 수 있다
  outputFileTracingIncludes: {
    "/skill.md": ["./skill/SKILL.md"],
  },

  /**
   * Cloudflare 캐시 태그 — 저장한 사본을 골라 지울 이름표다(Cloudflare 가 방문자에게 보내기 전에 뗀다).
   * 화면 이동용(RSC) 사본은 `?_rsc=` 주소가 제각각이라 주소로는 다 못 지운다. 태그는 갈래를 함께 지운다.
   * html: 배포 뒤 옛 화면 · lists: 제품이 내려가면 목록 화면 전체 · p-<slug>: 그 상세 화면(2026-10-06).
   */
  async headers() {
    // CloudFront 는 태그를 x-amz-meta-cache-tag 에서 읽는다(CacheTagConfig) — Cloudflare 가 Cache-Tag 를 떼므로 따로 싣는다
    const tag = (value: string) => [{ key: "Cache-Tag", value }, { key: "x-amz-meta-cache-tag", value }];
    /**
     * Cloudflare 만 읽는 캐시 시간 — 방문자에게 가는 Cache-Control(private, no-store)은 그대로다.
     * 목록 60초·상세 240초 뒤 60초 동안은 지난 사본을 주며 뒤에서 새로 받는다(최대 2분·5분 늦음).
     * 원 서버가 5xx 면 1시간까지 지난 사본을 준다. s-maxage 는 Cloudflare 의 SWR 을 꺼서 쓰지 않는다.
     * 관리자(쿠키)·검색(q, 응답 뒤 검색 기록을 남긴다)은 저장하지 않는다.
     */
    const edge = (seconds: number) => ({
      missing: [{ type: "cookie" as const, key: "nmv_admin" }, { type: "query" as const, key: "q" }],
      headers: [{ key: "Cloudflare-CDN-Cache-Control", value: `max-age=${seconds}, stale-while-revalidate=60, stale-if-error=3600` }],
    });
    /**
     * CloudFront(서울 거점, 2026-10-07)가 읽는 표준 Cache-Control — CloudFront 는 Cloudflare 전용 헤더를 읽지 않는다.
     * 브라우저에 갈 값은 X-NMV-Browser-Cache 로 실어 보내고 CloudFront 함수가 되돌린다(private, no-store 그대로).
     * HTML 은 rsc·_rsc 가 둘 다 없을 때, 화면 이동용(RSC)은 둘 다 있을 때만 — 어긋나면 Next 기본(private, no-store)이라
     * 저장되지 않는다. 관리자·검색도 마찬가지다. Next 는 Cache-Control 이 이미 있으면 자기 기본값을 넣지 않는다.
     */
    const personal = [{ type: "cookie" as const, key: "nmv_admin" }, { type: "query" as const, key: "q" }];
    const cdn = (source: string, seconds: number) => {
      const headers = [
        { key: "Cache-Control", value: `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=60, stale-if-error=3600` },
        { key: "X-NMV-Browser-Cache", value: "private, no-cache, no-store, max-age=0, must-revalidate" },
      ];
      return [
        { source, missing: [...personal, { type: "header" as const, key: "rsc" }, { type: "query" as const, key: "_rsc" }], headers },
        { source, has: [{ type: "header" as const, key: "rsc", value: "1" }, { type: "query" as const, key: "_rsc" }], missing: personal, headers },
      ];
    };
    return [
      { source: "/", headers: tag("html,lists") },
      { source: "/popular", headers: tag("html,lists") },
      { source: "/rankings/:key", headers: tag("html,lists") },
      { source: "/p/:slug", headers: tag("html,p-:slug") },
      { source: "/", ...edge(60) },
      { source: "/popular", ...edge(60) },
      { source: "/rankings/:key", ...edge(60) },
      { source: "/p/:slug", ...edge(240) },
      ...cdn("/", 60),
      ...cdn("/popular", 60),
      ...cdn("/rankings/:key", 60),
      ...cdn("/p/:slug", 240),
    ];
  },
};

export default nextConfig;
