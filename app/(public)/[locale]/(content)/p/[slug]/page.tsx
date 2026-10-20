import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DetailEntry } from "@/components/product-detail/DetailEntry";
import { DetailSkeleton } from "@/components/product-detail/DetailSkeleton";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { InfoCard } from "@/components/product-detail/InfoCard";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { LanguageBar } from "@/components/product-detail/LanguageBar";
import { PreviewFigure } from "@/components/product-detail/PreviewFigure";
import { ReadmeFallback, ReadmeSection } from "@/components/product-detail/ReadmeSection";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { GithubStarButton } from "@/components/product-detail/GithubStarButton";
import { RelatedRow } from "@/components/product-detail/RelatedRow";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { FeedbackForm } from "@/components/product-detail/FeedbackForm";
import { FeedbackList } from "@/components/product-detail/FeedbackList";
import { FeedbackSettingsMenu } from "@/components/product-detail/FeedbackSettingsMenu";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { categoryHref } from "@/components/home/browse-state";
import { DEFAULT_SHARE_IMAGE, productShareImage, shareMetadata } from "@/lib/copy/share";
import { pageTitle } from "@/lib/copy/brand";
import { getProductDetail, getProductIdentity } from "@/lib/domain/products/detail-view";
import { productIndexable } from "@/lib/domain/products/indexing";
import { translatedCategory } from "@/components/home/i18n";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
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
import { githubFeedbackDeliveryEnabled, githubStarEnabled, productFeedbackEnabled } from "@/lib/domain/github-integration/flags";
import { parseGithubRepository } from "@/lib/github/repositories";
import { getProductGithubBinding } from "@/lib/domain/github-installations/bindings";
import { TalkBand } from "@/components/social/TalkBand";
import { talkVisibility } from "@/lib/social/flags";
import { productTalk, type ProductTalk } from "@/lib/social/talk";

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
  const [translations, readiness, common] = await Promise.all([
    readTranslationsForProducts([product], locale).catch((error) => {
      logger.warn("i18n.product_metadata_translation_unavailable", { error }); return [];
    }),
    baseIndexable && contentEligible ? onReplica(() => readProductTranslationReadiness([source])).catch((error) => {
      logger.warn("i18n.product_metadata_readiness_unavailable", { error }); return [];
    }) : [],
    getTranslator(locale, "common"),
  ]);
  const description = locale === "ko" ? product.taglineKo?.trim() || product.tagline
    : selectProductTranslation(source, locale, "tagline", translations.find((row) => row.field === "tagline")).text;
  const title = pageTitle(product.name);
  const image = productShareImage(product.ogImage);
  const share = shareMetadata({ title, description, image: { ...image,
    alt: image.url === DEFAULT_SHARE_IMAGE.url ? `nomorevibe — ${common("site.tagline")}` : product.name } });
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
  const dictionary = await getDictionary(locale, "detail");
  const now = new Date();
  return (
    <I18nProvider locale={locale} dictionaries={{ detail: dictionary }} now={now.toISOString()}>
      <Suspense fallback={<DetailSkeleton />}>
        <ProductDetail slug={slug} locale={locale} />
      </Suspense>
    </I18nProvider>
  );
}

