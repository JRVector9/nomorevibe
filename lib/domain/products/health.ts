import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productHealth, type ProductHealth } from "@/lib/db/schema";

/**
 * 제품 생존 확인.
 *
 * 재기만 한다. 몇 번 실패했다고 목록에서 내리지 않는다 — 배포가 잠깐 흔들린 것과 서비스가
 * 끝난 것을 응답 코드만으로 가를 수 없다. 어드민이 보고 차단한다.
 */

/** 이 횟수 이상 연속 실패하면 화면에서 눈에 띄게 표시한다 */
export const DOWN_THRESHOLD = 3;

export type PingTarget = { slug: string; url: string };

/**
 * 다음에 확인할 제품.
 *
 * 확인한 지 오래된 것부터 가져온다. 커서를 따로 두지 않는 이유가 이것이다 — 확인 시각 자체가
 * 진행 지점이라 잡이 중간에 죽어도 다음 틱이 이어서 돈다.
 */
export async function nextToCheck(limit: number): Promise<PingTarget[]> {
  return db
    .select({ slug: products.slug, url: products.url })
    .from(products)
    .leftJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(inArray(products.status, ["verified", "seeded"]))
    .orderBy(sql`${productHealth.checkedAt} asc nulls first`)
    .limit(limit);
}

/** 확인 결과 기록. 2xx·3xx면 살아 있는 것으로 본다 */
export async function recordPing(slug: string, status: number): Promise<void> {
  const alive = status >= 200 && status < 400;
  const now = new Date();

  await db
    .insert(productHealth)
    .values({
      slug,
      checkedAt: now,
      status,
      failures: alive ? 0 : 1,
      downSince: alive ? null : now,
    })
    .onConflictDoUpdate({
      target: productHealth.slug,
      set: {
        checkedAt: now,
        status,
        failures: alive ? sql`0` : sql`${productHealth.failures} + 1`,
        // 죽기 시작한 시각은 처음 실패한 때로 둔다 — 매번 갱신하면 얼마나 죽어 있었는지 잃는다
        downSince: alive ? sql`null` : sql`coalesce(${productHealth.downSince}, ${now.toISOString()}::timestamp)`,
      },
    });
}

export type DownProduct = ProductHealth & { name: string; url: string };

/** 연속으로 실패하고 있는 제품 (어드민 화면이 쓴다) */
export async function downProducts(limit = 50): Promise<DownProduct[]> {
  const rows = await db
    .select({
      slug: productHealth.slug,
      checkedAt: productHealth.checkedAt,
      status: productHealth.status,
      failures: productHealth.failures,
      downSince: productHealth.downSince,
      name: products.name,
      url: products.url,
    })
    .from(productHealth)
    .innerJoin(products, eq(products.slug, productHealth.slug))
    .where(
      and(
        gte(productHealth.failures, DOWN_THRESHOLD),
        isNotNull(productHealth.downSince),
        inArray(products.status, ["verified", "seeded"]),
      ),
    )
    .orderBy(desc(productHealth.failures), asc(productHealth.downSince))
    .limit(limit);
  return rows;
}
