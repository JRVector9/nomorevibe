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
