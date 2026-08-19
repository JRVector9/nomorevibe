import Link from "next/link";
import type { ProductListItem } from "@/lib/domain/products/view";
import { ProductIcon } from "./ProductIcon";
import { StatusBadge, BuilderBadge } from "./TrustBadges";
import { Tag } from "./Tag";

/**
 * 목록 한 줄.
 *
 * 홈에만 있던 마크업이다. 카테고리 필터·검색 같은 화면이 붙으면 같은 줄이 그대로 필요한데,
 * page.tsx 안에 있으면 복사해 가게 된다 — 그러면 배지 하나 고칠 때 화면마다 어긋난다.
 */
/** 며칠째 죽어 있는지 — 어제부터인지 2주째인지는 사용자에게 다른 뜻이다 */
function downFor(since: Date | null): string {
  if (!since) return "응답 없음";
  const days = Math.floor((Date.now() - since.getTime()) / 86_400_000);
  return days < 1 ? "응답 없음" : `${days}일째 응답 없음`;
}

export function ProductCard({ product, rank }: { product: ProductListItem; rank?: number }) {
  const { metrics, health } = product;

  return (
    <Link
      href={`/p/${product.slug}`}
      className="flex items-center gap-4 border-b border-line bg-bg-card px-5 py-4 transition-colors last:border-b-0 hover:bg-bg-hover"
    >
      {rank !== undefined && (
        <span className="hidden w-5 shrink-0 text-right font-mono text-[13px] font-semibold text-fg-3 sm:block">
          {rank}
        </span>
      )}
      <ProductIcon name={product.name} ogImage={product.ogImage} size={44} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14.5px] font-bold">{product.name}</span>
          <StatusBadge status={product.status} unclaimed={product.unclaimed} />
          {health?.down && (
            <span className="shrink-0 rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[13px] font-semibold text-down">
              {downFor(health.since)}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-fg-3">{product.tagline}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Tag>{product.category}</Tag>
          {product.builder && <BuilderBadge builder={product.builder} claim={product.builderClaim} />}
          {product.stack.slice(0, 4).map((item) => (
            <Tag key={item}>{item}</Tag>
          ))}
        </div>
      </div>

      <div className="hidden shrink-0 text-right text-[13px] text-fg-3 sm:block">
        {metrics && metrics.clicks > 0 && (
          <div className="font-mono text-[13px] font-bold text-fg-2">
            {metrics.clicks}
            {metrics.changePercent !== null && metrics.changePercent !== 0 && (
              <span className={metrics.changePercent > 0 ? "ml-1 text-up" : "ml-1 text-down"}>
                {metrics.changePercent > 0 ? "▲" : "▼"}
                {Math.abs(metrics.changePercent)}%
              </span>
            )}
          </div>
        )}
        {product.listedAt.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} 등록
      </div>
    </Link>
  );
}

/**
 * 목록 전체 — 테두리를 한 번만 두르고 줄 사이를 나눈다.
 *
 * 순위는 정렬이 순위를 뜻할 때만 붙인다. 최신순 목록에 1, 2, 3을 달면 그것이 무슨 등수인지
 * 오해를 만든다.
 */
export function ProductList({ products, ranked }: { products: ProductListItem[]; ranked?: boolean }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line">
      {products.map((product, index) => (
        <ProductCard key={product.slug} product={product} rank={ranked ? index + 1 : undefined} />
      ))}
    </div>
  );
}
