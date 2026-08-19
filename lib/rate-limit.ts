import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";

/**
 * rate limit — 인스턴스가 늘어도 한도가 하나로 유지되도록 DB에 둔다.
 *
 * 인메모리로 두면 인스턴스마다 버킷이 따로 생겨 2대로 늘리는 순간 실제 한도가 2배가 된다.
 * Redis를 들이는 대신 이미 있는 Postgres를 쓴다 — 한도를 거는 세 경로(등록·검증·수정)는
 * 어차피 그 요청 안에서 DB를 타므로 왕복이 늘지 않는다.
 */

/** 창 갱신과 증가를 한 문장에서 처리한다. 읽고 쓰기를 나누면 동시 요청이 한도를 넘긴다 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const window = sql.raw(`interval '${Math.max(1, Math.round(windowMs / 1000))} seconds'`);

  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt: sql`now() + ${window}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // 창이 지났으면 1부터 다시 센다
        count: sql`case when ${rateLimits.resetAt} < now() then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} < now() then now() + ${window} else ${rateLimits.resetAt} end`,
      },
    })
    .returning({ count: rateLimits.count });

  await sweepOccasionally();
  return (row?.count ?? 1) <= limit;
}

/**
 * 지난 창의 행 청소.
 *
 * 행은 키마다 하나씩 갱신되므로 요청 수만큼 늘지는 않지만, 지나간 클라이언트의 행은
 * 계속 남는다. 별도 작업을 만들 만한 일이 아니라서 아주 가끔 같이 지운다.
 */
async function sweepOccasionally() {
  if (Math.random() > 0.01) return;
  await db.delete(rateLimits).where(sql`${rateLimits.resetAt} < now() - interval '1 day'`);
}

/**
 * 클라이언트 IP 추출.
 *
 * X-Forwarded-For는 신뢰 프록시가 실제 피어를 오른쪽에 덧붙이는 구조라, 신뢰 hop 수를 알아야
 * 올바른 항목을 고를 수 있다. TRUSTED_PROXY_HOPS로 명시한다.
 *  - 0(기본): 프록시 없음 → 헤더를 아예 신뢰하지 않는다 (스푸핑으로 버킷 회전 불가)
 *  - 1: 앞단 프록시 1개 (Traefik 단독 등) → 마지막 항목
 *  - 2: CDN + 프록시 (Cloudflare + Traefik 등) → 뒤에서 두 번째 항목
 * 헤더 항목 수가 부족하면 가장 왼쪽 값을 쓴다(체인이 예상보다 짧은 경우).
 */
export function clientIp(req: Request): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  if (!Number.isFinite(hops) || hops < 1) return "direct";

  const fwd = req.headers.get("x-forwarded-for");
  if (!fwd) return "direct";
  const parts = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "direct";

  const index = parts.length - hops;
  return parts[Math.max(0, index)];
}

/** 신뢰 프록시가 없으면 모든 사용자를 하나의 `direct` 버킷으로 합치지 않는다. */
export function trustedClientIp(req: Request): string | null {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  if (!Number.isFinite(hops) || hops < 1) return null;
  const value = clientIp(req);
  return value === "direct" ? null : value;
}
