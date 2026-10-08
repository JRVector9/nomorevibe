import type { ListOptions } from "@/lib/domain/products/repository";
import type { ProductStatus } from "@/lib/db/schema";

/**
 * 제품 관리의 거르기 — 어드민이 실제로 묻는 질문에 맞춘다.
 *
 * page.tsx 는 Next 가 정한 것만 내보낼 수 있어 따로 둔다. 운영센터의 링크 검사(admin-status-action-links)가
 * 이 이름들을 읽어 "조치할 일"이 없는 거르기로 보내지 않는지 본다.
 */
export type ProductFilter = { statuses: ProductStatus[] } & Pick<ListOptions, "introNeedsEditor" | "repoGone" | "repoArchived" | "repoRenamed" | "down">;

export const PRODUCT_FILTERS = {
  전체: { statuses: ["verified", "seeded", "unverified", "banned"] },
  검증됨: { statuses: ["verified"] },
  미클레임: { statuses: ["seeded"] },
  "검증 대기": { statuses: ["unverified"] },
  차단됨: { statuses: ["banned"] },
  /**
   * 연속 실패로 공개 목록에서 빠진 것(health.ts downProducts 와 같은 식) — 지우거나 차단하지 않는다.
   * 끝난 서비스인지 사람이 보고 정한다
   */
  "응답 없음": { statuses: ["seeded", "verified"], down: true },
  /** 소개 검수가 근거로는 무엇인지 알 수 없다고 한 것 — 페이지를 열어 보고 내릴지 정한다 */
  "소개 확인 필요": { statuses: ["seeded", "verified"], introNeedsEditor: true },
  /**
   * GitHub 저장소가 없거나 빈 채로 하루 넘게 이어진 공개 제품(repository.ts repoGone) — 설치형은 이미 목록에서 가려졌고
   * 웹사이트는 목록에 두고 GitHub 표시만 뺐다. 웹사이트는 AI 가 사이트를 다시 본 판정(product-repo-review)을 붙이고
   * 사람이 유지·내리기를 고른다
   */
  "저장소 사라짐": { statuses: ["seeded", "verified"], repoGone: true },
  /** GitHub 이 보관(archived)이라고 한 저장소 — 다루는 방법을 아직 정하지 않아 기록만 한다 */
  "저장소 보관됨": { statuses: ["seeded", "verified"], repoArchived: true },
  /** GitHub 이 다른 이름으로 돌려준 저장소 — repo_url 은 아직 옛 이름이다(고쳐 쓰기는 뒤에 따로) */
  "저장소 이름 바뀜": { statuses: ["seeded", "verified"], repoRenamed: true },
} satisfies Record<string, ProductFilter>;
export type ProductFilterName = keyof typeof PRODUCT_FILTERS;

/** 정렬(?sort=) — 기본은 최신순. 목록의 정렬(repository SORTS) 가운데 어드민에 뜻이 있는 것만 */
export const PRODUCT_SORTS = { recent: "최신순", stars: "스타순" } as const;
export type ProductAdminSort = keyof typeof PRODUCT_SORTS;
