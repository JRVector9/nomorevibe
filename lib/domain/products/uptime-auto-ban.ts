import { and, asc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, productEvidenceAudit, productHealth, products } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { lockProductGeneration } from "./generation";
import type { PingTarget } from "./health";
import { uptimeControl } from "@/lib/db/product-uptime-schema";
import { uptimeNegativeAllowed } from "./uptime-negative-gate";
import { RECHECK_AFTER_MINUTES, UPTIME_AUTO_BAN_THRESHOLD } from "./health-freshness";
import { UPTIME_UNKNOWN_STATUSES } from "./health-record";
import { setStatusWithAudit } from "./repository";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { enqueueUptimeAssist, readAssistControl, uptimeAssistObservationUnhandled } from "@/lib/domain/llm-assist/repository";

// 보류 기록(health-record)이 같은 경계를 보는데 health → repository 순환을 피하려고 잎 모듈에 둔다
export { UPTIME_AUTO_BAN_THRESHOLD } from "./health-freshness";
const POLICY = "uptime_consecutive_failures";

/** Compare original DB timestamps: JS millisecond rounding must not reopen an older observation. */
export function eligibleUptimeAutoBanObservation() {
  return and(
    inArray(products.status, ["verified", "seeded"]),
    eq(products.accessMode, "website"),
    gte(productHealth.failures, UPTIME_AUTO_BAN_THRESHOLD),
    uptimeNegativeAllowed({ id: products.id, url: products.url, updatedAt: products.updatedAt,
      checkedAt: productHealth.checkedAt, failures: productHealth.failures, status: productHealth.status }),
    isNotNull(productHealth.downSince),
    sql`${productHealth.status} not between 200 and 399`,
    // 봇·로그인 차단 응답(401·403·429·999)은 살았는지 알 수 없다 — 마지막 관측이 그것이면 내리지 않는다
    notInArray(productHealth.status, [...UPTIME_UNKNOWN_STATUSES]),
    sql`${productHealth.checkedAt} between now() - ${RECHECK_AFTER_MINUTES} * interval '1 minute' and now()`,
    sql`${productHealth.downSince} <= ${productHealth.checkedAt}`,
    // Historical health has no URL column. A newer product change requires a normal recheck first.
    sql`${products.updatedAt} <= ${productHealth.checkedAt}`,
    sql`${products.updatedAt} <= ${productHealth.downSince}`,
    sql`not exists (select 1 from ${productEvidenceAudit} unban
      where unban.slug = ${products.slug} and unban.action = 'admin.product.unban'
        and unban.created_at >= ${productHealth.checkedAt})`,
  );
}

/** Existing fresh backlog shares the normal uptime batch; this never opens an extra HTTP request. */
export async function nextUptimeAutoBanTargets(limit: number): Promise<PingTarget[]> {
  if (limit === 0) return [];
  if (!Number.isInteger(limit) || limit < 0 || limit > 200) throw new Error("invalid uptime batch");
  return db.select({ id: products.id, slug: products.slug, url: products.url })
    .from(products).innerJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(and(eligibleUptimeAutoBanObservation(), uptimeAssistObservationUnhandled({ id: products.id, url: products.url,
      updatedAt: products.updatedAt, checkedAt: productHealth.checkedAt, failures: productHealth.failures, status: productHealth.status })))
    .orderBy(asc(productHealth.checkedAt), asc(products.id)).limit(limit);
}

type Controls = { lease?: JobLease; signal?: AbortSignal; hasBudget?: () => boolean };

