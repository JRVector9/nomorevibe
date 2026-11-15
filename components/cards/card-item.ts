import { compactCardItem, type CompactCardItem } from "@/components/home/compact-item";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import type { CardProduct } from "./markup";
import type { Locale } from "@/lib/i18n/locales";

/**
 * 브라우저가 API 로 받아 그리는 카드 값(2026-11-14 공개 HTML 줄이기) — 작은 카드 칸(compact-item.ts)에 운영 주체 표기만 더한다.
 * 저장소 주소·메이커 이름은 넘기지 않고 서버가 정한 '@소유자'와 프로필 주소만 넘긴다(카드가 그리는 값).
 */
export type CardItem = CompactCardItem & {
  owner: { login: string; profileUrl: string } | null;
  /** 메이커가 직접 밝힌 만든 도구(카드 줄 '@소유자 · Claude Code') — 밝힌 것(reported)일 때만 싣는다. 추정값은 카드도 그리지 않는다 */
  builder?: string; builderClaim?: "reported";
};

/** 목록 행(ProductListItem)·많이 쓰이는 행(PopularProduct)·급상승 행 어느 것이든 — 카드가 읽는 칸만 꺼낸다 */
type Source = CardProduct & { starGrowth?: StarGrowthItem["starGrowth"] };

export function cardItem(item: Source, locale: Locale): CardItem {
  const owner = listedRepositoryOwner(item.repoUrl ?? null, item.repoRenamedTo);
  const card: CardItem = { ...compactCardItem(item as unknown as ProductListItem, locale), owner: owner ? { login: owner.login, profileUrl: owner.profileUrl } : null };
  // 서버 HTML 카드(ProjectCardMarkup)와 같은 줄을 그리게 — API 로 채운 카드에서 만든 도구가 빠지지 않게(PR #964 검토)
  if (item.builder && item.builderClaim === "reported") Object.assign(card, { builder: item.builder, builderClaim: "reported" as const });
  return card;
}
