import { ProductIcon } from "@/components/ProductIcon";
import { StatusBadge } from "@/components/TrustBadges";
import { Tag } from "@/components/Tag";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import type { ProductLifecycle } from "@/lib/db/product-evidence-schema";
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
  unclaimed,
  lifecycle,
  rank,
  health,
}: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  lifecycle: ProductLifecycle | null;
  rank: ProductDetailView["rank"];
  health: ProductDetailView["health"];
}) {
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;
  const healthLabel = health.down
    ? "접속 불안정"
    : health.checkedAt
      ? `온라인${health.latencyMs === null ? "" : ` · ${health.latencyMs}ms`}`
      : "가동 상태 확인 전";

  return (
    <section className="rounded-[14px] border border-line bg-bg-card p-5 sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProductIcon name={product.name} ogImage={safeIcon} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[28px] font-extrabold tracking-[-0.035em] text-fg sm:text-[34px]">
              {product.name}
            </h1>
            <StatusBadge status={product.status} unclaimed={unclaimed} size="md" />
            {rank && (
              <span className="rounded-full border border-accent/35 bg-accent-soft px-2.5 py-1 font-mono text-[13px] font-bold text-accent">
                이번 시즌 #{rank.rank}
              </span>
            )}
          </div>
          <p className="mt-2 max-w-[760px] text-[15px] leading-7 text-fg-2">{product.tagline}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Tag>{product.category}</Tag>
            {lifecycle && <Tag>{LIFECYCLE_LABELS[lifecycle]}</Tag>}
            <span className={`inline-flex rounded-full border px-2.5 py-1 text-[13px] font-semibold ${
              health.down ? "border-down/30 bg-down/5 text-down" : "border-up/30 bg-up/10 text-up"
            }`}>
              {healthLabel}
            </span>
          </div>
          <a
            href={`/go/${product.slug}`}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="mt-4 inline-flex max-w-full items-center gap-1 truncate text-[13px] font-semibold text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {displayUrl} ↗
          </a>
        </div>
        <div className="flex shrink-0 gap-2 sm:flex-col lg:flex-row">
          <ShareButton title={product.name} path={`/p/${product.slug}`} />
          <a
            href={`/go/${product.slug}`}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] bg-accent-solid px-5 text-[13px] font-extrabold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-none"
          >
            제품 방문하기 ↗
          </a>
        </div>
      </div>
    </section>
  );
}
