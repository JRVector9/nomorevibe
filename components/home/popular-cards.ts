import type { HomeCardProduct } from "@/components/home/types";
import type { PopularProduct } from "@/lib/domain/products/popular";

/** 순위 카드 한 장 — 카드(ProjectCard)가 받는 모양에 자리를 붙인 것 */
export type RankedCardProduct = HomeCardProduct & { rank: number; ownerType?: PopularProduct["ownerType"] };

/**
 * 많이 쓰이는 프로젝트(popular.ts)의 행을 홈 카드 모양으로 — 홈 구간·/popular 카드 보기가 발견하기 카드와 같은 부품을 쓴다.
 * 제작 도구는 메이커가 신고한 것만 카드에 붙는데(ProjectCard) 이 목록은 그 값을 읽지 않으므로 비워 둔다.
 */
export function rankedCard(product: PopularProduct, rank: number): RankedCardProduct {
  return { ...product, rank, builder: null, builderClaim: "guessed", unclaimed: false };
}
