import { hiddenByDefault } from "@/lib/domain/products/visibility";

/**
 * 저장할 수 있는 제품인가 — 계정 저장(lib/me/saved.ts savedPublic)과 같은 공개 조건: 검증·시드 제품이고, 개인 프로필은 주인이 있을 때만.
 * 상세는 검증 전·주인 없는 프로필도 열린다. 거기서 저장하면 계정이 받지 않고 저장 탭에도 카드가 없다.
 * 서버 부품(상세 머리)이 정해 단추에는 결과만 넘긴다 — 그래서 브라우저 부품 파일(SaveButton.tsx) 밖에 둔다.
 */
export function savableProduct(product: { status: string; category: string | null }, unclaimed: boolean): boolean {
  return (product.status === "verified" || product.status === "seeded") && !(hiddenByDefault(product.category) && unclaimed);
}
