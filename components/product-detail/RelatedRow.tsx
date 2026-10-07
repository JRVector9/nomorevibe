import { CompactRow } from "@/components/home/CompactRow";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";

/**
 * 상세 끝 — 같은 분야에서 지금 뜨는. 홈의 가로 띠와 같은 부품.
 * '모두 보기'는 그 분야를 거른 홈의 기본 목록('추천' = 같은 급상승 순서)으로 가고, 숫자는 그 목록의 개수다.
 * 개수를 못 세면 숫자 없이 '모두 보기'.
 */
export function RelatedRow({ category, items, total }: { category: string; items: ProductListItem[]; total: number | null }) {
  const label = categoryLabel(category);
  return (
    <CompactRow
      id="related"
      title={`${label} 분야에서 지금 뜨는`}
      note="최근 두 확인 사이 하루 평균 GitHub 스타가 많이 는 순 · 스타 2천 미만"
      more={{
        href: `/?category=${encodeURIComponent(category)}`,
        label: total === null ? "모두 보기" : `${total.toLocaleString("ko-KR")}개 모두 보기`,
      }}
      items={items}
      trailing="category"
    />
  );
}
