import type { NextConfig } from "next";
import { LOCALES } from "./lib/i18n/locales";
import { localePath } from "./lib/i18n/routing";
import { RENDER_RECOVERY_COOKIE, RENDER_RECOVERY_COOKIE_VALUE } from "./lib/web/recovery-cache";
import { takeReleaseBuildId } from "./lib/web/release-build-id";

/** 릴리스 값(NEXT_DEPLOYMENT_ID)을 읽고 그 환경변수를 지운다 — Next 가 deploymentId 로 쓰지 않게(lib/web/release-build-id.ts) */
const releaseBuildId = takeReleaseBuildId();

/** 상세의 지난 사본을 엣지가 먼저 줄 수 있는 시간 — 아래 headers() 의 edge 설명 */
const DETAIL_STALE_SECONDS = 86_400;

const nextConfig: NextConfig = {
  // Docker/Dokploy 배포용 — .next/standalone만 복사해도 동작하게
  output: "standalone",

  /**
   * 두 웹 인스턴스와 롤링 배포 사이의 버전 불일치는 빌드 ID 로 감지한다 — RSC 응답의 `b` 가 첫 화면과 다르면 전체 새로고침.
   * deploymentId 는 쓰지 않는다: 정적 파일마다 `?dpl=` 이 붙어 배포마다 엣지·브라우저 캐시가 비었다(lib/web/release-build-id.ts).
   * 릴리스 값이 없으면(로컬 빌드) Next 가 빌드마다 임의 ID 를 짓는다.
   */
  generateBuildId: async () => releaseBuildId ?? null,

  /**
   * next build 안의 타입 검사는 프로젝트 전체 `tsc` 를 한 번 더 돈다(CI 약 1분, arm 이미지 약 34초).
   * CI 는 같은 트리를 typecheck 잡(`tsc --noEmit`)에서 따로 검사하고, 이미지는 그 검사가 통과한 `check` 뒤에만 배포한다.
   * 그 두 곳(CI build 잡·CI 이미지 빌드)만 SKIP_NEXT_TYPECHECK=1 로 중복 검사를 건너뛴다. 기본(로컬·수동 빌드)은 그대로 검사한다.
   */
  typescript: { ignoreBuildErrors: process.env.SKIP_NEXT_TYPECHECK === "1" },

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
     * max-age 동안은 그 사본(HIT), 그 뒤 stale-while-revalidate 동안은 지난 사본을 곧바로 주며 뒤에서 새로 받는다(UPDATING —
     * Free 도 2026-02 부터 비동기). 목록은 60초+60초(최대 2분 늦음).
     * 상세는 240초+하루(2026-11-11): 사본은 4분 동안 그대로 쓰고, 그 뒤 첫 요청 하나가 지난 사본을 받으며 새로 받게 한다. 상세 제품이
     * 8만 개 남짓이고 같은 제품을 5분 안에 다시 보는 일이 드물어 60초 창으로는 거의 모두 원 서버를 기다렸다. 내린 제품(트리거 0057)·사람이
     * 고친 제품(lib/cdn/detail-purge.ts)·웹 릴리스가 바뀐 뒤의 옛 HTML(lib/jobs/products/cdn-purge.ts)은 지우기로 없앤다 — 지운 사본은
     * 지난 사본으로도 주지 않는다. 스타·가동·방문 수·급상승·관련 목록처럼 저절로 바뀌는 값은 그 첫 요청에만 지난 렌더 값이 보인다.
     * 원 서버가 5xx 면 1시간까지 지난 사본을 준다. s-maxage 는 Cloudflare 의 SWR 을 꺼서 쓰지 않는다.
     * 관리자(쿠키)·검색(q, 응답 뒤 검색 기록을 남긴다)은 저장하지 않는다.
     */
    const edge = (seconds: number, staleSeconds = 60) => ({
      missing: [{ type: "cookie" as const, key: "nmv_admin" }, { type: "cookie" as const, key: "nmv_user" },
        { type: "cookie" as const, key: "nmv_login_nonce" }, { type: "query" as const, key: "q" },
        { type: "cookie" as const, key: RENDER_RECOVERY_COOKIE, value: RENDER_RECOVERY_COOKIE_VALUE }],
      headers: [{ key: "Cloudflare-CDN-Cache-Control",
        value: `max-age=${seconds}, stale-while-revalidate=${staleSeconds}, stale-if-error=3600` }],
    });
    const pages: { path: string; tags: string; seconds: number; staleSeconds?: number }[] = [
      { path: "/", tags: "html,lists", seconds: 60 },
      { path: "/c/:category", tags: "html,lists", seconds: 60 },
      { path: "/popular", tags: "html,lists", seconds: 60 },
      { path: "/rising", tags: "html,lists", seconds: 60 },
      { path: "/talk", tags: "html,lists", seconds: 60 },
      { path: "/policy", tags: "html", seconds: 600 },
      { path: "/launch", tags: "html", seconds: 600 },
      { path: "/rankings/:key", tags: "html,lists", seconds: 60 },
      { path: "/p/:slug", tags: "html,p-:slug", seconds: 240, staleSeconds: DETAIL_STALE_SECONDS },
    ];
    const localized = LOCALES.flatMap((locale) => pages.flatMap((page) => [
      { source: localePath(locale, page.path), headers: tag(page.tags) },
      { source: localePath(locale, page.path), ...edge(page.seconds, page.staleSeconds) },
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
      // A bounded recovery GET must not store another caught-error 200 response.
      { source: "/:path*", has: [{ type: "cookie" as const, key: RENDER_RECOVERY_COOKIE, value: RENDER_RECOVERY_COOKIE_VALUE }], headers: noStore },
    ];
  },
};

export default nextConfig;
