import Link from "next/link";
import { StarMetric } from "@/components/StarMetric";
import { ProjectTile } from "@/components/home/ProjectTile";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";
import { ProductActivityRow } from "./ProductActivityRow";
import { IntroductionSource } from "./IntroductionSource";

/** 등재일을 "10.02" 로 — 가로 띠의 '새로 나온' 카드가 쓴다 */
function listedLabel(at: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" })
    .format(at).replace(/\. ?/g, ".").replace(/\.$/, "");
}

/** 기존 작은 카드 — 큰 썸네일 · 이름 한 줄 · 소개 한 줄 · ★과 활동 정보 */
export function CompactCard({ product, trailing }: { product: ProductListItem; trailing: "category" | "listed" }) {
  return (
    <article className="compact-card">
      <Link href={`/p/${product.slug}`} className="compact-visual" aria-label={`${product.name} 상세 보기`}>
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"} />
      </Link>
      <div className="compact-body">
        <h3 className="compact-title"><Link href={`/p/${product.slug}`}>{product.name}</Link></h3>
        <p className="card-category">{categoryLabel(product.category)}</p>
        <p className="compact-tagline" title={product.tagline}>{product.tagline}</p>
        <IntroductionSource source={product.taglineSource} />
        <p className="compact-meta">
          <StarMetric value={product} />
          {trailing === "listed" && <span> · {listedLabel(product.listedAt)}</span>}
        </p>
        <ProductActivityRow activity={product.activity} compact />
      </div>
    </article>
  );
}
