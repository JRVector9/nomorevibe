import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, productEvidenceAudit, productHealth, products } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { lockProductGeneration } from "./generation";
import type { PingTarget } from "./health";
import { RECHECK_AFTER_MINUTES } from "./health-freshness";
import { setStatusWithAudit } from "./repository";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";

export const UPTIME_AUTO_BAN_THRESHOLD = 10;
const POLICY = "uptime_consecutive_failures";

/** Compare original DB timestamps: JS millisecond rounding must not reopen an older observation. */
function eligibleObservation() {
  return and(
    inArray(products.status, ["verified", "seeded"]),
    eq(products.accessMode, "website"),
    gte(productHealth.failures, UPTIME_AUTO_BAN_THRESHOLD),
    isNotNull(productHealth.downSince),
    sql`${productHealth.status} not between 200 and 399`,
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
    .where(eligibleObservation()).orderBy(asc(productHealth.checkedAt), asc(products.id)).limit(limit);
}

type Controls = { lease?: JobLease; signal?: AbortSignal; hasBudget?: () => boolean };

/** A real public→banned transition, both audits, and the existing CDN trigger commit together. */
export async function autoBanUptimeProduct(target: PingTarget, controls: Controls = {}): Promise<boolean> {
  if (controls.signal?.aborted) return false;
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    if (!(await lockProductGeneration(tx, target.id, target.slug))) return false;
    const [current] = await tx.select({
      previousStatus: products.status, failures: productHealth.failures, lastStatus: productHealth.status,
      checkedAt: productHealth.checkedAt, downSince: productHealth.downSince,
    }).from(products).innerJoin(productHealth, eq(productHealth.slug, products.slug))
      .where(and(eq(products.id, target.id), eq(products.slug, target.slug), eq(products.url, target.url), eligibleObservation()))
      .for("update");
    if (!current || controls.signal?.aborted || (controls.hasBudget && !controls.hasBudget())) return false;

    const metadata = {
      policy: POLICY, threshold: UPTIME_AUTO_BAN_THRESHOLD, consecutiveFailures: current.failures,
      lastStatus: current.lastStatus, checkedAt: current.checkedAt.toISOString(), downSince: current.downSince!.toISOString(),
      productId: target.id, slug: target.slug, url: target.url, previousStatus: current.previousStatus, status: "banned",
    };
    if (!(await setStatusWithAudit({ id: target.id, slug: target.slug, status: "banned", action: "admin.product.ban",
      actor: "system:uptime", reason: POLICY, metadata }, tx))) return false;
    await tx.insert(operationsAudit).values({
      actor: "system:uptime", actorKind: "token", action: "product-auto-ban-uptime", target: target.slug,
      detail: { ...metadata, reason: POLICY,
        note: `사이트 연속 접속 실패 ${current.failures}회 · 마지막 HTTP ${current.lastStatus} · 확인 ${metadata.checkedAt} · 자동 내림` },
    });
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    if (controls.lease) await assertJobLeaseAtWallTime(tx, controls.lease);
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    return true;
  });
}
