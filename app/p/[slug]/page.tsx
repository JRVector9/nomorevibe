import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildTools } from "@/components/product-detail/BuildTools";
import { EvidenceSummary } from "@/components/product-detail/EvidenceSummary";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { FreshnessPanel } from "@/components/product-detail/FreshnessPanel";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { LanguageBar } from "@/components/product-detail/LanguageBar";
import { ProductFacts } from "@/components/product-detail/ProductFacts";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { RepositoryEvidence } from "@/components/product-detail/RepositoryEvidence";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { getProductDetail, getProductIdentity } from "@/lib/domain/products/detail-view";

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
  const detail = await getProductDetail(slug);
  if (!detail) notFound();

  return (
    <main className="mx-auto max-w-[1220px] px-4 pb-20 sm:px-6">
      <nav aria-label="경로" className="py-4 text-[13px] text-fg-3">
        <Link href="/" className="hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          제품
        </Link>
        <span aria-hidden className="px-2">›</span>
        <span>{detail.product.category}</span>
        <span aria-hidden className="px-2">›</span>
        <span className="text-fg-2">{detail.product.name}</span>
      </nav>

      <div className="space-y-5">
        <ProductHero
          product={detail.product}
          unclaimed={detail.unclaimed}
          risingRank={detail.risingRank}
          health={detail.health}
          languages={(detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name)}
        />
        <FactsStrip product={detail.product} repository={detail.repository} license={detail.license} health={detail.health} visits={detail.visits} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-8">
        <div className="flex flex-col gap-9 lg:col-start-1 lg:row-start-1">
          <IntroSection product={detail.product} profile={detail.profile} readmeExcerpt={detail.readmeExcerpt} unclaimed={detail.unclaimed} />
          <BuildTools
            product={detail.product}
            unclaimed={detail.unclaimed}
            agents={detail.agents}
            observedAgentFacts={detail.observedAgentFacts}
            skills={detail.skills}
            toolScan={detail.toolScan}
          />
          <LanguageBar repository={detail.repository} />
        </div>

        <aside id="evidence" className="space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <EvidenceSummary
            links={detail.links}
            freshness={detail.freshness}
            profileUpdatedAt={detail.profile?.updatedAt ?? null}
          />
          {detail.unclaimed && (
            <UnclaimedOwnerContact repoUrl={detail.product.repoUrl} slug={detail.product.slug} installable={detail.product.accessMode === "installable"} />
          )}
          <ProductFacts product={detail.product} profile={detail.profile} links={detail.links} unclaimed={detail.unclaimed} />
          {detail.product.status === "unverified" && (
            <section className="rounded-[12px] border border-line bg-bg-card p-5">
              <h2 className="text-[15px] font-extrabold text-fg">아직 공개 목록에 없습니다</h2>
              <p className="mt-2 text-[13px] leading-6 text-fg-2">
                도메인 소유권을 확인하면 공개 목록에 게시됩니다. 프로젝트 폴더에서{" "}
                <code className="font-mono font-semibold text-accent">/nomorevibe verify</code>를 실행하세요.
              </p>
            </section>
          )}
          <RepositoryEvidence repository={detail.repository} license={detail.license} dailyStars={detail.product} />
          <FreshnessPanel freshness={detail.freshness} />
        </aside>

        <div className="lg:col-start-1 lg:row-start-2">
          <UpdateTimeline updates={detail.updates} />
        </div>
      </div>
    </main>
  );
}
