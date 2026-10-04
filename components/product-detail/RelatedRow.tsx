import { CompactRow } from "@/components/home/CompactRow";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 상세 끝 — 같은 분야에서 지금 뜨는. 홈의 가로 띠와 같은 부품. 분야 총수를 못 세면 숫자 없이 '모두 보기' */
export function RelatedRow({ category, items, total }: { category: string; items: ProductListItem[]; total: number | null }) {
  const label = categoryLabel(category);
  return (
    <CompactRow
      id="related"
      title={`${label} 분야에서 지금 뜨는`}
      note="마지막 확인 사이 GitHub 스타가 늘어난 순 · 스타 2천 미만"
      more={{
        href: `/?category=${encodeURIComponent(category)}&sort=recent`,
        label: total === null ? "모두 보기" : `${label} ${total.toLocaleString("ko-KR")}개 모두 보기`,
      }}
      items={items}
      trailing="category"
    />
  );
}
