import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, llmAssistControls, llmAssistWorks, modelCapacityRequests } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { isJobName } from "@/lib/jobs/catalog";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ModelCapacityOwner } from "@/lib/llm/capacity";
import { assistCandidateSourceHash, uptimeCandidateSchema, type AssistControl, type AssistWorkTask,
  type AssistWorkState, type UptimeAssistCandidate } from "./work";
import { ASSIST_POLICY_VERSION } from "./contracts";
import { ASSIST_PROMPT_VERSION } from "./prompts";

type Transaction = ProductTransaction;
export type AssistWork = typeof llmAssistWorks.$inferSelect;
export type AssistWorkClaim = { work: AssistWork; token: string; owner: ModelCapacityOwner; lease: JobLease };

export async function readAssistControl(task: AssistWorkTask, tx: Transaction | typeof db = db): Promise<AssistControl> {
  const [row] = await tx.select().from(llmAssistControls).where(eq(llmAssistControls.task, task)).for("share");
  return row ?? { task, mode: "off", confirmationRequired: false, dispatchEnabled: false, applyEnabled: false, revision: 1 };
}

/** caller는 현재 제품·관측 행을 이미 잠근 TX를 전달한다. HTTP와 모델 호출은 하지 않는다. */
export async function enqueueUptimeAssist(tx: Transaction, candidateValue: UptimeAssistCandidate,
  originJob = "uptime-ping"): Promise<{ mode: AssistControl["mode"]; confirmationRequired: boolean; workId: string | null; created: boolean }> {
  const candidate = uptimeCandidateSchema.parse(candidateValue);
  if (!isJobName(originJob)) throw new Error("invalid_assist_origin_job");
  const [control] = await tx.select().from(llmAssistControls).where(eq(llmAssistControls.task, "uptime")).for("share");
  if (!control) throw new Error("assist_control_missing");
  const decision = { mode: control.mode, confirmationRequired: control.confirmationRequired };
  if (control.mode === "off" && !control.confirmationRequired) return { ...decision, workId: null, created: false };
  const sourceHash = assistCandidateSourceHash(candidate);
  const [row] = await tx.insert(llmAssistWorks).values({ id: randomUUID(), task: "uptime", productId: candidate.product.id,
    originJob, source: candidate, sourceHash, policyVersion: ASSIST_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
    controlRevision: control.revision, priority: 100,
  }).onConflictDoNothing({ target: [llmAssistWorks.task, llmAssistWorks.productId, llmAssistWorks.sourceHash] })
    .returning({ id: llmAssistWorks.id });
  if (row) return { ...decision, workId: row.id, created: true };
  const [existing] = await tx.select({ id: llmAssistWorks.id }).from(llmAssistWorks).where(and(eq(llmAssistWorks.task, "uptime"),
    eq(llmAssistWorks.productId, candidate.product.id), eq(llmAssistWorks.sourceHash, sourceHash)));
  return { ...decision, workId: existing?.id ?? null, created: false };
}

export function uptimeAssistObservationUnhandled(fields: { id: unknown; url: unknown; updatedAt: unknown; checkedAt: unknown; failures: unknown; status: unknown }) {
  // SQLWrapper는 호출부의 Drizzle column/SQL뿐이다. 값으로 넘기는 경우도 parameter로 처리된다.
  return sql<boolean>`(not exists (select 1 from llm_assist_controls ac where ac.task='uptime' and ac.confirmation_required)
    or not exists (select 1 from llm_assist_work aw where aw.task='uptime' and aw.product_id=${fields.id}
      and aw.source->'product'->>'url'=${fields.url}
      and aw.source->'product'->>'updatedAt'=(${fields.updatedAt})::text
      and aw.source->'health'->>'checkedAt'=(${fields.checkedAt})::text
      and (aw.source->'health'->>'failures')::int=${fields.failures}
      and (aw.source->'health'->>'status')::int=${fields.status}
      and aw.state <> 'obsolete'))`;
}

/** 역할 job lease 외에 원 업무의 pause도 확인한다. pause는 원격 종료 증거가 아니다. */
export async function assistOriginActive(tx: Transaction, originJob: string): Promise<boolean> {
  const [row] = await tx.select({ name: jobs.name }).from(jobs).where(and(eq(jobs.name, originJob),
    sql`(${jobs.notBefore} is null or ${jobs.notBefore} <= clock_timestamp())`)).for("share");
  return Boolean(row);
}

