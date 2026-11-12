import type { Locale } from "@/lib/i18n/locales";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";

/**
 * 가로 띠의 작은 카드(CompactCard)가 읽는 칸만 — 홈 '지금 뜨는'·'새로 나온', 상세 '같은 분야', 없는 주소의 '지금 뜨는'.
 *
 * 카드 속성은 HTML 안 RSC 데이터에 한 번 더 실린다(2026-11-11 상세 HTML 줄이기). 목록 행 전체(빌더·스택·저장소 주소·활동·생존 확인…)를
 * 넘기면 카드마다 보이지 않는 칸이 수백 바이트씩 붙었다.
 */
export type CompactCardItem = Pick<ProductListItem,
  | "slug" | "name" | "tagline" | "taglineSource" | "taglineKo" | "translation" | "category" | "accessMode" | "ogImage" | "aiLevel"
  | "listedAt" | "repoCreatedAt" | "stars" | "starsAt" | "starsPrevious" | "starsPreviousAt"> & {
  starGrowth?: StarGrowthItem["starGrowth"];
};

type CardSource = ProductListItem & { starGrowth?: StarGrowthItem["starGrowth"] };

/**
 * 같은 목록 행에서는 같은 카드 객체를 돌려준다 — RSC 는 같은 객체를 한 번만 싣고 나머지는 참조로 쓴다.
 * 없는 주소 화면(app/not-found.tsx)은 공개 화면마다 두 경계로 두 번 그려지는데, 매번 새 객체면 카드가 두 번 실렸다.
 * 목록 행은 짧은 읽기 캐시(publicRead·memo)가 같은 객체로 돌려주므로 열쇠로 쓸 수 있고, 캐시가 놓으면 함께 사라진다.
 */
const cards = new WeakMap<CardSource, Partial<Record<Locale, CompactCardItem>>>();

export function compactCardItem(item: CardSource, locale: Locale): CompactCardItem {
  const cached = cards.get(item)?.[locale];
  if (cached) return cached;
  const card: CompactCardItem = {
    slug: item.slug, name: item.name, tagline: item.tagline, taglineSource: item.taglineSource, category: item.category,
    accessMode: item.accessMode, ogImage: item.ogImage, aiLevel: item.aiLevel, listedAt: item.listedAt,
  };
  // 8시간 증가가 있으면 카드는 그것만 그린다(StarGrowthMetric) — 없을 때만 스타 관측 넷(StarMetric)
  if (item.starGrowth) card.starGrowth = item.starGrowth;
  else Object.assign(card, { stars: item.stars, starsAt: item.starsAt, starsPrevious: item.starsPrevious, starsPreviousAt: item.starsPreviousAt });
  // ProductTagline 은 한국어 화면에서만 taglineKo 를 읽는다
  if (locale === "ko") card.taglineKo = item.taglineKo;
  if (item.translation) card.translation = item.translation;
  if (item.repoCreatedAt) card.repoCreatedAt = item.repoCreatedAt;
  cards.set(item, { ...cards.get(item), [locale]: card });
  return card;
}
