import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  productHealth,
  productHealthDaily,
  type ProductHealth,
} from "@/lib/db/schema";
import {
  findProductGenerationId,
  lockProductGeneration,
  ProductGenerationChangedError,
} from "./repository";

/**
 * 제품 생존 확인.
 *
 * 재기만 한다. 몇 번 실패했다고 목록에서 내리지 않는다 — 배포가 잠깐 흔들린 것과 서비스가
 * 끝난 것을 응답 코드만으로 가를 수 없다. 어드민이 보고 차단한다.
 */

/** 이 횟수 이상 연속 실패하면 화면에서 눈에 띄게 표시한다 */
export const DOWN_THRESHOLD = 3;

/**
 * 같은 제품을 이 시간 안에 다시 확인하지 않는다.
 *
 * 없으면 등재 제품이 한 틱 배치(15건)보다 적을 때 같은 사이트를 10분마다 두드린다 —
 * 하루 144번이다. 남의 서버를 그렇게 치면 차단당해도 할 말이 없다.
 */
export const RECHECK_AFTER_MINUTES = 6 * 60;

export type PingTarget = { id: number; slug: string; url: string };

/**
 * 다음에 확인할 제품.
 *
 * 확인한 지 오래된 것부터 가져온다. 커서를 따로 두지 않는 이유가 이것이다 — 확인 시각 자체가
 * 진행 지점이라 잡이 중간에 죽어도 다음 틱이 이어서 돈다.
 */
export async function nextToCheck(limit: number): Promise<PingTarget[]> {
  return db
    .select({ id: products.id, slug: products.slug, url: products.url })
    .from(products)
    .leftJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(
      and(
        inArray(products.status, ["verified", "seeded"]),
        // 한 번도 안 본 것과, 본 지 충분히 오래된 것만
        sql`(${productHealth.checkedAt} is null or ${productHealth.checkedAt} < now() - ${sql.raw(`interval '${RECHECK_AFTER_MINUTES} minutes'`)})`,
      ),
    )
    .orderBy(sql`${productHealth.checkedAt} asc nulls first`)
    .limit(limit);
}

/** 확인 결과 기록. 2xx·3xx면 살아 있는 것으로 본다 */
export async function recordPing(
  slug: string,
  status: number,
  latencyMs: number | null = null,
  observedAt = new Date(),
  expectedProductId?: number,
): Promise<void> {
  const alive = status >= 200 && status < 400;
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid ping timestamp");
  const successfulLatency = alive && latencyMs !== null
    ? Math.max(0, Math.min(2_147_483_647, Math.round(latencyMs)))
    : null;
  const day = new Date(observedAt.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const productId = expectedProductId ?? await findProductGenerationId(slug);
  if (productId === null) throw new ProductGenerationChangedError();

  await db.transaction(async (tx) => {
    if (!(await lockProductGeneration(tx, productId, slug))) {
      throw new ProductGenerationChangedError();
    }
    await tx
      .insert(productHealth)
      .values({
        slug,
        checkedAt: observedAt,
        status,
        latencyMs: successfulLatency,
        failures: alive ? 0 : 1,
        downSince: alive ? null : observedAt,
      })
      .onConflictDoUpdate({
        target: productHealth.slug,
        set: {
          checkedAt: observedAt,
          status,
          latencyMs: successfulLatency,
          failures: alive ? sql`0` : sql`${productHealth.failures} + 1`,
          // 죽기 시작한 시각은 처음 실패한 때로 둔다 — 매번 갱신하면 얼마나 죽어 있었는지 잃는다
          downSince: alive
            ? sql`null`
            : sql`coalesce(${productHealth.downSince}, ${observedAt.toISOString()}::timestamp)`,
        },
      });
    await tx.insert(productHealthDaily).values({
      slug,
      day,
      checks: 1,
      successes: alive ? 1 : 0,
      latencyTotalMs: successfulLatency ?? 0,
      latencySamples: successfulLatency === null ? 0 : 1,
    }).onConflictDoUpdate({
      target: [productHealthDaily.slug, productHealthDaily.day],
      set: {
        checks: sql`${productHealthDaily.checks} + 1`,
        successes: sql`${productHealthDaily.successes} + ${alive ? 1 : 0}`,
        latencyTotalMs: sql`${productHealthDaily.latencyTotalMs} + ${successfulLatency ?? 0}`,
        latencySamples: sql`${productHealthDaily.latencySamples} + ${successfulLatency === null ? 0 : 1}`,
      },
    });
  });
}

export type ProductHealthMetrics = {
  latencyMs: number | null;
  uptimePercent: number | null;
};

export async function healthMetrics(
  slugInputs: string[],
  days = 30,
  now = new Date(),
): Promise<Map<string, ProductHealthMetrics>> {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("invalid health window");
  if (!Number.isFinite(now.getTime())) throw new Error("invalid health timestamp");
  const slugs = [...new Set(slugInputs)];
  const metrics = new Map<string, ProductHealthMetrics>(slugs.map((slug) => [slug, {
    latencyMs: null,
    uptimePercent: null,
  }]));
  const cutoffInstant = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  cutoffInstant.setUTCDate(cutoffInstant.getUTCDate() - days + 1);
  const cutoffDay = cutoffInstant.toISOString().slice(0, 10);

  for (let offset = 0; offset < slugs.length; offset += 1_000) {
    const batch = slugs.slice(offset, offset + 1_000);
    const [current, daily] = await Promise.all([
      db.select({ slug: productHealth.slug, latencyMs: productHealth.latencyMs })
        .from(productHealth)
        .where(inArray(productHealth.slug, batch)),
      db.select({
        slug: productHealthDaily.slug,
        checks: sql<number>`sum(${productHealthDaily.checks})::integer`,
        successes: sql<number>`sum(${productHealthDaily.successes})::integer`,
      })
        .from(productHealthDaily)
        .where(and(
          inArray(productHealthDaily.slug, batch),
          gte(productHealthDaily.day, cutoffDay),
        ))
        .groupBy(productHealthDaily.slug),
    ]);
    for (const row of current) {
      metrics.get(row.slug)!.latencyMs = row.latencyMs;
    }
    for (const row of daily) {
      metrics.get(row.slug)!.uptimePercent = row.checks > 0
        ? Math.round((row.successes / row.checks) * 1_000) / 10
        : null;
    }
  }
  return metrics;
}

/**
 * 목록이 함께 보여줄 생존 상태.
 *
 * 죽은 링크가 아무 표시 없이 목록에 앉아 있으면 "직접 확인한 것만 보여준다"는 말이
 * 무색해진다. 확인한 사실만 옮긴다 — 몇 번 연속 실패했고 언제부터인지.
 */
export type HealthSignal = { down: boolean; since: Date | null };

export async function healthFor(slugs: string[]): Promise<Map<string, HealthSignal>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({
      slug: productHealth.slug,
      failures: productHealth.failures,
      downSince: productHealth.downSince,
    })
    .from(productHealth)
    .where(inArray(productHealth.slug, slugs));

  return new Map(
    rows.map((r) => [r.slug, { down: r.failures >= DOWN_THRESHOLD, since: r.downSince }]),
  );
}

export type DownProduct = ProductHealth & { name: string; url: string };

/** 연속으로 실패하고 있는 제품 (어드민 화면이 쓴다) */
export async function downProducts(limit = 50): Promise<DownProduct[]> {
  const rows = await db
    .select({
      slug: productHealth.slug,
      checkedAt: productHealth.checkedAt,
      status: productHealth.status,
      latencyMs: productHealth.latencyMs,
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
