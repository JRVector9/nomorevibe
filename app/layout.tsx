import type { Metadata, Viewport } from "next";
import { MobileNav } from "@/components/home/MobileNav";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";
import { HOME_TITLE } from "@/lib/copy/brand";
import { SITE_DESCRIPTION, SITE_SHARE } from "@/lib/copy/share";
import { siteOrigin, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  /**
   * 제목 틀(title.template)은 두지 않는다 — 화면마다 pageTitle(lib/copy/brand.ts)로 완성된 제목을 넘긴다.
   * 틀을 두면 이미 브랜드를 붙여 쓰는 관리자 화면 제목에 브랜드가 두 번 붙는다.
   */
  title: HOME_TITLE,
  // 약속은 실제와 맞춘다(UX-05) — 예전 "우리가 직접 확인한 것만 보여줍니다"는 찾아 올린 목록과 어긋났다(lib/copy/share.ts)
  description: SITE_DESCRIPTION,
  /** 공유 미리보기의 상대 주소(그림 등)를 절대 주소로 — robots.ts·sitemap.ts 와 같은 siteOrigin() */
  metadataBase: new URL(siteOrigin()),
  /** 공유 미리보기 기본값 — 사이트 이름·한국어·기본 그림(SEO-01·UX-07). 제품 상세는 제 그림과 소개로 바꾼다 */
  ...SITE_SHARE,
  /** 피드 리더가 /feed.xml을 스스로 찾게 한다 — 주소를 알려주지 않으면 있어도 없는 것이다 */
  alternates: {
    types: { "application/rss+xml": `${siteOrigin()}/feed.xml` },
  },
};

/**
 * 라이트·다크 둘 다 그린다(globals.css 가 기기 설정을 따른다) — 브라우저가 첫 바탕과 스크롤바·입력칸을 그에 맞춘다.
 * 테마를 고르는 스크립트는 두지 않는다. 미디어 쿼리만으로 정해져 첫 그리기에 깜빡임이 없다.
 */
export const viewport: Viewport = {
  colorScheme: "light dark",
  /** 주소창·탭 막대 색 — 기기 테마마다 바탕(--bg)과 맞춘다(SEO-08) */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
  ],
};

/**
 * html에 suppressHydrationWarning을 두는 이유:
 * 브라우저 확장이 속성을 주입해(예: HWP 뷰어의 data-hwp-extension) 서버 HTML과
 * 어긋나면 hydration 경고가 뜬다. 우리가 통제할 수 없는 값이다.
 *
 * 이 속성은 해당 요소에만, 한 단계 깊이로만 적용된다. 자식 트리의 실제 불일치는
 * 계속 잡히므로 진짜 버그를 가리지 않는다.
 */
/**
 * seasonfooter는 병렬 라우트 슬롯이다. 헤더와 푸터가 여기 있어서 페이지가 그 안에
 * 무엇을 둘 수 없는데, 슬롯으로 받으면 메인(app/@seasonfooter/page.tsx)에서만 채운다.
 *
 * 나머지 경로를 비우려면 슬롯마다 [...catchAll]/page.tsx와 default.tsx가 둘 다 필요하다.
 * default.tsx는 하드 내비게이션에서만 쓰이고, 소프트 내비게이션에서는 슬롯이 이전 활성
 * 상태를 유지하기 때문이다.
 */
export default function RootLayout({
  children,
  seasonfooter,
}: {
  children: React.ReactNode;
  seasonfooter: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      {/* min-h-screen flex — 짧은 페이지에서도 푸터를 하단에 고정 */}
      <body className="flex min-h-screen flex-col font-sans">
        <a className="skip" href="#main">본문으로 건너뛰기</a>
        {/*
          헤더는 Suspense 로 감싸지 않는다(PERF-01·ROB-02) — 감싸면 빈 헤더가 먼저 나가고 진짜 헤더가 뒤에 스트리밍돼
          본문이 밀리고, 스크립트가 없으면 헤더가 끝까지 빈다. 주소의 쿼리를 읽는 조각만 SiteHeader 안에서 따로 감싼다.
        */}
        <SiteHeader />
        <div className="flex-1" id="main" tabIndex={-1}>{children}</div>
        <SiteFooter>{seasonfooter}</SiteFooter>
        <MobileNav />
      </body>
    </html>
  );
}