async function ProductDetail({ slug, locale }: { slug: string; locale: Locale }) {
  // 기본 정보를 읽은 뒤 그사이 내려갔으면 여기서 404 화면(응답은 이미 흘렀으므로 상태는 200, noindex 가 붙는다)
  const detail = await publicRead("detail", ["detail", slug], () => getProductDetail(slug));
  if (!detail) notFound();

  const [t, labels, localized, related] = await Promise.all([
    getTranslator(locale, "detail"), getTranslator(locale, "labels"),
    localizeProductList([detail.product], locale, ["tagline", "description"]),
    localizeProductList(detail.related, locale),
  ]);
  const product = localized[0];
  const categoryName = translatedCategory(product.category, labels);
  const languages = (detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name);
  const risingTotal = detail.relatedTotal ?? null;
  const githubDeliveryAvailable = githubFeedbackDeliveryEnabled()
    && Boolean((await getProductGithubBinding(product.id).catch(() => null))?.enabled);
  // SNS 화제 띠(C안) — 화면을 켰거나 관리자 미리보기일 때만 읽는다. 실패해도 상세는 그대로 연다
  const talkView = await talkVisibility();
  const talk: ProductTalk | null = talkView.visible
    ? await productTalk(product.id, product.repoUrl).catch((error: unknown) => { logger.warn("detail.talk_unavailable", { slug, error }); return null; })
    : null;
  // 날짜의 '올해'를 정하는 시각 — 업데이트 목록(클라이언트)도 서버가 읽은 이 값으로 그린다
  const now = new Date();
  // 구조화 데이터(SEO-06) — 우리가 가진 사실만, 화면의 경로 nav 와 같은 빵부스러기. 소개는 메타 description 과 같은 값
  const jsonLd = productJsonLd({
    origin: siteOrigin(), slug, name: product.name, description: product.translation?.ready ? product.translation.text : locale === "ko" ? product.taglineKo?.trim() || product.tagline : product.tagline,
    url: product.url, category: product.category, categoryName,
    categoryPath: localePath(locale, categoryHref(product.category)), accessMode: product.accessMode,
    pagePath: localePath(locale, `/p/${slug}`), homePath: localePath(locale, "/"), homeName: t("page.discover"),
    repoUrl: product.repoUrl, repoGone: product.repoGone, image: product.ogImage, languages,
  });

  return (
    <I18nProvider locale={locale} dictionaries={{}} now={now.toISOString()}><main className="wrap pb-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <DetailEntry slug={slug} />
      <nav aria-label={t("page.breadcrumb")} className="flex items-center gap-2 pt-4 text-[13px] text-fg-2">
        <Link prefetch={false} href={localePath(locale, "/")} className="shrink-0 hover:text-fg">{t("page.discover")}</Link>
        <span aria-hidden>›</span>
        <Link prefetch={false} href={localePath(locale, categoryHref(product.category, { sort: "recent" }))} className="shrink-0 hover:text-fg">{categoryName}</Link>
        <span aria-hidden>›</span>
        <span className="min-w-0 truncate text-fg">{product.name}</span>
      </nav>

      <ProductHero product={product} unclaimed={detail.unclaimed} risingRank={detail.risingRank} talkRank={talk?.qualifies ? talk.rank : null} health={detail.health} languages={languages}
        repositoryUrl={detail.repository?.facts?.repositoryUrl ?? null}
        personalGithubStar={githubStarEnabled() && !product.repoGone && product.repoUrl && parseGithubRepository(product.repoUrl)
          ? <GithubStarButton key={product.slug} slug={product.slug} stars={product.stars} /> : undefined} />

      {talk && <TalkBand talk={talk} t={t} locale={locale} now={now} preview={talkView.preview} />}

      {/* 넓으면 2:1 두 열, 좁으면 오른쪽 열이 본문 아래로 */}
      <div className="flex flex-wrap items-start gap-x-12 gap-y-9 pt-7">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-9">
          <FactsStrip product={product} repository={detail.repository} license={detail.license} health={detail.health} visits={detail.visits} />
          <IntroSection product={product} profile={detail.profile} readmeExcerpt={detail.readmeExcerpt} unclaimed={detail.unclaimed}>
            <Suspense fallback={<ReadmeFallback product={product} readmeExcerpt={detail.readmeExcerpt} pending />}>
              <ReadmeSection product={product} readmeExcerpt={detail.readmeExcerpt} />
            </Suspense>
          </IntroSection>
          <LanguageBar repository={detail.repository} />
          <UpdateTimeline updates={detail.updates} now={now} />
          {productFeedbackEnabled() && (
            <section id="feedback" className="scroll-mt-24 space-y-4 border-t border-line pt-5" aria-label={t("page.feedback")}>
              <FeedbackList key={product.slug} slug={product.slug}
                settings={product.repoUrl && parseGithubRepository(product.repoUrl) ? <FeedbackSettingsMenu slug={product.slug} /> : undefined}>
                <FeedbackForm slug={product.slug} githubDeliveryAvailable={githubDeliveryAvailable} />
              </FeedbackList>
            </section>
          )}
        </div>

        <aside id="evidence" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <InfoCard product={product} repository={detail.repository} freshness={detail.freshness} unclaimed={detail.unclaimed} />
          <PreviewFigure product={product} media={detail.media} />
          {detail.unclaimed && (
            <UnclaimedOwnerContact repoUrl={product.repoUrl} slug={product.slug} installable={product.accessMode === "installable"} />
          )}
          {product.status === "unverified" && (
            <section className="rounded-[12px] border border-line bg-bg-card p-5">
              <h2 className="text-[15px] font-extrabold text-fg">{t("page.unlisted")}</h2>
              <p className="mt-2 text-[13px] leading-6 text-fg-2">
                {t("page.verify", { command: "/nomorevibe verify" })}
              </p>
            </section>
          )}
        </aside>
      </div>

      <RelatedRow category={product.category} items={related} total={risingTotal} basis={detail.relatedBasis} />
    </main></I18nProvider>
  );
}