/** A real public→banned transition, both audits, and the existing CDN trigger commit together. */
export async function autoBanUptimeProduct(target: PingTarget, controls: Controls = {}): Promise<boolean> {
  if (controls.signal?.aborted) return false;
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    await tx.select().from(uptimeControl).where(eq(uptimeControl.id, 1)).for("share");
    if (!(await lockProductGeneration(tx, target.id, target.slug))) return false;
    const [current] = await tx.select({
      productUpdatedAt: sql<string>`${products.updatedAt}::text`, previousStatus: products.status, failures: productHealth.failures, lastStatus: productHealth.status,
      checkedAt: productHealth.checkedAt, downSince: productHealth.downSince,
      checkedAtRevision: sql<string>`${productHealth.checkedAt}::text`, downSinceRevision: sql<string>`${productHealth.downSince}::text`,
    }).from(products).innerJoin(productHealth, eq(productHealth.slug, products.slug))
      .where(and(eq(products.id, target.id), eq(products.slug, target.slug), eq(products.url, target.url), eligibleUptimeAutoBanObservation()))
      .for("update");
    if (!current || controls.signal?.aborted || (controls.hasBudget && !controls.hasBudget())) return false;

    const candidate = { kind: "uptime" as const,
      product: { id: target.id, slug: target.slug, url: target.url, updatedAt: current.productUpdatedAt }, health: { failures: current.failures, status: current.lastStatus!,
        checkedAt: current.checkedAtRevision, downSince: current.downSinceRevision } };
    const assist = await readAssistControl("uptime", tx, { required: true });
    if (assist.confirmationRequired) {
      await enqueueUptimeAssist(tx, candidate, controls.lease?.name ?? "uptime-ping");
      if (controls.lease) await assertJobLeaseAtWallTime(tx, controls.lease);
      if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
      return false;
    }

    const metadata = {
      policy: POLICY, threshold: UPTIME_AUTO_BAN_THRESHOLD, consecutiveFailures: current.failures,
      lastStatus: current.lastStatus, checkedAt: current.checkedAt.toISOString(), downSince: current.downSince!.toISOString(),
      productId: target.id, slug: target.slug, url: target.url, previousStatus: current.previousStatus, status: "banned",
      observedProductUpdatedAt: current.productUpdatedAt, checkedAtRevision: current.checkedAtRevision, downSinceRevision: current.downSinceRevision,
    };
    if (!(await setStatusWithAudit({ id: target.id, slug: target.slug, status: "banned", action: "admin.product.ban",
      actor: "system:uptime", reason: POLICY, metadata }, tx))) return false;
    const [banned] = await tx.select({ updatedAt: sql<string>`${products.updatedAt}::text` }).from(products).where(eq(products.id, target.id));
    const [audit] = await tx.insert(operationsAudit).values({
      actor: "system:uptime", actorKind: "token", action: "product-auto-ban-uptime", target: target.slug,
      detail: { ...metadata, bannedProductUpdatedAt: banned.updatedAt, reason: POLICY,
        note: `사이트 연속 접속 실패 ${current.failures}회 · 마지막 HTTP ${current.lastStatus} · 확인 ${metadata.checkedAt} · 자동 내림` },
    }).returning({ id: operationsAudit.id });
    if (assist.mode === "shadow") await enqueueUptimeAssist(tx, { ...candidate,
      product: { ...candidate.product, updatedAt: banned.updatedAt },
      shadowBan: { auditId: audit.id, observedProductUpdatedAt: current.productUpdatedAt },
    }, controls.lease?.name ?? "uptime-ping");
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    if (controls.lease) await assertJobLeaseAtWallTime(tx, controls.lease);
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    const [final] = await tx.select({ allowed: uptimeNegativeAllowed({ id: sql`${target.id}`, url: sql`${target.url}`,
      updatedAt: sql`${current.productUpdatedAt}::timestamp`, checkedAt: sql`product_health.checked_at`,
      failures: sql`product_health.failures`, status: sql`product_health.status` }) })
      .from(productHealth).where(eq(productHealth.slug, target.slug));
    if (!final?.allowed) throw new Error("uptime_observation_hold");
    if (controls.lease) await assertJobLeaseAtWallTime(tx, controls.lease);
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    return true;
  });
}
