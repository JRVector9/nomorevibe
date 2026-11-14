import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n/locales";
import { getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { HomeScreen } from "@/app/(public)/[locale]/(content)/page";
import GithubSettingsPage from "@/app/(public)/[locale]/(content)/p/[slug]/github/page";
import { DetailSkeleton } from "@/components/product-detail/DetailSkeleton";
import { ReadmeFallback } from "@/components/product-detail/ReadmeSection";
import { FeedbackList } from "@/components/product-detail/FeedbackList";
import { FeedbackForm } from "@/components/product-detail/FeedbackForm";
import { TriedList } from "@/components/me/TriedList";
import { GithubConnection } from "@/components/auth/GithubConnection";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const request = vi.hoisted(() => ({ locale: "ko" }));
vi.mock("@/lib/i18n/server", () => ({ getRequestLocale: async () => request.locale }));
vi.mock("@/lib/i18n/context", async (original) => original());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => "/", redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/domain/github-integration/flags", () => ({ publicUserAuthEnabled: () => true, productFeedbackEnabled: () => true }));
vi.mock("@/lib/domain/products/repository", () => ({ findBySlug: async () => ({ status: "seeded", name: "Fixture", repoUrl: "https://github.com/example/fixture" }) }));

const product = { repoUrl: "https://github.com/example/fixture", repoGone: false } as ProductDetailView["product"];
const loadingCopy = /불러오는 중|찾는 중|확인(?:하는|하고)?\s?중|확인하고 있습니다|loading|searching|checking (?:connection|sign-in)|読み込み中|検索中|確認中|正在(?:加载|載入|搜索|搜尋|检查|檢查|确认|確認)/i;

function fallback(node: ReactNode): ReactNode {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; fallback?: ReactNode }>;
  if (element.type === Suspense) return element.props.fallback;
  for (const child of [element.props.children].flat()) {
    const found = fallback(child);
    if (found) return found;
  }
  return null;
}

for (const locale of [...LOCALES, "zh-Hant"] as const) describe(`공개 대기 HTML (${locale})`, () => {
  async function html(node: ReactNode) {
    const [detail, auth, me] = await Promise.all([getDictionary(locale, "detail"), getDictionary(locale, "auth"), getDictionary(locale, "me")]);
    return renderToStaticMarkup(<I18nProvider locale={locale} dictionaries={{ detail, auth, me }} now="2026-11-14T14:35:00Z">{node}</I18nProvider>);
  }
  function skeleton(markup: string) {
    expect(markup).not.toMatch(loadingCopy);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/aria-hidden="true"/);
  }
  it.each([{}, { q: "fixture" }, { category: "Dev" }, { sort: "recent" }, { new: "1" }])("홈·검색·분야·목록 대기 %j", async (params) => {
    request.locale = locale;
    const node = fallback(await HomeScreen({ params }));
    expect(node).toBeTruthy();
    skeleton(await html(node));
  });
  it("로그아웃해도 열리는 써봤어요 초기 SSR", async () => { skeleton(await html(<TriedList account={null} initial={null} authEnabled={true} />)); });
  it("상세 본문 골격", async () => { skeleton(await html(<DetailSkeleton />)); });
  it.each([null, "Existing README excerpt"])("README 대기 (발췌 %s)", async (readmeExcerpt) => {
    request.locale = locale;
    const markup = await html(await ReadmeFallback({ product, readmeExcerpt, pending: true }));
    skeleton(markup);
    expect(markup).toContain("README");
    if (readmeExcerpt) expect(markup).toContain(readmeExcerpt);
  });
  it("댓글 목록 초기 SSR", async () => { skeleton(await html(<FeedbackList slug="fixture" />)); });
  it("댓글 작성자의 로그인 확인 초기 SSR", async () => { skeleton(await html(<FeedbackForm slug="fixture" />)); });
  it("공개 로그인 페이지의 GitHub 연결 확인", async () => { skeleton(await html(<GithubConnection signedIn={false} returnTo="/" />)); });
  it("제작자 GitHub 설정의 로그인 확인 fallback", async () => {
    request.locale = locale;
    const page = await GithubSettingsPage({ params: Promise.resolve({ slug: "fixture" }), searchParams: Promise.resolve({}) });
    const node = fallback(page);
    expect(node).toBeTruthy();
    skeleton(await html(node));
  });
});
