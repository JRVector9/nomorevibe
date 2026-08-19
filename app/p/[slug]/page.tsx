import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildProvenance } from "@/components/product-detail/BuildProvenance";
import { EvidenceSummary } from "@/components/product-detail/EvidenceSummary";
import { FreshnessPanel } from "@/components/product-detail/FreshnessPanel";
import { ProductFacts } from "@/components/product-detail/ProductFacts";
import { ProductGallery } from "@/components/product-detail/ProductGallery";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { ProductIntroduction } from "@/components/product-detail/ProductIntroduction";
import { ProductMetrics } from "@/components/product-detail/ProductMetrics";
import { RepositoryEvidence } from "@/components/product-detail/RepositoryEvidence";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { getProductDetail, getProductIdentity } from "@/lib/domain/products/detail-view";
import { TakedownForm } from "./TakedownForm";

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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_340px] md:gap-5">
        <div className="md:col-span-2">
          <ProductHero
            product={detail.product}
            unclaimed={detail.unclaimed}
            lifecycle={detail.profile?.lifecycle ?? null}
            rank={detail.rank}
            health={detail.health}
          />
        </div>

        <div className="md:col-span-2">
          <ProductMetrics visits={detail.visits} health={detail.health} />
        </div>

        <div className="md:col-span-2">
          <EvidenceSummary
            links={detail.links}
            freshness={detail.freshness}
            profileUpdatedAt={detail.profile?.updatedAt ?? null}
          />
        </div>

        <div className="md:col-start-1 md:row-start-4">
          <ProductGallery name={detail.product.name} media={detail.media} />
        </div>

        <div className="md:col-start-1 md:row-start-5">
          <ProductIntroduction product={detail.product} profile={detail.profile} unclaimed={detail.unclaimed} />
        </div>

        <div className="space-y-4 md:col-start-2 md:row-start-4">
          <ProductFacts product={detail.product} profile={detail.profile} links={detail.links} unclaimed={detail.unclaimed} />
          {detail.unclaimed && (
            <section className="rounded-[12px] border border-accent/35 bg-accent-soft p-5">
              <h2 className="text-[15px] font-extrabold text-fg">이 제품의 주인이신가요?</h2>
              <p className="mt-2 text-[13px] leading-6 text-fg-2">
                공개 출처에서 발견해 대신 등록한 제품입니다. 현재 정보에는 추정값이 포함될 수 있습니다.
                프로젝트 폴더에서 <code className="font-mono font-semibold text-accent">/nomorevibe</code>를
                실행하면 소유권을 확인하고 직접 갱신할 수 있습니다.
              </p>
              <TakedownForm slug={detail.product.slug} />
            </section>
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
        </div>

        <div className="md:col-start-2 md:row-start-5">
          <RepositoryEvidence repository={detail.repository} license={detail.license} />
        </div>

        <div className="md:col-start-2 md:row-start-6">
          <BuildProvenance
            product={detail.product}
            profile={detail.profile}
            unclaimed={detail.unclaimed}
            agents={detail.agents}
            skills={detail.skills}
          />
        </div>

        <div className="md:col-start-2 md:row-start-7">
          <FreshnessPanel freshness={detail.freshness} />
        </div>

        <div className="md:col-start-1 md:row-span-2 md:row-start-6">
          <UpdateTimeline updates={detail.updates} />
        </div>
      </div>
    </main>
  );
}
