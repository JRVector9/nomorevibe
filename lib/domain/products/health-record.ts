import { sql } from "drizzle-orm";
import { productHealth, productHealthDaily } from "@/lib/db/schema";
import type { ProductTransaction } from "./generation";
import { UPTIME_AUTO_BAN_THRESHOLD } from "./health-freshness";

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

/**
 * 판정 보류 — 이 서버 쪽 광역 실패로 보고 세지 않은 확인(uptime.ts). caller가 먼저 검증하는 것은 writeHealthResult와 같다.
 * 확인은 했으므로 확인 시각만 넘겨 다른 제품처럼 6시간 뒤 차례가 오게 한다. 연속 실패·죽기 시작한 시각·마지막 응답 코드·
 * 지연·일별 집계는 그대로라 숨김·자동 내림이 이 기록으로 바뀌지 않는다. 행이 없는 새 제품은 실패 0인 행으로 만든다(응답 코드는 본 그대로).
 *
 * 연속 실패가 자동 내림 기준 이상인 행은 건드리지 않는다. 그 행의 확인 시각은 자동 내림의 최신성(6시간)·관리자 해제
 * 시각 비교 기준이라, 보류한 관측이 그 창을 다시 열면 안 된다. 그런 공개 행은 관리자가 풀어 준 경우뿐이라 드물고
 * 다음 틱이 다시 본다.
 */
export async function writeHealthHeld(tx: ProductTransaction, input: { slug: string; status: number; observedAt: Date }): Promise<void> {
  await tx.insert(productHealth)
    .values({ slug: input.slug, checkedAt: input.observedAt, status: input.status, latencyMs: null, failures: 0, downSince: null })
    .onConflictDoUpdate({ target: productHealth.slug, set: { checkedAt: input.observedAt },
      setWhere: sql`${productHealth.failures} < ${UPTIME_AUTO_BAN_THRESHOLD}` });
}

/**
 * writeHealthHeld 를 서로 다른 slug 여러 개에 한 번에 적용한다(split claims 적용기, 문장 1개). 결과는 writeHealthHeld 를 하나씩 적용한 것과 같다 —
 * 있는 행은 확인 시각만(연속 실패가 자동 내림 기준 미만일 때만), 없는 행은 실패 0 으로 만든다. caller 가 제품 세대·health 행을 먼저 잠근다.
 * 돌려주는 값은 쓴 행의 slug 별 연속 실패 수다(기준 이상이라 건드리지 않은 행은 빠진다 — caller 가 판정과 맞춰 본다).
 */
export async function writeHealthHelds(tx: ProductTransaction, inputs: readonly { slug: string; status: number; observedAt: Date }[]): Promise<Map<string, number>> {
  if (inputs.length === 0) return new Map();
  if (new Set(inputs.map(input => input.slug)).size !== inputs.length) throw new TypeError("health_results_duplicate_slug");
  const rows = inputs.map(({ slug, status, observedAt }) => {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid ping timestamp");
    return { slug, status, observed_at: observedAt.toISOString() };
  });
  const written = await tx.execute<{ slug: string; failures: number }>(sql`
    insert into ${productHealth} (slug, checked_at, status, latency_ms, failures, down_since)
    select r.slug, r.observed_at, r.status, null, 0, null
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(slug varchar, status integer, observed_at timestamp)
    on conflict (slug) do update set checked_at = excluded.checked_at where ${productHealth.failures} < ${UPTIME_AUTO_BAN_THRESHOLD}
    returning slug, failures`);
  return new Map(Array.from(written, row => [row.slug, Number(row.failures)]));
}

/**
 * 살아 있는 사이트도 봇·로그인 차단 때문에 돌려주는 응답 — 살았는지 알 수 없다(legacy recordPing·자동 내림 sweep·uptime 잡이 같은 목록을 쓴다).
 * 2026-10-19 운영: 응답 없는 공개 제품 440개 중 17개(429 8·403 5·401 3·999 1, 999는 LinkedIn 류의 비표준 코드).
 * 404·접속 실패(0)·402·5xx·그 밖의 4xx는 지금처럼 실패로 센다. raw 관측(PR09, 꺼져 있음)의 적용은 regional-v1 판정대로
 * writeHealthResult로 세지만, 마지막 응답이 이 목록이면 자동 내림 sweep이 고르지 않는 것은 같다.
 */
export const UPTIME_UNKNOWN_STATUSES = [401, 403, 429, 999] as const;

export function isUnknownUptimeStatus(status: number): boolean {
  return (UPTIME_UNKNOWN_STATUSES as readonly number[]).includes(status);
}

/**
 * 살았는지 알 수 없는 응답 — caller가 먼저 검증하는 것은 writeHealthResult와 같다. 확인 시각과 마지막 응답 코드만 남기고
 * (지연은 성공 확인에만 둔다) 연속 실패·죽기 시작한 시각은 올리지도 끊지도 않는다. 성공도 실패도 아니라 일별 가동률에도 넣지 않는다.
 * 행이 없는 새 제품은 실패 0인 행으로 만든다. 마지막 응답 코드가 이 목록이면 자동 내림 sweep이 고르지 않는다(uptime-auto-ban).
 */
export async function writeHealthUnknown(tx: ProductTransaction, input: { slug: string; status: number; observedAt: Date }): Promise<void> {
  await tx.insert(productHealth)
    .values({ slug: input.slug, checkedAt: input.observedAt, status: input.status, latencyMs: null, failures: 0, downSince: null })
    .onConflictDoUpdate({ target: productHealth.slug, set: { checkedAt: input.observedAt, status: input.status, latencyMs: null } });
}
