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

export type HealthResultInput = { slug: string; status: number; latencyMs: number | null; observedAt: Date; resetStreak: boolean };

/**
 * writeHealthResult 를 서로 다른 slug 여러 개에 한 번에 적용한다(문장 2개). 결과는 같은 입력을 writeHealthResult 로
 * 하나씩 적용한 것과 같다 — 연속 실패·첫 실패 시각은 SQL 이 지금 행에서 계산하고, 일일 집계는 (slug, KST 날짜)로 더한다.
 * 같은 slug 가 두 번 오면 거부한다(한 문장 안에서는 앞의 결과를 이어 셀 수 없다). caller 가 제품 세대·health 행을 먼저 잠근다.
 * 돌려주는 값은 slug 별 쓴 뒤의 연속 실패 수다.
 */
export async function writeHealthResults(tx: ProductTransaction, inputs: readonly HealthResultInput[]): Promise<Map<string, number>> {
  if (inputs.length === 0) return new Map();
  if (new Set(inputs.map(input => input.slug)).size !== inputs.length) throw new TypeError("health_results_duplicate_slug");
  const rows = inputs.map(({ slug, status, latencyMs, observedAt, resetStreak }) => {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid ping timestamp");
    const alive = status >= 200 && status < 400;
    const latency = alive && latencyMs !== null ? Math.max(0, Math.min(2_147_483_647, Math.round(latencyMs))) : null;
    return { slug, status, latency_ms: latency, alive, reset: resetStreak, observed_at: observedAt.toISOString(),
      day: new Date(observedAt.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  });
  // 한 문장 안의 두 쓰기는 같은 snapshot 을 본다: 있는 행은 UPDATE, 없는 행만 INSERT(동시 INSERT 는 caller 의 세대 잠금이 막는다)
  const written = await tx.execute<{ slug: string; failures: number }>(sql`
    with r as (select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as r(slug varchar, status integer, latency_ms integer, alive boolean, reset boolean, observed_at timestamp)),
    updated as (update ${productHealth} h set checked_at = r.observed_at, status = r.status, latency_ms = r.latency_ms,
        failures = case when r.alive then 0 when r.reset then 1 else h.failures + 1 end,
        down_since = case when r.alive then null when r.reset then r.observed_at else coalesce(h.down_since, r.observed_at) end
      from r where h.slug = r.slug returning h.slug, h.failures),
    inserted as (insert into ${productHealth} (slug, checked_at, status, latency_ms, failures, down_since)
      select r.slug, r.observed_at, r.status, r.latency_ms, case when r.alive then 0 else 1 end, case when r.alive then null else r.observed_at end
      from r where not exists (select 1 from ${productHealth} h where h.slug = r.slug) returning slug, failures)
    select slug, failures from updated union all select slug, failures from inserted`);
  if (written.length !== rows.length) throw new Error("health_results_write_mismatch");
  await tx.execute(sql`
    insert into ${productHealthDaily} (slug, day, checks, successes, latency_total_ms, latency_samples)
    select r.slug, r.day, 1, case when r.alive then 1 else 0 end, coalesce(r.latency_ms, 0), case when r.latency_ms is null then 0 else 1 end
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(slug varchar, day date, alive boolean, latency_ms integer)
    on conflict (slug, day) do update set checks = ${productHealthDaily.checks} + excluded.checks,
      successes = ${productHealthDaily.successes} + excluded.successes,
      latency_total_ms = ${productHealthDaily.latencyTotalMs} + excluded.latency_total_ms,
      latency_samples = ${productHealthDaily.latencySamples} + excluded.latency_samples`);
  return new Map(Array.from(written, row => [row.slug, Number(row.failures)]));
}
