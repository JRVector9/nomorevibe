import { CATEGORIES, type Category } from "@/lib/domain/products/categories";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import { FOLLOW_TARGETS, type FollowTarget } from "./contract";

/** 팔로 열쇠의 모양 — 화면·API·워커(알림 만들기)가 함께 쓴다. 워커가 읽으므로 server-only 를 붙이지 않는다 */
export type FollowKey = { targetType: FollowTarget; targetKey: string };

/** 한 계정이 팔로할 수 있는 수 — 프로젝트·메이커·분야를 합쳐서 */
export const FOLLOW_LIMIT = 500;

/**
 * 메이커 열쇠는 GitHub 주인의 소문자 login 이다. 숫자 id 는 수집한 원본(crawl_documents.repo_meta.owner.id)에만 있고
 * 메이커가 직접 올린 제품에는 없어 한 열쇠로 묶을 수 없다 — 주인이 이름을 바꾸면 팔로가 이어지지 않는다.
 */
const MAKER_KEY = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const PRODUCT_KEY = /^[1-9][0-9]{0,9}$/;

/** 분야 열쇠 — 주소(/c/design)와 같은 소문자 slug */
export function categoryKey(category: Category): string {
  return category.toLowerCase();
}

export function categoryOfKey(key: string): Category | null {
  return CATEGORIES.find((category) => categoryKey(category) === key) ?? null;
}

/** 모양만 본다 — 실제로 있는지는 lib/me/follows.ts 가 DB 에서 본다 */
export function parseFollowKey(value: unknown): FollowKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { targetType, targetKey } = value as Record<string, unknown>;
  if (typeof targetType !== "string" || !(FOLLOW_TARGETS as readonly string[]).includes(targetType) || typeof targetKey !== "string") return null;
  const type = targetType as FollowTarget;
  const valid = type === "product" ? PRODUCT_KEY.test(targetKey) && Number(targetKey) <= 2_147_483_647
    : type === "maker" ? MAKER_KEY.test(targetKey) : categoryOfKey(targetKey) !== null;
  return valid ? { targetType: type, targetKey } : null;
}

/** GitHub login → 메이커 열쇠. 열쇠로 쓸 수 없는 이름이면 null */
export function makerKey(login: string | null | undefined): string | null {
  const key = login?.toLowerCase() ?? null;
  return key && MAKER_KEY.test(key) ? key : null;
}

/** 제품의 메이커 열쇠 — 목록 카드가 보여 주는 주인(repo_renamed_to 가 있으면 그 계정)이다 */
export function makerKeyOf(repoUrl: string | null | undefined, renamedTo?: string | null): string | null {
  return makerKey(listedRepositoryOwner(repoUrl, renamedTo)?.login);
}
