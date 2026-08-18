import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "NoMoreVibe — AI로 만든 제품의 마켓 데이터베이스",
  description:
    "AI로 만들어 배포한 서비스를 /nomorevibe 한 번으로 등록하세요. 우리가 직접 확인한 것만 보여줍니다.",
};

/**
 * html에 suppressHydrationWarning을 두는 이유:
 * 브라우저 확장이 속성을 주입해(예: HWP 뷰어의 data-hwp-extension) 서버 HTML과
 * 어긋나면 hydration 경고가 뜬다. 우리가 통제할 수 없는 값이다.
 *
 * 이 속성은 해당 요소에만, 한 단계 깊이로만 적용된다. 자식 트리의 실제 불일치는
 * 계속 잡히므로 진짜 버그를 가리지 않는다.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      {/* min-h-screen flex — 짧은 페이지에서도 푸터를 하단에 고정 */}
      <body className={`${inter.variable} ${jetbrains.variable} flex min-h-screen flex-col font-sans`}>
        <header className="sticky top-0 z-50 border-b border-line bg-bg">
          <div className="mx-auto flex h-[60px] max-w-[1280px] items-center gap-4 px-4 sm:gap-8 sm:px-6">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2 text-[17px] font-extrabold tracking-tight sm:text-[19px]"
            >
              <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-gradient-to-br from-accent to-[#4f9dff] text-xs">
                ◉
              </span>
              NoMoreVibe
            </Link>
            <nav className="hidden gap-1 sm:flex">
              <Link
                href="/"
                className="rounded-lg px-3 py-2 text-[13.5px] font-semibold text-fg hover:bg-bg-hover"
              >
                Discover
              </Link>
            </nav>
            {/* 좁은 화면에서는 줄바꿈되며 로고를 덮었다 — 줄이지 않고 문구를 줄인다 */}
            <div className="ml-auto shrink-0">
              <Link
                href="/launch"
                className="whitespace-nowrap rounded-[9px] bg-accent px-3 py-[9px] text-[13px] font-semibold text-white hover:brightness-110 sm:px-[18px]"
              >
                + Launch<span className="hidden sm:inline"> /nomorevibe</span>
              </Link>
            </div>
          </div>
        </header>
        <div className="flex-1">{children}</div>
        <footer className="border-t border-line py-9 text-[12.5px] text-fg-3">
          <div className="mx-auto max-w-[1280px] px-6">
            NoMoreVibe — AI로 만든 제품의 마켓 데이터베이스. 우리가 직접 확인한 것만 보여줍니다.
          </div>
        </footer>
      </body>
    </html>
  );
}
