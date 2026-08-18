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
export function ProductCard({ product }: { product: ProductListItem }) {
  const { metrics } = product;

  return (
    <Link
      href={`/p/${product.slug}`}
      className="flex items-center gap-4 border-b border-line bg-bg-card px-5 py-4 transition-colors last:border-b-0 hover:bg-bg-hover"
    >
      <ProductIcon name={product.name} ogImage={product.ogImage} size={44} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14.5px] font-bold">{product.name}</span>
          <StatusBadge status={product.status} unclaimed={product.unclaimed} />
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-3">{product.tagline}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Tag>{product.category}</Tag>
          {product.builder && <BuilderBadge builder={product.builder} claim={product.builderClaim} />}
          {product.stack.slice(0, 4).map((item) => (
            <Tag key={item}>{item}</Tag>
          ))}
        </div>
      </div>

      <div className="hidden shrink-0 text-right text-xs text-fg-3 sm:block">
        {metrics && metrics.clicks > 0 && (
          <div className="font-mono text-[12px] font-bold text-fg-2">
            {metrics.clicks}
            {metrics.delta24h !== null && metrics.delta24h !== 0 && (
              <span className={metrics.delta24h > 0 ? "ml-1 text-up" : "ml-1 text-down"}>
                {metrics.delta24h > 0 ? "▲" : "▼"}
                {Math.abs(metrics.delta24h)}
              </span>
            )}
          </div>
        )}
        {product.listedAt.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} 등록
      </div>
    </Link>
  );
}

/** 목록 전체 — 테두리를 한 번만 두르고 줄 사이를 나눈다 */
export function ProductList({ products }: { products: ProductListItem[] }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line">
      {products.map((product) => (
        <ProductCard key={product.slug} product={product} />
      ))}
    </div>
  );
}
