import { isIP } from "node:net";
import { and, eq, gt, gte, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, rateLimits } from "@/lib/db/schema";
import { crawlBurstKey, type CrawlBurstSettings } from "@/lib/http/crawl-burst-policy";
import { RATE_LIMIT_BLOCKED_COUNT } from "@/lib/rate-limit";
import { adminAuditRow } from "./admin-log";
import { readRuntimeSettingsRow, saveRuntimeSettings } from "./runtime-settings";
import { resolveRuntimeSettings } from "./runtime-settings-schema";

/**
 * 과다 호출 차단(lib/http/crawl-burst.ts)의 운영 동작 — scripts/crawl-burst.ts 가 부른다.
 * 자동 차단·풀림은 웹이 rate_limits 한 행으로 하고 서버 로그 `anti_scrape.burst_blocked` 를 남긴다. 여기는 운영자의 읽기·설정·수동 해제다.
 */
export const CRAWL_BURST_RELEASE_ACTION = "crawl-burst-release";

/** 지금 설정과 지금 막힌 IP 수·창 안에서 세는 IP 수(읽기 전용) */
export async function crawlBurstStatus(): Promise<{ settings: CrawlBurstSettings; revision: number; blockedNow: number; countingNow: number }> {
  const row = await readRuntimeSettingsRow();
  const { burstLimit, burstWindowSeconds, burstBlockSeconds } = resolveRuntimeSettings(row.values).settings.publicApi;
  const burstRows = and(like(rateLimits.key, "burst:%"), gt(rateLimits.resetAt, sql`now()`));
  const [blocked] = await db.select({ n: sql<number>`count(*)::int` }).from(rateLimits).where(and(burstRows, gte(rateLimits.count, RATE_LIMIT_BLOCKED_COUNT)));
  const [counting] = await db.select({ n: sql<number>`count(*)::int` }).from(rateLimits).where(and(burstRows, sql`${rateLimits.count} < ${RATE_LIMIT_BLOCKED_COUNT}`));
  return { settings: { burstLimit, burstWindowSeconds, burstBlockSeconds }, revision: row.revision, blockedNow: blocked?.n ?? 0, countingNow: counting?.n ?? 0 };
}

/** runtime_settings publicApi.burst* 저장 — 검증·revision·operations_audit(runtime-settings-save)는 saveRuntimeSettings 그대로 */
export async function saveCrawlBurstSettings(patch: Partial<CrawlBurstSettings>, actor: string) {
  const row = await readRuntimeSettingsRow();
  return saveRuntimeSettings({ publicApi: patch }, actor, { group: "publicApi", expectedRevision: row.revision });
}

/** 방문자 주소를 감사 줄에 그대로 남기지 않는다 — 운영자가 넣은 값과 맞춰 볼 수 있게 끝만 가린다 */
export function maskIp(ip: string): string {
  return ip.includes(":") ? `${ip.split(":").slice(0, 3).join(":")}:…` : ip.replace(/\.\d+$/, ".x");
}

/** 그 IP 의 차단(과 세던 창)을 바로 지운다 + operations_audit `crawl-burst-release` 한 줄 — 한 트랜잭션 */
export async function releaseCrawlBurst(ip: string, actor: string): Promise<{ released: boolean; target: string; auditId: number }> {
  if (isIP(ip) === 0) throw new Error("ip_required");
  if (!actor.trim()) throw new Error("actor_required");
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(rateLimits).where(eq(rateLimits.key, crawlBurstKey(ip)))
      .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
    const released = deleted.some((row) => row.count >= RATE_LIMIT_BLOCKED_COUNT && row.resetAt.getTime() > Date.now());
    const target = `crawl_burst:${maskIp(ip)}`;
    const [audit] = await tx.insert(operationsAudit).values(await adminAuditRow(actor, {
      action: CRAWL_BURST_RELEASE_ACTION, target, detail: { released, releasedAt: new Date().toISOString() },
    }, "token")).returning({ id: operationsAudit.id });
    return { released, target, auditId: audit.id };
  });
}
