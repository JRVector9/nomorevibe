import type { PublicListingCounts } from "@/lib/domain/products/repository";

export type { PublicListingCounts };

/**
 * 목록에서 빠진 사유 — publicListingCounts 가 이 차례대로 앞 사유 하나에만 센다(겹치면 앞의 것).
 * 흐름·제품·카테고리 화면이 같은 글자를 쓴다.
 */
export const LISTING_EXCLUSIONS = [
  { key: "profileUnclaimed", label: "주인 없는 개인 프로필" },
  { key: "down", label: "응답 없음" },
  { key: "auditHeld", label: "감사 보류" },
  { key: "repoGone", label: "저장소 사라짐" },
] as const satisfies readonly { key: keyof PublicListingCounts["excluded"]; label: string }[];

/** 개인 프로필이 목록에 없는 까닭 — 지운 것이 아니다(listedByDefault, 2026-10-09 운영자 결정 D2) */
export const PROFILE_NOTE = "개인 프로필은 상세 주소만 열리고 목록·검색·sitemap 에는 없다(2026-10-09 결정)";
export const LISTING_NOTE = `${PROFILE_NOTE}. 한 제품이 여러 사유에 걸리면 앞의 사유(개인 프로필 → 응답 없음 → 감사 보류 → 저장소 사라짐) 하나로 센다.`;

const n = (value: number) => value.toLocaleString("ko-KR");

/** "주인 없는 개인 프로필 8,108 · 응답 없음 751" — 0 인 사유는 뺀다. 빠진 것이 없으면 null */
export function listingExclusionText(listing: Pick<PublicListingCounts, "excluded"> | null | undefined): string | null {
  if (!listing) return null;
  const parts = LISTING_EXCLUSIONS.filter(({ key }) => listing.excluded[key] > 0).map(({ key, label }) => `${label} ${n(listing.excluded[key])}`);
  return parts.length ? parts.join(" · ") : null;
}
