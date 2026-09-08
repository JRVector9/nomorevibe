import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { MobileNav } from "@/components/home/MobileNav";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";
import { siteOrigin } from "@/lib/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "nomorevibe — AI로 만든 것들, 세상에 나오다.",
  description:
    "AI로 만들어 배포한 서비스를 /nomorevibe 한 번으로 등록하세요. 우리가 직접 확인한 것만 보여줍니다.",
  /**
   * 피드 리더가 /feed.xml을 스스로 찾게 한다 — 주소를 알려주지 않으면 있어도 없는 것이다.
   *
   * metadataBase를 두지 않았으므로 상대 경로는 빌드를 막는다. robots.ts·sitemap.ts와 같이
   * siteOrigin()으로 절대 URL을 만든다.
   */
  alternates: {
    types: { "application/rss+xml": `${siteOrigin()}/feed.xml` },
  },
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
 * topbar·seasonfooter는 병렬 라우트 슬롯이다. 헤더와 푸터가 여기 있어서 페이지가 그 안에
 * 무엇을 둘 수 없는데, 슬롯으로 받으면 메인(app/@topbar/page.tsx)에서만 채운다.
 *
 * 나머지 경로를 비우려면 슬롯마다 [...catchAll]/page.tsx와 default.tsx가 둘 다 필요하다.
 * default.tsx는 하드 내비게이션에서만 쓰이고, 소프트 내비게이션에서는 슬롯이 이전 활성
 * 상태를 유지하기 때문이다.
 */
export default function RootLayout({
  children,
  topbar,
  seasonfooter,
}: {
  children: React.ReactNode;
  topbar: React.ReactNode;
  seasonfooter: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      {/* min-h-screen flex — 짧은 페이지에서도 푸터를 하단에 고정 */}
      <body className={`${inter.variable} ${jetbrains.variable} flex min-h-screen flex-col font-sans`}>
        <a className="skip" href="#main">본문으로 건너뛰기</a>
        {topbar}
        <Suspense fallback={<header className="nmb-header" />}>
          <SiteHeader />
        </Suspense>
        <div className="flex-1" id="main" tabIndex={-1}>{children}</div>
        <SiteFooter>{seasonfooter}</SiteFooter>
        <MobileNav />
      </body>
    </html>
  );
}
