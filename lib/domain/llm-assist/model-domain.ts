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
import { assistCandidateSchema, assistCandidateSourceHash, assistCandidateSubject } from "./work";
import { lockRepoMoveCandidate } from "@/lib/domain/products/repo-move-reviews";
import { buildRepoMoveInput } from "@/lib/domain/products/repo-move-review";
import { introRecheckEligible, validateIntroAssistInput } from "@/lib/domain/products/intro-assist";
import { readIntroRecheckSnapshot } from "@/lib/domain/products/intro-assist-repository";
import { assistHash } from "./contracts";
import { lockActionAuditRuntimeInput, AuditDispatchBudgetExceededError } from "./audit-runtime";
import { readActionAuditPolicy } from "@/lib/domain/products/automated-action-audit";
import { resolveLocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

/** 예약→dispatch와 같은 TX에서 대상·근거·pause·lease를 증명하고 request ID를 원자 연결한다. */
export async function proveAssistModelDomain(tx: ProductTransaction, target: Extract<LocalModelTarget, { kind: "assist" }>,
  value: AssistCapacityInput, job: JobLease, role: RoleLease, requestId: string, model: string): Promise<boolean> {
  const [initial] = await tx.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, target.workId));
  if (!initial) return false;
  const candidate = assistCandidateSchema.parse(initial.source), subject = assistCandidateSubject(candidate);
  await lockPipelineInputStages(tx);
  if (candidate.kind === "repo_move") {
    if (!await lockRepoMoveCandidate(tx, candidate)) return false;
  } else if (!await lockProductGeneration(tx, subject.id, subject.slug)) return false;
  const [work] = await tx.select().from(llmAssistWorks).where(and(eq(llmAssistWorks.id, target.workId),
    eq(llmAssistWorks.revision, target.workRevision), eq(llmAssistWorks.claimToken, target.claimToken),
    eq(llmAssistWorks.state, "claimed"))).for("update");
  if (!work || work.task !== target.task || work.productId !== target.subjectId || work.backendId !== target.backendId
    || work.ownerInstanceId !== role.instanceId || work.ownerBootId !== role.bootId || work.claimJob !== job.name
    || work.claimJobToken !== job.token || work.claimRequestedVersion !== job.requestedVersion || work.capacityRequestId
    || work.sourceHash !== assistCandidateSourceHash(candidate)
    || !work.input || !isDeepStrictEqual(work.input, value.input) || work.inputHash !== value.inputHash
    || !isDeepStrictEqual(assistCapacityInput(work, value.input), value)) return false;
  const control = await readAssistControl(work.task, tx);
  if (!control.dispatchEnabled || control.mode === "off" || control.revision !== work.controlRevision
    || !await assistOriginActive(tx, work.originJob) || !await assistOriginActive(tx, job.name)) return false;
  if (candidate.kind === "decision_audit" || candidate.kind === "semantic_exception") {
    const config = readActionAuditPolicy(), contract = resolveLocalModelServingContract(target.backendId);
    if (!config.enabled || !contract || contract.model !== model
      || !await lockActionAuditRuntimeInput(tx, candidate, value.input, contract.modelFamily)) return false;
    // 공통 capacity 제어행이 잠긴 TX다. 실제 dispatch를 현재 UTC 주간 한도로 센다.
    const [used] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from model_capacity_requests r
      where r.dispatched_at>=date_trunc('week',clock_timestamp() at time zone 'UTC') at time zone 'UTC'
        and r.dispatch_binding->'target'->>'task'=${candidate.kind}`);
    const limit = candidate.kind === "semantic_exception" ? config.policy.maxExceptionsPerWeek : config.policy.maxAuditsPerWeek;
    if (used.count >= limit) throw new AuditDispatchBudgetExceededError();
    await assertJobLeaseAtWallTime(tx, job, "update"); await assertRoleLease(tx, role);
    return true;
  }
  if (candidate.kind === "intro_recheck") {
    const current = await readIntroRecheckSnapshot(subject.id, tx, "update");
    if (!current || !introRecheckEligible(current) || assistHash(current) !== assistHash(candidate.snapshot)
      || !validateIntroAssistInput(candidate, value.input) || !value.input.sources.some(source => source.completeness === "complete" && source.text.trim())) return false;
    await assertJobLeaseAtWallTime(tx, job, "update"); await assertRoleLease(tx, role);
    return Boolean(requestId);
  }
  if (candidate.kind === "repo_move") {
    const collected = value.input.sources.filter(source => source.sourceId !== "old_repository");
    if (value.input.task !== "repo" || !isDeepStrictEqual(buildRepoMoveInput(candidate, collected), value.input)
      || !value.input.sources.some(source => source.sourceId.startsWith("candidate_") && source.completeness === "complete" && source.text.trim()
        && Date.parse(source.observedAt) <= Date.now() && Date.parse(source.observedAt) >= Date.now() - 180_000)) return false;
    await assertJobLeaseAtWallTime(tx, job, "update"); await assertRoleLease(tx, role);
    return Boolean(requestId);
  }
  if (candidate.kind !== "uptime") return false;
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
