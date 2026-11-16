import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDetailView, PublicProduct } from "@/lib/domain/products/detail-view";
import type { DetailApiResponse } from "@/lib/domain/products/detail-extras";
import type { Locale } from "@/lib/i18n/locales";

const SOURCE_LABELS = { ko: "출처", en: "Source", ja: "出典", "zh-Hans": "来源", "zh-Hant": "來源" } satisfies Record<Locale, string>;

const mocks = vi.hoisted(() => ({
  locale: "ko", data: null as DetailApiResponse | null, done: false,
  identity: vi.fn(), detail: vi.fn(),
}));
vi.unmock("@/lib/i18n/context");
vi.mock("@/lib/i18n/server", () => ({ getRequestLocale: async () => mocks.locale }));
vi.mock("@/components/product-detail/DetailExtras", async (original) => ({
  ...await original<typeof import("@/components/product-detail/DetailExtras")>(),
  useDetailExtras: (slug: string) => ({ slug, data: mocks.data, done: mocks.done }),
}));
vi.mock("@/lib/domain/products/detail-view", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/detail-view")>(),
  getProductIdentity: mocks.identity, getProductDetail: mocks.detail,
}));
vi.mock("@/lib/i18n/products", async (original) => ({
  ...await original<typeof import("@/lib/i18n/products")>(),
  localizeProductList: async (items: unknown[]) => items,
}));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: async () => ({ visible: false, preview: false }), talkPublicEnabled: () => false }));
vi.mock("@/lib/domain/github-installations/bindings", () => ({ getProductGithubBinding: async () => null }));
// 관문 자체는 기존 공개 API 시험에서 검증한다. 여기서는 실제 상세 응답·화면의 출처 계약을 본다.
vi.mock("@/lib/http/anti-scrape", () => ({ guardPublicApiRead: async () => null }));

const { default: ProductPage } = await import("@/app/(public)/[locale]/(content)/p/[slug]/page");
const { ProductHero } = await import("@/components/product-detail/ProductHero");
const { DetailIntroSlot } = await import("@/components/product-detail/DetailHeroSlots");
const { GET } = await import("@/app/api/products/[slug]/details/route");
const { I18nProvider } = await import("@/lib/i18n/context");
const { getDictionary, getTranslator } = await import("@/lib/i18n/dictionary");
const { publicTeaser } = await import("@/lib/domain/products/public-teaser");
const { reviveDetailExtras } = await import("@/lib/domain/products/detail-extras");

const product: PublicProduct = {
  id: 1, slug: "source-fixture", name: "Source Fixture", tagline: "A useful product", taglineKo: null, taglineSource: "maker",
  description: "A longer introduction", url: "https://fixture.example", repoUrl: null, accessMode: "website", category: "Dev",
  stack: [], builder: null, makerName: null, ogImage: null, status: "seeded", source: "crawler", claimedAt: null, verifiedAt: null,
  createdAt: new Date("2026-11-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"), aiEvidence: true, takedownPending: false,
};
function detail(subject: PublicProduct): ProductDetailView {
  return { product: subject, unclaimed: true, risingRank: null,
    health: { uptime30d: null, latencyMs: null, checkedAt: null, down: false },
    profile: null, repository: null, media: [], readmeExcerpt: null, freshness: [], updates: [], related: [],
    relatedBasis: "category", visits: {}, license: {},
  } as unknown as ProductDetailView;
}

// Next async 서버 부품만 펼친다. 클라이언트 경계는 실제 SSR로 그린다.
// async 서버 부품의 실환경 동작은 시험 DB의 next dev + 브라우저로도 확인한다.
async function serverTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(serverTree));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type = element.type;
  if (typeof type === "function" && !(type as { $$nmvClientBoundary?: boolean }).$$nmvClientBoundary) {
    return serverTree(await (type as (props: unknown) => ReactNode | Promise<ReactNode>)(element.props));
  }
  return cloneElement(element, {}, await serverTree(element.props.children));
}
const bodyText = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ");
const count = (text: string, source: string) => text.split(source).length - 1;

beforeEach(() => {
  mocks.data = null;
  mocks.done = false;
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
  vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "false");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "false");
});

for (const locale of Object.keys(SOURCE_LABELS) as Locale[]) describe(locale, () => {
  for (const description of ["A longer introduction", "", product.tagline]) {
    it(`소개 ${description ? description === product.tagline ? "요약과 같음" : "있음" : "없음"}: 서버 본문·화면 출처 각 1회, API 계약 유지`, async () => {
      mocks.locale = locale;
      const subject = { ...product, description };
      mocks.identity.mockResolvedValue(subject);
      mocks.detail.mockResolvedValue(detail(subject));
      const source = (await getTranslator(locale, "detail"))("intro.siteSource");
      expect(source).toBe(`${SOURCE_LABELS[locale]}: nomorevibe.com`);
      const dictionaries = { detail: await getDictionary(locale, "detail"), labels: await getDictionary(locale, "labels"), common: await getDictionary(locale, "common") };
      const wrap = (children: ReactNode) => <I18nProvider locale={locale} dictionaries={dictionaries} now="2026-11-16T00:00:00Z">{children}</I18nProvider>;

      const html = renderToStaticMarkup(wrap(await serverTree(await ProductPage({ params: Promise.resolve({ slug: subject.slug }) }))));
      expect(count(bodyText(html), source)).toBe(1);
      expect(html).toContain(`text-fg-2">${source}</p>`);
      expect(html).toMatch(new RegExp(`${subject.tagline}</p><p[^>]*>${source.replaceAll(".", "\\.")}</p>`));

      const response = await GET(new Request(`https://nomorevibe.test/api/products/${subject.slug}/details?locale=${locale}`), { params: Promise.resolve({ slug: subject.slug }) });
      expect(response.status).toBe(200);
      mocks.data = JSON.parse(await response.text(), reviveDetailExtras) as DetailApiResponse;
      mocks.done = true;
      if (description && description !== subject.tagline) {
        expect(mocks.data.intro.text).toBe(`${description}\n\n${source}`);
        expect(count(mocks.data.intro.text!, source)).toBe(1);
      } else expect(mocks.data.intro.text).toBeNull(); // 빈 소개에 출처만 새로 만들지 않는다
      expect(mocks.data.hero.tagline).toBe(subject.tagline);
      expect(subject.description).toBe(description);

      const screen = renderToStaticMarkup(wrap(<><ProductHero teaser={publicTeaser(subject, locale)} sourceLine={source} /><DetailIntroSlot slug={subject.slug} /></>));
      expect(count(bodyText(screen), source)).toBe(1);
      if (description && description !== subject.tagline) expect(bodyText(screen)).toContain(description);
    });
  }
});
