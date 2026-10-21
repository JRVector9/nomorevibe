import { sql } from "drizzle-orm";
import { products } from "@/lib/db/schema";

/**
 * 제품 저장소 주인 열쇠의 SQL — 등록한 주소의 계정과 옮겨 간 계정(repo_renamed_to). 상세·목록이 보여 주는 주인은 둘 중 하나다.
 * 두 식은 0108 의 색인(products_listed_owner_idx·products_renamed_owner_idx)과 글자까지 같아야 색인을 탄다 — 아니면 제품 전부를 정규식으로 훑는다.
 * 팔로(follows.ts)·내 저장소 찾기(maker.ts)·주소로 찾기(maker-claims.ts)가 이 한 벌을 쓴다. 워커도 읽으므로 server-only 를 붙이지 않는다
 */
export const listedOwnerSql = sql<string | null>`substring(lower(${products.repoUrl}) from '^https?://(?:www\\.)?github\\.com/([a-z0-9-]+)/[^/]+/?$')`;
export const renamedOwnerSql = sql<string | null>`nullif(lower(split_part(${products.repoRenamedTo}, '/', 1)), '')`;

/** 열쇠 중 하나가 주인인 제품 — 옮겨 간 계정 쪽은 부분 색인(repo_renamed_to is not null)이라 그 조건을 함께 적는다 */
export function ownedBySql(keys: string[]) {
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  return sql`(${listedOwnerSql} in (${list}) or (${products.repoRenamedTo} is not null and ${renamedOwnerSql} in (${list})))`;
}
