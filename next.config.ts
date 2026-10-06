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
    const tag = (value: string) => [{ key: "Cache-Tag", value }];
    return [
      { source: "/", headers: tag("html,lists") },
      { source: "/popular", headers: tag("html,lists") },
      { source: "/rankings/:key", headers: tag("html,lists") },
      { source: "/p/:slug", headers: tag("html,p-:slug") },
    ];
  },
};

export default nextConfig;
