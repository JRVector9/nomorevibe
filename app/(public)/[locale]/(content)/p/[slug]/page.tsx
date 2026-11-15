import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DetailEntry } from "@/components/product-detail/DetailEntry";
import { DetailSkeleton } from "@/components/product-detail/DetailSkeleton";
import { DetailActivitySlot, DetailFactsSlot, DetailInfoSlot, DetailRelatedSlot } from "@/components/product-detail/DetailExtras";
import { DetailAsideSlot, DetailIntroSlot, DetailPreviewSlot, FeedbackSettingsSlot } from "@/components/product-detail/DetailHeroSlots";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { FeedbackForm } from "@/components/product-detail/FeedbackForm";
import { FeedbackList } from "@/components/product-detail/FeedbackList";
import { TryPanel } from "@/components/feedback/TryPanel";
import { followLabels as followLabels_ } from "@/components/me/follow-labels";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { productOgImage, shareMetadata } from "@/lib/copy/share";
import { pageTitle } from "@/lib/copy/brand";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { productIndexable } from "@/lib/domain/products/indexing";
import { publicTeaser } from "@/lib/domain/products/public-teaser";
import { I18nProvider } from "@/lib/i18n/context";
import { bundledOrDictionary, getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { createTranslator } from "@/lib/i18n/messages";
import { DetailMessages } from "@/lib/i18n/bundled/detail";
import type { Locale } from "@/lib/i18n/locales";
import { getRequestLocale } from "@/lib/i18n/server";
import { localePath } from "@/lib/i18n/routing";
import { localizeProductList, productTranslationSource, readTranslationsForProducts } from "@/lib/i18n/products";
import { productLocaleMetadata } from "@/lib/i18n/metadata";
import { readProductTranslationReadiness, selectProductTranslation } from "@/lib/domain/products/translations";
import { onReplica } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { publicRead } from "@/lib/domain/products/public-reads";
import { productJsonLd, serializeJsonLd } from "@/lib/seo/product-json-ld";
import { siteOrigin } from "@/lib/site";
import { githubFeedbackDeliveryEnabled, productFeedbackEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getProductGithubBinding } from "@/lib/domain/github-installations/bindings";
import { TalkBandSlot } from "@/components/social/TalkBandSlot";
import { talkVisibility } from "@/lib/social/flags";
import { tryPanelMessages } from "@/components/feedback/try-messages";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/** 메타데이터·본문이 같은 제품을 여러 번 읽는다 — 30초 들고 있는다(lib/domain/products/public-reads.ts) */
const identityOf = (slug: string) => publicRead("detail", ["identity", slug], () => getProductIdentity(slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getRequestLocale();
  const product = await identityOf(slug);
  // 없는 제품의 404 탭 제목이 홈 제목으로 남지 않게 — not-found.tsx 의 제목과 같은 말(UX-10·UX-39)
  if (!product) return { title: pageTitle((await getTranslator(locale, "detail"))("notFound.title")) };
  const source = productTranslationSource(product);
  const baseIndexable = productIndexable(product);
  const contentEligible = product.translationEligible !== false;
  const [translations, readiness] = await Promise.all([
    readTranslationsForProducts([product], locale).catch((error) => {
      logger.warn("i18n.product_metadata_translation_unavailable", { error }); return [];
    }),
    baseIndexable && contentEligible ? onReplica(() => readProductTranslationReadiness([source])).catch((error) => {
      logger.warn("i18n.product_metadata_readiness_unavailable", { error }); return [];
    }) : [],
  ]);
  const description = locale === "ko" ? product.taglineKo?.trim() || product.tagline
    : selectProductTranslation(source, locale, "tagline", translations.find((row) => row.field === "tagline")).text;
  const title = pageTitle(product.name);
  // 공유 그림은 이름·요약만 그린 카드(/p/<slug>/og.jpg) — 제품 표지·스타·분야는 그리지 않는다(2026-11-15 공개 HTML 이름·요약만)
  const share = shareMetadata({ title, description, image: productOgImage(slug, locale, product.name) });
  const localized = productLocaleMetadata(locale, `/p/${slug}`, source, readiness, baseIndexable, contentEligible);
  return {
    ...share, ...localized, title, description,
    openGraph: { ...share.openGraph, ...localized.openGraph, url: `${siteOrigin()}${localePath(locale, `/p/${slug}`)}` },
    // Preserve the existing Korean indexability contract; incomplete translations follow public links.
    robots: locale === "ko" && baseIndexable ? undefined : localized.robots,
  };
}

/**
 * 없는 제품은 응답을 흘려보내기 전에 404 로 끝낸다 — 기본 정보(메타데이터와 같은 요청 안에서 한 번 읽는다)만 먼저 읽고,
 * 여러 표를 모아 읽는 본문은 그다음 Suspense 안에서 머리 골격(DetailSkeleton)을 먼저 보이며 채운다(UX-38).
 * 구간 loading.tsx 를 두면 응답이 골격부터 흘러가 상태 코드를 바꿀 수 없어, 없는 제품도 200 이 된다.
 */
export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const locale = await getRequestLocale();
  const identity = await identityOf(slug);
  if (!identity) notFound();
  const dictionary = await bundledOrDictionary(locale, "detail");
  const now = new Date();
  return (
    <DetailMessages locale={locale} messages={dictionary} now={now.toISOString()}>
      <Suspense fallback={<DetailSkeleton />}>
        <ProductDetail slug={slug} locale={locale} />
      </Suspense>
    </DetailMessages>
  );
}

/**
 * 상세 본문(2026-11-15 공개 HTML 이름·요약만, 문서 4.2) — 서버 HTML·RSC 데이터에 싣는 제품 값은 slug·이름·요약뿐이다.
 * 빵부스러기는 홈 › 이름, JSON-LD 는 WebPage+CreativeWork(이름·요약)+빵부스러기. 머리의 나머지 칸·소개·README 발췌·사실 칸·정보 카드·
 * 미리보기·운영자 상자·같은 분야는 모두 같은 출처 API(/api/products/[slug]/details) 한 번으로 화면 JS 가 채운다.
 * 모든 요청(봇 포함)에 같은 HTML 을 준다.
 */
async function ProductDetail({ slug, locale }: { slug: string; locale: Locale }) {
  // 기본 정보를 읽은 뒤 그사이 내려갔으면 여기서 404 화면(응답은 이미 흘렀으므로 상태는 200, noindex 가 붙는다)
  const identity = await identityOf(slug);
  if (!identity) notFound();
  const [t, localized] = await Promise.all([getTranslator(locale, "detail"), localizeProductList([identity], locale)]);
  const teaser = publicTeaser(localized[0], locale);
  const githubDeliveryAvailable = githubFeedbackDeliveryEnabled()
    && Boolean((await getProductGithubBinding(identity.id).catch(() => null))?.enabled);
  const talkView = await talkVisibility();
  const now = new Date();
  // 써보기 판(피드백 PR3) — 내 평가·요약은 판이 브라우저에서 읽는다(이 HTML 은 엣지에 4분 남는다)
  const me = productReactionsEnabled() || publicUserAuthEnabled() ? await getDictionary(locale, "me") : null;
  const tryMessages = me && productReactionsEnabled() ? tryPanelMessages(me) : null;
  const meT = me ? createTranslator("me", me) : null;
  // 팔로 단추 글자 — 메이커 단추의 주인 이름 자리(\u0000)는 받은 뒤 채운다(주인 계정은 서버 HTML 에 싣지 않는다)
  const followLabels = meT && publicUserAuthEnabled() ? {
    product: followLabels_(meT, "product", meT("follow.product", { name: teaser.name })),
    maker: followLabels_(meT, "maker", meT("follow.maker", { login: "\u0000" })),
  } : null;
  const jsonLd = productJsonLd({
    origin: siteOrigin(), slug, name: teaser.name, description: teaser.summary, inLanguage: locale,
    pagePath: localePath(locale, `/p/${slug}`), homePath: localePath(locale, "/"), homeName: t("page.discover"),
  });

  return (
    <I18nProvider locale={locale} dictionaries={{}} now={now.toISOString()}><main className="wrap pb-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <DetailEntry slug={slug} />
      <nav aria-label={t("page.breadcrumb")} className="flex items-center gap-2 pt-4 text-[13px] text-fg-2">
        <Link prefetch={false} href={localePath(locale, "/")} className="shrink-0 hover:text-fg">{t("page.discover")}</Link>
        <span aria-hidden>›</span>
        <span className="min-w-0 truncate text-fg">{teaser.name}</span>
      </nav>

      <ProductHero teaser={teaser} followLabels={followLabels}
        tryPanel={tryMessages ? <I18nProvider locale={locale} dictionaries={{ me: tryMessages }}><TryPanel key={slug} slug={slug} name={teaser.name} /></I18nProvider> : undefined} />

      {talkView.visible && <TalkBandSlot slug={slug} />}

      {/* 넓으면 2:1 두 열, 좁으면 오른쪽 열이 본문 아래로 */}
      <div className="flex flex-wrap items-start gap-x-12 gap-y-9 pt-7">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-9">
          <DetailFactsSlot slug={slug} />
          <DetailIntroSlot slug={slug} />
          <DetailActivitySlot slug={slug} />
          {productFeedbackEnabled() && (
            <section id="feedback" className="scroll-mt-24 space-y-4 border-t border-line pt-5" aria-label={t("page.feedback")}>
              <FeedbackList key={slug} slug={slug} settings={<FeedbackSettingsSlot slug={slug} />}>
                <FeedbackForm slug={slug} githubDeliveryAvailable={githubDeliveryAvailable} />
              </FeedbackList>
            </section>
          )}
        </div>

        <aside id="evidence" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <DetailInfoSlot slug={slug} />
          <DetailPreviewSlot slug={slug} name={teaser.name} />
          <DetailAsideSlot slug={slug} />
        </aside>
      </div>

      <DetailRelatedSlot slug={slug} />
    </main></I18nProvider>
  );
}
