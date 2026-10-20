import type { NextConfig } from "next";
import { LOCALES } from "./lib/i18n/locales";
import { localePath } from "./lib/i18n/routing";

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
    // 공유 카드 글꼴(lib/me/share-card.tsx 가 실행 중에 읽는다)
    "/\\[locale\\]/p/\\[slug\\]/share-card.png": ["./assets/fonts/*.woff"],
  },

  /** 로그인 설계 M4 의 /account 는 마이페이지 계정 탭으로 영구 이동한다(마이페이지 시안 Q1). /ko/… 도 받는다 */
  async redirects() {
    return [
      ...LOCALES.map((locale) => ({ source: localePath(locale, "/account"), destination: localePath(locale, "/me/account"), permanent: true })),
      { source: "/ko/account", destination: "/me/account", permanent: true },
    ];
  },

  /**
   * Cloudflare 캐시 태그 — 저장한 사본을 골라 지울 이름표다(Cloudflare 가 방문자에게 보내기 전에 뗀다).
   * 화면 이동용(RSC) 사본은 `?_rsc=` 주소가 제각각이라 주소로는 다 못 지운다. 태그는 갈래를 함께 지운다.
   * html: 배포 뒤 옛 화면 · lists: 제품이 내려가면 목록 화면 전체 · p-<slug>: 그 상세 화면(2026-10-06).
   */
  async headers() {
    const tag = (value: string) => [{ key: "Cache-Tag", value }];
    /**
     * Cloudflare 만 읽는 캐시 시간 — 방문자에게 가는 Cache-Control(private, no-store)은 그대로다.
     * 목록 60초·상세 240초 뒤 60초 동안은 지난 사본을 주며 뒤에서 새로 받는다(최대 2분·5분 늦음).
     * 원 서버가 5xx 면 1시간까지 지난 사본을 준다. s-maxage 는 Cloudflare 의 SWR 을 꺼서 쓰지 않는다.
     * 관리자(쿠키)·검색(q, 응답 뒤 검색 기록을 남긴다)은 저장하지 않는다.
     */
    const edge = (seconds: number) => ({
      missing: [{ type: "cookie" as const, key: "nmv_admin" }, { type: "cookie" as const, key: "nmv_user" },
        { type: "cookie" as const, key: "nmv_login_nonce" }, { type: "query" as const, key: "q" }],
      headers: [{ key: "Cloudflare-CDN-Cache-Control", value: `max-age=${seconds}, stale-while-revalidate=60, stale-if-error=3600` }],
    });
    const pages = [
      { path: "/", tags: "html,lists", seconds: 60 },
      { path: "/c/:category", tags: "html,lists", seconds: 60 },
      { path: "/popular", tags: "html,lists", seconds: 60 },
      { path: "/rising", tags: "html,lists", seconds: 60 },
      { path: "/talk", tags: "html,lists", seconds: 60 },
      { path: "/policy", tags: "html", seconds: 600 },
      { path: "/launch", tags: "html", seconds: 600 },
      { path: "/rankings/:key", tags: "html,lists", seconds: 60 },
      { path: "/p/:slug", tags: "html,p-:slug", seconds: 240 },
    ];
    const localized = LOCALES.flatMap((locale) => pages.flatMap((page) => [
      { source: localePath(locale, page.path), headers: tag(page.tags) },
      { source: localePath(locale, page.path), ...edge(page.seconds) },
    ]));
    const noStore = [{ key: "Cloudflare-CDN-Cache-Control", value: "no-store" }];
    return [
      ...localized,
      // Every language shares p-<slug>/lists; one purge removes all localized HTML/RSC copies.
      { source: "/sitemap.xml", headers: tag("html,lists") },
      { source: "/sitemaps/:locale/:file", headers: tag("html,lists") },
      { source: "/sitemap.xml", ...edge(3600) },
      { source: "/sitemaps/:locale/:file", ...edge(600) },
      ...LOCALES.flatMap((locale) => [
        { source: localePath(locale, "/login"), headers: noStore },
        { source: localePath(locale, "/feedback/:id"), headers: noStore },
        { source: localePath(locale, "/p/:slug/github"), headers: [...tag("html,p-:slug"), ...noStore] },
        // 마이페이지는 사람마다 다르다 — 로그인 전 화면(이 브라우저 목록)도 저장하지 않는다
        { source: localePath(locale, "/me"), headers: noStore },
        { source: localePath(locale, "/me/:tab*"), headers: noStore },
      ]),
      ...["nmv_admin", "nmv_user", "nmv_login_nonce"].map((key) => ({
        source: "/:path*", has: [{ type: "cookie" as const, key }], headers: noStore,
      })),
      { source: "/:path*", has: [{ type: "query" as const, key: "q" }], headers: noStore },
    ];
  },
};

export default nextConfig;
