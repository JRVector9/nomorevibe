import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, rankingEntries, rankingSeasons } from "@/lib/db/schema";
import { notDown } from "@/lib/domain/products/repository";

/**
 * 공개 순위 표에 한 줄이라도 나오는 시즌 — 받은 열쇠 중 그런 것만 돌려준다(2026-10-08 UX 감사 UX-09, 운영자 결정 D1).
 *
 * 빈 시즌(표 머리만 있는 랭킹)은 푸터 시즌 띠·랭킹 링크·sitemap 에서 뺀다. 조건은 시즌 순위 화면(view.ts getSeasonRanking)이
 * 줄을 거르는 것과 같다 — 검증된 제품이고 닿는 것(notDown). 그래야 띠가 가리키는 화면이 비어 있지 않다.
 * 열쇠 목록으로 받는 이유: 푸터는 지금·지난 시즌 둘을, sitemap 은 시즌 전부를 한 번에 묻는다.
 */
export async function seasonKeysWithEntries(keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .selectDistinct({ key: rankingSeasons.key })
    .from(rankingEntries)
    .innerJoin(rankingSeasons, eq(rankingSeasons.id, rankingEntries.seasonId))
    .innerJoin(products, eq(products.slug, rankingEntries.slug))
    .where(and(inArray(rankingSeasons.key, [...keys]), eq(products.status, "verified"), notDown));
  return rows.map((row) => row.key);
}
