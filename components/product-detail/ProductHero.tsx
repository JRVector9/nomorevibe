/* eslint-disable @next/next/no-img-element -- 검증 후 내부에 보관한 이미지를 저장 치수 그대로 제공한다. */
import { ProductIcon } from "@/components/ProductIcon";
import { StatusBadge } from "@/components/TrustBadges";
import { Tag } from "@/components/Tag";
import type { ProductLifecycle } from "@/lib/db/product-evidence-schema";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { formatDate } from "./format";
import { ShareButton } from "./ShareButton";

const LIFECYCLE_LABELS: Record<ProductLifecycle, string> = {
  prototype: "프로토타입",
  beta: "베타",
  ga: "정식 운영",
  maintenance: "유지보수",
  sunset: "종료 예정",
  unknown: "운영 단계 미확인",
};

export function ProductHero({
  product,
  media,
  unclaimed,
  lifecycle,
  rank,
  health,
}: {
  product: ProductDetailView["product"];
  media: ProductDetailView["media"];
  unclaimed: boolean;
  lifecycle: ProductLifecycle | null;
  rank: ProductDetailView["rank"];
  health: ProductDetailView["health"];
}) {
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;
  const representative = media[0] ?? null;
  const current = isHealthCurrent(health.checkedAt);
  const healthLabel = !health.checkedAt ? "가동 상태 확인 전"
    : !current ? "가동 상태 재확인 필요"
    : health.down ? "접속 불안정"
    : health.lastCheckSucceeded === false ? "최근 접속 확인 실패"
    : `온라인${health.latencyMs === null ? "" : ` · ${health.latencyMs}ms`}`;

  return (
    <section
      data-layout="editorial-product-hero"
      className="overflow-hidden rounded-[14px] border border-line bg-bg-card"
    >
      <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.75fr)]">
        <div data-testid="product-hero-media" className="min-w-0 border-b border-line bg-bg-soft lg:border-b-0 lg:border-r">
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-card px-4 py-3">
            <h2 className="text-[13px] font-extrabold text-fg">제품 화면</h2>
            {representative && (
              <span className="font-mono text-[13px] text-fg-3">
                {representative.width} × {representative.height}
              </span>
            )}
            {!representative && safeIcon && (
              <span className="text-[13px] text-fg-3">공개 페이지 대표 이미지</span>
            )}
          </div>
          {representative ? (
            <figure>
              <div className="flex min-h-[260px] items-center p-3 sm:min-h-[400px] sm:p-5 lg:min-h-[520px]">
                <img
                  src={representative.src}
                  width={representative.width}
                  height={representative.height}
                  alt={representative.altText || `${product.name} 제품 화면`}
                  loading="eager"
                  fetchPriority="high"
                  className="h-auto max-h-[560px] w-full object-contain"
                />
              </div>
              <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-card px-4 py-3 text-[13px] leading-5 text-fg-3">
                <span>{representative.altText || `${product.name} 제품 화면`}</span>
                <span>사본 갱신 {formatDate(representative.lastSuccessAt)}</span>
                {representative.sourceMissing && (
                  <span className="w-full text-down">원본 출처는 사라졌지만 마지막 내부 사본을 표시합니다.</span>
                )}
              </figcaption>
            </figure>
          ) : safeIcon ? (
            <figure>
              <div className="flex min-h-[260px] items-center p-3 sm:min-h-[400px] sm:p-5 lg:min-h-[520px]">
                <img
                  src={safeIcon}
                  width={1200}
                  height={630}
                  alt={`${product.name} 공개 페이지 대표 이미지`}
                  loading="eager"
                  fetchPriority="high"
                  className="h-auto max-h-[560px] w-full object-contain"
                />
              </div>
              <figcaption className="border-t border-line bg-bg-card px-4 py-3 text-[13px] leading-5 text-fg-3">
                공개 페이지에서 보관한 대표 이미지
              </figcaption>
            </figure>
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-5 px-6 py-12 text-center lg:min-h-[520px]">
              <ProductIcon name={product.name} ogImage={safeIcon} size={112} />
              <div>
                <p className="font-bold text-fg">아직 보관된 제품 화면이 없습니다.</p>
                <p className="mt-2 text-[13px] leading-5 text-fg-3">출처에서 확인한 이미지를 안전하게 보관한 뒤 표시합니다.</p>
              </div>
            </div>
          )}
        </div>

        <div data-testid="product-hero-copy" className="flex min-w-0 flex-col p-6 sm:p-8 lg:p-9">
          <p className="text-[13px] font-extrabold tracking-[0.14em] text-accent">{product.category}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <h1 className="text-[38px] font-extrabold leading-none tracking-[-0.055em] text-fg sm:text-[48px]">
              {product.name}
            </h1>
            <StatusBadge status={product.status} unclaimed={unclaimed} size="md" />
          </div>
          {rank && (
            <p className="mt-3 font-mono text-[13px] font-bold text-accent">이번 시즌 #{rank.rank}</p>
          )}
          <p className="mt-7 text-[19px] font-bold leading-8 tracking-[-0.02em] text-fg">{product.tagline}</p>
          <p className="mt-4 whitespace-pre-line text-[15px] leading-7 text-fg-2">{product.description}</p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Tag>{product.category}</Tag>
            {lifecycle && <Tag>{LIFECYCLE_LABELS[lifecycle]}</Tag>}
            <span className={`inline-flex rounded-full border px-2.5 py-1 text-[13px] font-semibold ${
              !current ? "border-line bg-bg-soft text-fg-3" : health.down || health.lastCheckSucceeded === false ? "border-down/30 bg-down/5 text-down" : "border-up/30 bg-up/10 text-up"
            }`}>
              {healthLabel}
            </span>
          </div>

          <div className="mt-7 flex flex-wrap gap-2">
            <a
              href={`/go/${product.slug}`}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] bg-accent-solid px-5 text-[13px] font-extrabold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-none"
            >
              제품 방문하기 ↗
            </a>
            <ShareButton title={product.name} path={`/p/${product.slug}`} />
          </div>
          <a
            href={`/go/${product.slug}`}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="mt-5 inline-flex max-w-full items-center gap-1 truncate text-[13px] font-semibold text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {displayUrl} ↗
          </a>
          <p className="mt-auto pt-6 text-[13px] leading-5 text-fg-3">
            {unclaimed
              ? "공개 페이지에서 자동 수집한 설명입니다. 제작자가 아직 직접 확인하지 않았습니다."
              : "메이커가 제공한 정보와 공개 출처에서 확인한 정보를 구분해 표시합니다."}
          </p>
        </div>
      </div>
    </section>
  );
}
