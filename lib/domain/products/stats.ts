import { gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, clickEvents, type ProductStatus } from "@/lib/db/schema";

/**
 * 목록 위에 얹는 숫자들.
 *
 * 이 사이트가 무엇인지를 문장보다 빨리 말한다 — 몇 개를 모았고, 얼마나 늘고 있고,
 * 사람들이 실제로 누르고 있는지.
 *
 * 세지 않는 것이 있다. 목업에는 메이커 수가 있었지만 우리가 아는 메이커는 스스로 신고한
 * 소수뿐이라(지금 1명) 숫자가 사실을 왜곡한다. 대신 우리가 직접 확인한 제품 수를 센다 —
 * 그것이 이 사이트가 내세우는 것이다.
 */

const LISTED: ProductStatus[] = ["verified", "seeded"];

export type MarketStats = {
  /** 공개 목록에 있는 제품 */
  products: number;
  /** 최근 7일에 새로 오른 것 */
  newThisWeek: number;
  /** 최근 24시간 아웃바운드 클릭 */
  clicks24h: number;
  /** 도메인 소유권까지 확인한 것 */
  verified: number;
};

/** 등재 시각 — 검증된 제품은 검증 시점, 우리가 올린 제품은 등록 시점 */
const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;

export async function marketStats(): Promise<MarketStats> {
  const [counts] = await db
    .select({
      products: sql<number>`count(*)::int`,
      newThisWeek: sql<number>`count(*) filter (where ${listedAt} >= now() - interval '7 days')::int`,
      verified: sql<number>`count(*) filter (where ${products.status} = 'verified')::int`,
    })
    .from(products)
    .where(inArray(products.status, LISTED));

  const [clicks] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clickEvents)
    .where(gte(clickEvents.occurredAt, sql`now() - interval '24 hours'`));

  return {
    products: counts?.products ?? 0,
    newThisWeek: counts?.newThisWeek ?? 0,
    clicks24h: clicks?.count ?? 0,
    verified: counts?.verified ?? 0,
  };
}
