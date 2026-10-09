import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import { ProjectTile } from "@/components/home/ProjectTile";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";
import { formatPublicDate } from "@/lib/format/time";
import "./cards.css";

/**
 * 가로 띠의 작은 카드 — 썸네일 · 이름 한 줄 · 소개 한 줄 · 메타 한 줄("★ 990 +12 · 분야").
 *
 * 카드 하나가 링크 하나다(UX-30, ProjectCard 와 같다). 메타는 한 줄로 고정하고(UX-29) 활동 날짜·빈 집계는 싣지 않는다 —
 * 칸이 좁아 '최근 업데이트 n일 전'까지 넣으면 잘리고, '지금 뜨는' 띠에서 '0회' 같은 부정 신호가 됐다.
 * '이번 주 새로 나온' 띠(listed)는 등록한 날을 붙인다.
 */
export function CompactCard({ product, trailing }: { product: ProductListItem; trailing: "category" | "listed" }) {
  const now = new Date();
  const href = `/p/${product.slug}`;
  return (
    <article className="compact-card">
      <Link prefetch={false} href={href} className="compact-visual" tabIndex={-1} aria-hidden="true">
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"} category={product.category} />
      </Link>
      <div className="compact-body">
        <h3 className="compact-title"><Link prefetch={false} href={href} className="card-link">{product.name}</Link></h3>
        <ProductTagline tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="compact-tagline" />
        {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) */}
        <p className="card-meta card-meta-compact card-dots">
          <StarMetric value={product} now={now} listedAt={product.listedAt} />
          <span>{categoryLabel(product.category)}</span>
          {trailing === "listed" && <span title="등록한 날">{formatPublicDate(product.listedAt, now)}</span>}
        </p>
      </div>
    </article>
  );
}
