import Link from "next/link";
import { CompactCard } from "@/components/home/CompactCard";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 홈의 가로 띠 — '지금 뜨는'·'이번 주 새로 나온'·상세의 '같은 분야에서 지금 뜨는' 이 같은 모양을 쓴다 */
export function CompactRow({ id, title, note, more, items, trailing, priority = false }: {
  id: string;
  title: string;
  note?: string;
  more?: { href: string; label: string };
  items: ProductListItem[];
  trailing: "category" | "listed";
  /** 화면 첫 띠 — 앞 세 장의 그림을 늦추지 않고 먼저 받는다(PERF-03, 홈 LCP 는 '지금 뜨는' 첫 카드) */
  priority?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={`${id}-title`} className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        {more && <Link prefetch={false} className="row-more" href={more.href}>{more.label} ›</Link>}
      </div>
      <div className="compact-grid">
        {items.map((product, index) => <CompactCard key={product.slug} product={product} trailing={trailing} priority={priority && index < 3} />)}
      </div>
    </section>
  );
}
