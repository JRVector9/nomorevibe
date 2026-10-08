import { and, inArray, not, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { repoGone } from "./repository";

/** 저장소 사라짐 판정까지 기다리는 시간 — repository.ts repoGone 의 interval '24 hours' 와 같다 */
export const REPO_GONE_WAIT_MS = 24 * 3_600_000;

/**
 * 저장소가 지금 없거나 비었지만 아직 24시간이 지나지 않아 '저장소 사라짐'(repoGone)에 들지 않은 공개 제품
 * (2026-10-08 UX 감사 ADM-33). 운영센터 저장소 카드의 '없음'은 이것까지 세므로, 빈 거르기가 어긋나 보이지 않게
 * 몇 건이 언제부터 나타나는지 알려 준다.
 *
 * firstAt 은 가장 먼저 없어진 것의 시작 + 24시간이다. 실제로는 그 뒤 첫 하루 확인(product-stars-refresh)에서 판정되므로
 * 그 시각부터 나타난다.
 */
export async function repoGonePending(): Promise<{ count: number; firstAt: Date | null }> {
  const [row] = await db.select({
    count: sql<number>`count(*)::int`,
    since: sql<Date | null>`min(${products.repoMissingSince})`.mapWith(products.repoMissingSince),
  }).from(products).where(and(
    inArray(products.status, ["seeded", "verified"]),
    inArray(products.repoStatus, ["not_found", "empty"]),
    not(repoGone),
  ));
  return { count: row?.count ?? 0, firstAt: row?.since ? new Date(row.since.getTime() + REPO_GONE_WAIT_MS) : null };
}
