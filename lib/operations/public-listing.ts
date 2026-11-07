import "server-only";
import { sharedStore } from "@/lib/cache/shared";
import { publicListingCounts, type PublicListingCounts } from "@/lib/domain/products/repository";
import { sharedLoader } from "./shared-cache";

/**
 * 공개 상태·목록 노출 수(어드민) — 공개 제품 전체를 한 번 훑으므로 흐름 화면(conveyor)과 같은 15초를 웹 여러 대가 나눠 쓴다.
 * 흐름·제품·카테고리 화면이 이 하나를 부른다. 공개 화면은 부르지 않는다(공개 「공개 N개」는 categoryCounts 가 따로 센다).
 */
const listingCache = sharedLoader<PublicListingCounts>({ namespace: "admin:public-listing", ttlMs: 15_000, store: sharedStore });

export function readPublicListing(fresh = false): Promise<PublicListingCounts> {
  return listingCache("v1", () => publicListingCounts(), fresh);
}