/** backend들은 같은 큐를 소비한다. 이 함수는 짧은 DB claim만 하며 네트워크 동안 연결을 잡지 않는다. */
export async function claimAssistWork(input: { lease: JobLease; owner: ModelCapacityOwner; backendId: string;
  tasks: readonly AssistWorkTask[] }): Promise<AssistWorkClaim | null> {
  if (!input.tasks.length || !input.backendId.trim()) return null;
  return withJobLeaseWrite(input.lease, async tx => {
    const tasks = sql.join(input.tasks.map(task => sql`${task}`), sql`, `);
    const [candidate] = await tx.execute<{ id: string }>(sql`select w.id from llm_assist_work w
      join llm_assist_controls c on c.task=w.task and c.mode in ('shadow','confirm') and c.dispatch_enabled
      join jobs origin on origin.name=w.origin_job and (origin.not_before is null or origin.not_before <= clock_timestamp())
      join products p on p.id=w.product_id
      join product_health ph on ph.slug=p.slug
      where w.task in (${tasks}) and w.state in ('queued','waiting_capacity','retryable_transport')
        and w.next_attempt_at <= clock_timestamp()
        and p.status in ('seeded','verified') and p.url=w.source->'product'->>'url'
        and p.updated_at::text=w.source->'product'->>'updatedAt'
        and ph.checked_at::text=w.source->'health'->>'checkedAt'
        and ph.failures=(w.source->'health'->>'failures')::int and ph.status=(w.source->'health'->>'status')::int
        and not exists (select 1 from llm_assist_work active where active.task=w.task and active.product_id=w.product_id
          and active.state in ('claimed','indeterminate'))
      order by w.priority desc,w.next_attempt_at,w.created_at,w.id for update of w skip locked limit 1`);
    if (!candidate) return null;
    const [work] = await tx.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, candidate.id));
    if (!work || !await assistOriginActive(tx, work.originJob)) return null;
    const token = randomUUID();
    const control = await readAssistControl(work.task, tx);
    if (!control.dispatchEnabled || !["shadow", "confirm"].includes(control.mode)) return null;
    const [claimed] = await tx.update(llmAssistWorks).set({ state: "claimed", revision: work.revision + 1, claimToken: token, controlRevision: control.revision,
      claimJob: input.lease.name, claimJobToken: input.lease.token, claimRequestedVersion: input.lease.requestedVersion,
      ownerInstanceId: input.owner.instanceId, ownerBootId: input.owner.bootId, backendId: input.backendId, updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(llmAssistWorks.id, work.id), eq(llmAssistWorks.revision, work.revision))).returning();
    if (!claimed) return null;
    await assertJobLeaseAtWallTime(tx, input.lease);
    return { work: claimed, token, owner: input.owner, lease: input.lease };
  });
}

export async function lockAssistClaim(tx: Transaction, claim: AssistWorkClaim): Promise<AssistWork | null> {
  const [work] = await tx.select().from(llmAssistWorks).where(and(eq(llmAssistWorks.id, claim.work.id),
    eq(llmAssistWorks.revision, claim.work.revision), eq(llmAssistWorks.claimToken, claim.token),
    eq(llmAssistWorks.claimJobToken, claim.lease.token), eq(llmAssistWorks.ownerInstanceId, claim.owner.instanceId),
    eq(llmAssistWorks.ownerBootId, claim.owner.bootId), eq(llmAssistWorks.state, "claimed"))).for("update");
  if (!work) return null;
  await assertJobLeaseAtWallTime(tx, claim.lease);
  return work;
}

/** 무추론 대기는 시도 소모가 아니다. 원격 실행이 걸린 claim은 단순 대기로 풀 수 없다. */
export async function deferAssistClaim(claim: AssistWorkClaim, state: Exclude<AssistWorkState, "queued" | "claimed" | "done">,
  reason: string, options: { nextAttemptAt?: Date; consumesAttempt?: boolean } = {}): Promise<boolean> {
  return withJobLeaseWrite(claim.lease, async tx => {
    const work = await lockAssistClaim(tx, claim);
    if (!work) return false;
    if (work.capacityRequestId && state !== "indeterminate") {
      const [capacity] = await tx.select({ state: modelCapacityRequests.state }).from(modelCapacityRequests)
        .where(eq(modelCapacityRequests.requestId, work.capacityRequestId)).for("share");
      if (!capacity || !["settled", "withdrawn"].includes(capacity.state)) throw new Error("assist_remote_terminal_required");
    }
    const active = state === "indeterminate";
    const [updated] = await tx.update(llmAssistWorks).set({ state, revision: work.revision + 1, lastError: reason.slice(0, 120),
      attempts: work.attempts + (options.consumesAttempt ? 1 : 0), nextAttemptAt: options.nextAttemptAt?.toISOString() ?? work.nextAttemptAt,
      ...(active ? {} : { claimToken: null, claimJob: null, claimJobToken: null, claimRequestedVersion: null,
        ownerInstanceId: null, ownerBootId: null, backendId: null, capacityRequestId: null, input: null, inputHash: null }), updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(llmAssistWorks.id, work.id), eq(llmAssistWorks.revision, work.revision))).returning({ id: llmAssistWorks.id });
    return Boolean(updated);
  });
}
