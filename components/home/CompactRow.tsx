import Link from "next/link";
import { CompactCard } from "@/components/home/CompactCard";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 홈의 가로 띠 — '지금 뜨는'·'이번 주 새로 나온'·상세의 '같은 분야에서 지금 뜨는' 이 같은 모양을 쓴다 */
export function CompactRow({ id, title, note, more, items, trailing }: {
  id: string;
  title: string;
  note?: string;
  more?: { href: string; label: string };
  items: ProductListItem[];
  trailing: "category" | "listed";
}) {
  if (items.length === 0) return null;
  return (
    <section id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={`${id}-title`} className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        {more && <Link className="row-more" href={more.href}>{more.label} ›</Link>}
      </div>
      <div className="compact-grid">
        {items.map((product) => <CompactCard key={product.slug} product={product} trailing={trailing} />)}
      </div>
    </section>
  );
}
