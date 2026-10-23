import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { llmAssistWorks, productHealth, products } from "@/lib/db/schema";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { lockProductGeneration, type ProductTransaction } from "@/lib/domain/products/generation";
import { uptimeNegativeAllowed } from "@/lib/domain/products/uptime-negative-gate";
import { UPTIME_AUTO_BAN_THRESHOLD } from "@/lib/domain/products/health-freshness";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import type { LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";
import { assistCapacityInput, type AssistCapacityInput } from "./model-input";
import { assistOriginActive, readAssistControl } from "./repository";
import { uptimeCandidateSchema } from "./work";

/** 예약→dispatch와 같은 TX에서 대상·근거·pause·lease를 증명하고 request ID를 원자 연결한다. */
export async function proveAssistModelDomain(tx: ProductTransaction, target: Extract<LocalModelTarget, { kind: "assist" }>,
  value: AssistCapacityInput, job: JobLease, role: RoleLease, requestId: string): Promise<boolean> {
  const [initial] = await tx.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, target.workId));
  if (!initial || initial.task !== "uptime") return false;
  const candidate = uptimeCandidateSchema.parse(initial.source);
  await lockPipelineInputStages(tx);
  if (!await lockProductGeneration(tx, candidate.product.id, candidate.product.slug)) return false;
  const [work] = await tx.select().from(llmAssistWorks).where(and(eq(llmAssistWorks.id, target.workId),
    eq(llmAssistWorks.revision, target.workRevision), eq(llmAssistWorks.claimToken, target.claimToken),
    eq(llmAssistWorks.state, "claimed"))).for("update");
  if (!work || work.task !== target.task || work.productId !== target.subjectId || work.backendId !== target.backendId
    || work.ownerInstanceId !== role.instanceId || work.ownerBootId !== role.bootId || work.claimJob !== job.name
    || work.claimJobToken !== job.token || work.claimRequestedVersion !== job.requestedVersion || work.capacityRequestId
    || !work.input || !isDeepStrictEqual(work.input, value.input) || work.inputHash !== value.inputHash
    || !isDeepStrictEqual(assistCapacityInput(work, value.input), value)) return false;
  const control = await readAssistControl(work.task, tx);
  if (!control.dispatchEnabled || control.mode === "off" || control.revision !== work.controlRevision
    || !await assistOriginActive(tx, work.originJob) || !await assistOriginActive(tx, job.name)) return false;
  if (value.input.task !== "uptime" || value.input.subject.id !== candidate.product.id
    || value.input.subject.revision !== candidate.product.updatedAt || value.input.context.requestedUrl !== candidate.product.url
    || value.input.context.failureCount !== candidate.health.failures || value.input.context.requiredFailures !== UPTIME_AUTO_BAN_THRESHOLD
    || value.input.context.administratorReleased || !value.input.sources.some(source => source.completeness === "complete" && source.text.trim()
      && Date.parse(source.observedAt) <= Date.now() && Date.parse(source.observedAt) >= Date.now() - 180_000)) return false;
  const [current] = await tx.select({ id: products.id }).from(products).innerJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(and(eq(products.id, candidate.product.id), eq(products.url, candidate.product.url), eq(products.accessMode, "website"),
      sql`${products.status} in ('seeded','verified')`, sql`${products.updatedAt}::text=${candidate.product.updatedAt}`,
      sql`${productHealth.checkedAt}::text=${candidate.health.checkedAt}`, sql`${productHealth.downSince}::text=${candidate.health.downSince}`,
      eq(productHealth.failures, candidate.health.failures), eq(productHealth.status, candidate.health.status),
      sql`${productHealth.failures}>=${UPTIME_AUTO_BAN_THRESHOLD} and ${productHealth.status} not between 200 and 399
        and ${productHealth.status} not in (401,403,429,999) and ${productHealth.checkedAt} between clock_timestamp()-interval '6 hours' and clock_timestamp()`,
      uptimeNegativeAllowed({ id: products.id, url: products.url, updatedAt: products.updatedAt, checkedAt: productHealth.checkedAt,
        failures: productHealth.failures, status: productHealth.status }),
      sql`not exists(select 1 from product_evidence_audit a where a.slug=${products.slug} and a.action='admin.product.unban' and a.created_at>=${productHealth.checkedAt})`)).for("share");
  if (!current) return false;
  await assertJobLeaseAtWallTime(tx, job, "update");
  await assertRoleLease(tx, role);
  return Boolean(requestId);
}

/** 실제 capacity UPDATE가 성공한 뒤 같은 TX에서만 호출한다. */
export async function bindAssistModelRequest(tx: ProductTransaction, target: Extract<LocalModelTarget, { kind: "assist" }>, requestId: string) {
  const [row] = await tx.update(llmAssistWorks).set({ capacityRequestId: requestId, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(llmAssistWorks.id, target.workId), eq(llmAssistWorks.revision, target.workRevision),
      eq(llmAssistWorks.claimToken, target.claimToken), eq(llmAssistWorks.state, "claimed"))).returning({ id: llmAssistWorks.id });
  if (!row) throw new Error("assist_dispatch_claim_lost");
}
