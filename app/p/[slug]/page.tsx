import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildTools } from "@/components/product-detail/BuildTools";
import { DetailEntry } from "@/components/product-detail/DetailEntry";
import { DetailSkeleton } from "@/components/product-detail/DetailSkeleton";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { InfoCard } from "@/components/product-detail/InfoCard";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { LanguageBar } from "@/components/product-detail/LanguageBar";
import { PreviewFigure } from "@/components/product-detail/PreviewFigure";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { RelatedRow } from "@/components/product-detail/RelatedRow";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { categoryHref } from "@/components/home/browse-state";
import { pageTitle } from "@/lib/copy/brand";
import { getProductDetail, getProductIdentity } from "@/lib/domain/products/detail-view";
import { productIndexable } from "@/lib/domain/products/indexing";
import { categoryLabel } from "@/lib/domain/products/labels";
import { publicRead } from "@/lib/domain/products/public-reads";
import { countProducts } from "@/lib/domain/products/repository";
import type { Category } from "@/lib/domain/products/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/** 메타데이터·본문이 같은 제품을 여러 번 읽는다 — 30초 들고 있는다(lib/domain/products/public-reads.ts) */
const identityOf = (slug: string) => publicRead("detail", ["identity", slug], () => getProductIdentity(slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await identityOf(slug);
  if (!product) return {};
  return {
    title: pageTitle(product.name),
    description: product.tagline,
    // 색인 규칙은 sitemap 과 하나다(indexing.ts, UX-08·D1) — 내려달라는 요청이 들어오면 바로 noindex(엣지 사본은 그때 지운다 — takedown.ts)
    robots: productIndexable(product) ? undefined : { index: false, follow: false },
  };
}

/**
 * 없는 제품은 응답을 흘려보내기 전에 404 로 끝낸다 — 기본 정보(메타데이터와 같은 요청 안에서 한 번 읽는다)만 먼저 읽고,
 * 여러 표를 모아 읽는 본문은 그다음 Suspense 안에서 머리 골격(DetailSkeleton)을 먼저 보이며 채운다(UX-38).
 * 구간 loading.tsx 를 두면 응답이 골격부터 흘러가 상태 코드를 바꿀 수 없어, 없는 제품도 200 이 된다.
 */
export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const identity = await identityOf(slug);
  if (!identity) notFound();
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <ProductDetail slug={slug} category={identity.category} />
    </Suspense>
  );
}

async function ProductDetail({ slug, category }: { slug: string; category: string }) {
  // '모두 보기'의 숫자일 뿐 — 세다가 실패해도 페이지는 그대로 선다. 기본 정보를 받자마자 상세와 함께 센다 —
  // 상세를 다 받은 뒤 세던 한 왕복을 겹친다(2026-10-06)
  // 분야 전체가 아니라 그 분야에서 지금 뜨는 수 — 링크가 여는 홈 목록이 세는 것과 같은 조건이다
  const risingLoad = publicRead("count", ["category-rising", category], () => countProducts({ statuses: ["verified", "seeded"], excludeDown: true, rising: true, category: category as Category })).catch(() => null);
  // 기본 정보를 읽은 뒤 그사이 내려갔으면 여기서 404 화면(응답은 이미 흘렀으므로 상태는 200, noindex 가 붙는다)
  const detail = await publicRead("detail", ["detail", slug], () => getProductDetail(slug));
  if (!detail) notFound();

  const languages = (detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name);
  const risingTotal = await risingLoad;
  // 날짜의 '올해'를 정하는 시각 — 업데이트 목록(클라이언트)도 서버가 읽은 이 값으로 그린다
  const now = new Date();

  return (
    <main className="wrap pb-14">
      <DetailEntry slug={slug} />
      <nav aria-label="경로" className="flex items-center gap-2 pt-4 text-[13px] text-fg-2">
        <Link prefetch={false} href="/" className="shrink-0 hover:text-fg">발견하기</Link>
        <span aria-hidden>›</span>
        <Link prefetch={false} href={categoryHref(detail.product.category, { sort: "recent" })} className="shrink-0 hover:text-fg">{categoryLabel(detail.product.category)}</Link>
        <span aria-hidden>›</span>
        <span className="min-w-0 truncate text-fg">{detail.product.name}</span>
      </nav>

      <ProductHero product={detail.product} unclaimed={detail.unclaimed} risingRank={detail.risingRank} health={detail.health} languages={languages}
        repositoryUrl={detail.repository?.facts?.repositoryUrl ?? null} />

      {/* 넓으면 2:1 두 열, 좁으면 오른쪽 열이 본문 아래로 */}
      <div className="flex flex-wrap items-start gap-x-12 gap-y-9 pt-7">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-9">
          <FactsStrip product={detail.product} repository={detail.repository} license={detail.license} health={detail.health} visits={detail.visits} />
          <BuildTools
            product={detail.product}
            unclaimed={detail.unclaimed}
            agents={detail.agents}
            observedAgentFacts={detail.observedAgentFacts}
            skills={detail.skills}
            aiLevel={detail.aiLevel}
          />
          <IntroSection product={detail.product} profile={detail.profile} readmeExcerpt={detail.readmeExcerpt} unclaimed={detail.unclaimed} />
          <LanguageBar repository={detail.repository} />
          <UpdateTimeline updates={detail.updates} now={now} />
        </div>

        <aside id="evidence" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <InfoCard product={detail.product} repository={detail.repository} freshness={detail.freshness} unclaimed={detail.unclaimed} />
          <PreviewFigure product={detail.product} media={detail.media} />
          {detail.unclaimed && (
            <UnclaimedOwnerContact repoUrl={detail.product.repoUrl} slug={detail.product.slug} installable={detail.product.accessMode === "installable"} />
          )}
          {detail.product.status === "unverified" && (
            <section className="rounded-[12px] border border-line bg-bg-card p-5">
              <h2 className="text-[15px] font-extrabold text-fg">아직 공개 목록에 없습니다</h2>
              <p className="mt-2 text-[13px] leading-6 text-fg-2">
                도메인 소유권을 확인하면 공개 목록에 게시됩니다. 프로젝트 폴더에서{" "}
                <code className="font-mono font-semibold text-accent">/nomorevibe verify</code>를 실행하세요.
              </p>
            </section>
          )}
        </aside>
      </div>

      <RelatedRow category={detail.product.category} items={detail.related} total={risingTotal} />
    </main>
  );
}
