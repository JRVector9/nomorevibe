/* eslint-disable @next/next/no-img-element -- 검증 후 내부에 보관한 이미지를 저장 치수 그대로 제공한다. */
import { ProjectCover, coverArtFor } from "@/components/home/ProjectCover";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { StatusBadge } from "@/components/TrustBadges";
import { Tag } from "@/components/Tag";
import type { ProductLifecycle } from "@/lib/db/product-evidence-schema";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import type { TaglineSource } from "@/lib/db/schema";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { formatDate } from "./format";
import { ShareButton } from "./ShareButton";

/** 메이커가 쓴 소개가 없어 우리가 채운 줄 — 누가 무엇을 보고 적었는지 */
const TAGLINE_SOURCE_LABELS: Record<Exclude<TaglineSource, "maker">, string> = {
  ai_page: "AI가 요약 · 페이지 글에서",
  ai_readme: "AI가 요약 · README에서",
  ai_both: "AI가 요약 · 페이지와 README에서",
  editor: "직접 요약 · 페이지를 보고 적었습니다",
};

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
  const thumbnail = thumbnailPresentation(safeIcon);
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
        <div
          id="product-screen"
          data-testid="product-hero-media"
          className="min-w-0 scroll-mt-[90px] border-b border-line bg-bg-soft lg:border-b-0 lg:border-r"
        >
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-card px-4 py-3">
            <h2 className="text-[13px] font-extrabold text-fg">{representative || !safeIcon ? "제품 화면" : "대표 이미지"}</h2>
            {representative && (
              <span className="font-mono text-[13px] text-fg-3">
                {representative.width} × {representative.height}
              </span>
            )}
            {!representative && safeIcon && (
              <span className="text-[13px] text-fg-3">{thumbnail.label}</span>
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
                  <span className="w-full text-down">원본 없음 · 보관 이미지</span>
                )}
              </figcaption>
            </figure>
          ) : safeIcon ? (
            <figure>
              <div className="flex min-h-[260px] items-center p-3 sm:min-h-[400px] sm:p-5 lg:min-h-[520px]">
                <img
                  src={safeIcon}
                  width={thumbnail.width}
                  height={thumbnail.height}
                  style={thumbnail.contain ? { maxWidth: thumbnail.identity ? Math.min(thumbnail.width, 112) : thumbnail.width, margin: "auto" } : undefined}
                  alt={`${product.name} ${thumbnail.label}`}
                  loading="eager"
                  fetchPriority="high"
                  className="h-auto max-h-[560px] w-full object-contain"
                />
              </div>
              <figcaption className="border-t border-line bg-bg-card px-4 py-3 text-[13px] leading-5 text-fg-3">
                {thumbnail.label}
              </figcaption>
            </figure>
          ) : (
            <figure>
              <div className="detail-list-cover flex min-h-[320px] flex-col justify-center p-4 sm:min-h-[400px] sm:p-6 lg:min-h-[520px]">
                <ProjectCover
                  name={product.name}
                  ogImage={safeIcon}
                  art={coverArtFor(product.slug)}
                />
              </div>
              <figcaption className="border-t border-line bg-bg-card px-4 py-3 text-[13px] leading-5 text-fg-3">
                목록 미리보기
              </figcaption>
            </figure>
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
          {/* 지은 줄은 무엇을 보고 지었는지까지 밝힌다 — 메이커가 소개를 쓰면 이 표시는 사라진다 */}
          {product.taglineSource !== "maker" && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-bg-soft px-2.5 py-1 text-[13px] font-semibold text-fg-3">
              {TAGLINE_SOURCE_LABELS[product.taglineSource]}
            </p>
          )}
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
        </div>
      </div>
    </section>
  );
}
