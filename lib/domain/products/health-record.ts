import { sql } from "drizzle-orm";
import { productHealth, productHealthDaily } from "@/lib/db/schema";
import type { ProductTransaction } from "./generation";

/** 내부 write primitive: caller가 현재 제품/정책/권한을 먼저 검증해야 한다. */
export async function writeHealthResult(tx: ProductTransaction, input: {
  slug: string; status: number; latencyMs: number | null; observedAt: Date; resetStreak: boolean;
}): Promise<void> {
  const { slug, status, latencyMs, observedAt, resetStreak } = input;
  const alive = status >= 200 && status < 400;
  const successfulLatency = alive && latencyMs !== null
    ? Math.max(0, Math.min(2_147_483_647, Math.round(latencyMs))) : null;
  const day = new Date(observedAt.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
          failures: alive ? sql`0` : resetStreak ? sql`1` : sql`${productHealth.failures} + 1`,
          // 죽기 시작한 시각은 처음 실패한 때로 둔다 — 매번 갱신하면 얼마나 죽어 있었는지 잃는다
          downSince: alive
            ? sql`null`
            : resetStreak ? observedAt : sql`coalesce(${productHealth.downSince}, ${observedAt.toISOString()}::timestamp)`,
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

}
