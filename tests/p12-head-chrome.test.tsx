import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { common } from "@/messages/ko/common";

vi.mock("server-only", () => ({}));

/**
 * 사이트 머리(2026-10-08 점검 PERF-01·ROB-02·ROB-03·A11Y-07·SEO-08) — 서버 HTML 에 헤더·검색어가 바로 있고,
 * 단축키 표시는 기기에 맞추며, 홈 화면 아이콘·매니페스트·theme-color 가 있다.
 */
const mocks = vi.hoisted(() => ({ pathname: "/", search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
  useRouter: () => ({ push: vi.fn() }),
}));

const { SiteHeader, shortcutLabel } = await import("@/components/home/SiteHeader");
const { default: RootLayout } = await import("@/app/(public)/[locale]/layout");
const { viewport } = await import("@/app/layout");
const { PublicShell } = await import("@/components/home/PublicShell");
const { default: manifest } = await import("@/app/manifest");

const header = (pathname: string, search = "") => {
  mocks.pathname = pathname;
  mocks.search = search;
  return renderToStaticMarkup(<I18nProvider locale="ko" dictionaries={{ common }}><SiteHeader /></I18nProvider>);
};
const searchInput = (html: string) => html.match(/<input id="search"[^>]*>/)?.[0] ?? "";

beforeEach(() => {
  mocks.pathname = "/";
  mocks.search = "";
});

describe("헤더는 첫 HTML 에 바로 있다(PERF-01·ROB-02)", () => {
  it("공개 인증을 켜면 로그인 진입점을 제공하고 기본 비활성에서는 숨긴다", () => {
    expect(renderToStaticMarkup(<I18nProvider locale="ko" dictionaries={{ common }}><SiteHeader authEnabled /></I18nProvider>)).toContain('href="/login"');
    expect(header("/")).not.toContain('href="/login"');
  });
  it("루트 레이아웃이 빈 헤더 폴백 없이 로고·메뉴·검색창을 그린다", async () => {
    mocks.pathname = "/launch";
    // renderToString 은 Suspense 경계를 <!--$--> 로 남긴다 — 헤더가 경계 밖(첫 HTML 의 뼈대)에 있는지 본다
    const shell = await PublicShell({ locale: "ko", seasonfooter: null, children: <main>본문</main> });
    const html = renderToString(await RootLayout({ params: Promise.resolve({ locale: "ko" }), children: shell }));

    expect(html).not.toContain('<header class="nmb-header"></header>');
    expect(html).toContain('본문으로 건너뛰기</a><header class="nmb-header">');
    expect(html).toMatch(/<header class="nmb-header"><div class="wrap header-row"><a [^>]*href="\/"/);
    expect(html).toContain('aria-label="주 메뉴"');
    expect(html).toContain('id="search"');
    expect(html).toContain('href="/launch"');
    // 헤더가 본문보다 앞에 온다
    expect(html.indexOf("nmb-header")).toBeLessThan(html.indexOf('id="main"'));
  });

  it("급상승 화면과 거르기 없는 홈에서 '스타 급상승'을 켠다", () => {
    expect(header("/")).toContain('class="active" href="/rising"');
    expect(header("/rising")).toContain('class="active" href="/rising"');
    expect(header("/", "new=1")).not.toContain('class="active"');
    expect(header("/", "q=pdf")).not.toContain('class="active"');
    expect(header("/", "category=Dev")).not.toContain('class="active"');
    expect(header("/launch")).not.toContain('class="active"');
  });
});

describe("검색창은 서버 HTML 부터 검색어를 담는다(ROB-03)", () => {
  it("홈 검색 결과 — 검색어와 도구 거르기가 그대로 들어 있다", () => {
    const html = header("/", "q=pdf&observedTool=claude-code");

    expect(searchInput(html)).toContain('value="pdf"');
    expect(html).toContain('<input type="hidden" name="observedTool" value="claude-code"/>');
    // 도구 거르기가 검색어보다 먼저 — 폼 제출 주소의 순서를 바꾸지 않는다
    expect(html.indexOf('name="observedTool"')).toBeLessThan(html.indexOf('id="search"'));
  });

  it("분야 화면도 검색어를 잇는다", () => {
    expect(searchInput(header("/c/finance", "q=%EA%B0%80%EA%B3%84%EB%B6%80"))).toContain('value="가계부"');
  });

  it("목록 화면이 아니면 빈 칸이고 도구 거르기도 싣지 않는다", () => {
    const html = header("/p/infisical", "q=pdf&observedTool=claude-code");

    expect(searchInput(html)).toContain('value=""');
    expect(html).not.toContain('name="observedTool"');
  });
});

describe("단축키 표시(A11Y-07)", () => {
  it("Apple 기기는 ⌘K, 그 밖은 Ctrl K", () => {
    expect(shortcutLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("⌘K");
    expect(shortcutLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("⌘K");
    expect(shortcutLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("Ctrl K");
    expect(shortcutLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl K");
  });

  it("서버 HTML 에는 기기를 모르니 표시를 두지 않는다 — 붙은 뒤 그려 hydration 이 어긋나지 않는다", () => {
    const html = header("/");
    expect(html).not.toContain("<kbd");
    expect(html).not.toContain("⌘K");
  });
});

describe("홈 화면 아이콘·매니페스트·theme-color(SEO-08)", () => {
  const pngSize = (file: string) => {
    const png = readFileSync(path.resolve(__dirname, "..", file));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it("apple-touch-icon 은 180×180 PNG, 매니페스트 아이콘은 192·512", () => {
    expect(pngSize("app/apple-icon.png")).toEqual([180, 180]);
    expect(pngSize("public/icon-192.png")).toEqual([192, 192]);
    expect(pngSize("public/icon-512.png")).toEqual([512, 512]);
  });

  it("매니페스트는 브랜드 이름·한국어·public 아이콘을 가리킨다", () => {
    const value = manifest();

    expect(value.name).toBe("nomorevibe");
    expect(value.lang).toBe("ko");
    expect(value.start_url).toBe("/");
    expect(value.icons?.map((icon) => icon.src)).toEqual(["/icon-192.png", "/icon-512.png"]);
    for (const icon of value.icons ?? []) {
      const size = pngSize(path.join("public", icon.src)).join("x");
      expect(icon.sizes).toBe(size);
    }
  });

  it("theme-color 는 라이트·다크 바탕색과 같다", () => {
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
      { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    ]);
    const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/--bg: #ffffff;/);
    expect(css).toMatch(/--bg: #0d1117;/);
  });
});
