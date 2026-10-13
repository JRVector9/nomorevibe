import Link from "next/link";
import { categoryHref } from "@/components/home/browse-state";
import { CATEGORIES } from "@/lib/domain/products/categories";
import { categoryLabel } from "@/lib/domain/products/labels";
import { hiddenByDefault } from "@/lib/domain/products/visibility";

/** 고를 수 있는 분야 전부 — 기본 목록에서 빼는 분야(계약 C3)는 없다. 개수를 세지 않는 자리(없는 분야 안내)에 쓴다 */
export function CategoryLinks() {
  return (
    <nav className="empty-suggest" aria-label="분야">
      <h4>분야에서 찾아보기</h4>
      <ul className="chips">
        {CATEGORIES.filter((category) => !hiddenByDefault(category)).map((category) => (
          <li key={category}><Link prefetch={false} href={categoryHref(category)} className="chip">{categoryLabel(category)}</Link></li>
        ))}
      </ul>
    </nav>
  );
}
