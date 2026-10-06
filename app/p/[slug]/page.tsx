import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildTools } from "@/components/product-detail/BuildTools";
import { DetailEntry } from "@/components/product-detail/DetailEntry";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { InfoCard } from "@/components/product-detail/InfoCard";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { LanguageBar } from "@/components/product-detail/LanguageBar";
import { PreviewFigure } from "@/components/product-detail/PreviewFigure";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { RelatedRow } from "@/components/product-detail/RelatedRow";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { getProductDetail, getProductIdentity } from "@/lib/domain/products/detail-view";
import { categoryLabel } from "@/lib/domain/products/labels";
import { countProducts } from "@/lib/domain/products/repository";
import type { Category } from "@/lib/domain/products/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductIdentity(slug);
  if (!product) return {};
  return {
    title: `${product.name} — NoMoreVibe`,
    description: product.tagline,
    robots: product.status === "verified" ? undefined : { index: false, follow: false },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  // '모두 보기'의 숫자일 뿐 — 세다가 실패해도 페이지는 그대로 선다. 기본 정보(메타데이터와 같은 요청 안에서 한 번 읽는다)를
  // 받자마자 상세와 함께 센다 — 상세를 다 받은 뒤 세던 한 왕복을 겹친다(2026-10-06)
  const identity = await getProductIdentity(slug);
  const categoryLoad = identity
    ? countProducts({ statuses: ["verified", "seeded"], excludeDown: true, category: identity.category as Category }).catch(() => null)
    : Promise.resolve(null);
  const detail = await getProductDetail(slug);
  if (!detail) notFound();

  const languages = (detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name);
  const categoryTotal = await categoryLoad;

  return (
    <main className="wrap pb-14">
      <DetailEntry slug={slug} />
      <nav aria-label="경로" className="flex items-center gap-2 pt-4 text-[13px] text-fg-3">
        <Link prefetch={false} href="/" className="shrink-0 hover:text-fg">발견하기</Link>
        <span aria-hidden>›</span>
        <Link prefetch={false} href={`/?category=${encodeURIComponent(detail.product.category)}&sort=recent`} className="shrink-0 hover:text-fg">{categoryLabel(detail.product.category)}</Link>
        <span aria-hidden>›</span>
        <span className="min-w-0 truncate text-fg">{detail.product.name}</span>
      </nav>

      <ProductHero product={detail.product} unclaimed={detail.unclaimed} risingRank={detail.risingRank} health={detail.health} languages={languages} />

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
            toolScan={detail.toolScan}
          />
          <IntroSection product={detail.product} profile={detail.profile} readmeExcerpt={detail.readmeExcerpt} unclaimed={detail.unclaimed} />
          <LanguageBar repository={detail.repository} />
          <UpdateTimeline updates={detail.updates} />
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

      <RelatedRow category={detail.product.category} items={detail.related} total={categoryTotal} />
    </main>
  );
}
