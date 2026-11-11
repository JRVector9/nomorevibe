import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmAssistWorks, modelCapacityRequests } from "@/lib/db/schema";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { assistLaneDispatching, claimAssistWork, deferAssistClaim } from "@/lib/domain/llm-assist/repository";
import { prepareAssistInput, recoverAbandonedAssistClaims } from "@/lib/domain/llm-assist/claim-lifecycle";
import { completeAssistClaim } from "@/lib/domain/llm-assist/complete";
import { assistBackendKey, type AssistBackendDrain } from "@/lib/domain/llm-assist/config";
import { assistLanePlan, assistLaneWork, type AssistRankDrain } from "@/lib/domain/llm-assist/rank-backends";
import { assistCapacityInput } from "@/lib/domain/llm-assist/model-input";
import { buildAssistModelRequest, parseAssistModelResponse } from "@/lib/domain/llm-assist/model-request";
import { assistCandidateSchema, assistCandidateSubject } from "@/lib/domain/llm-assist/work";
import type { AssistInput } from "@/lib/domain/llm-assist/contracts";
import { collectRepoMoveInput, checkRepoMoveBeforeApply } from "@/lib/domain/products/repo-move-evidence";
import { collectUptimeAssist } from "@/lib/domain/products/uptime-delist-review";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { collectIntroRecheckInput, runIntroCorrectionStage } from "@/lib/domain/products/intro-assist-runtime";
import { completeAssistIntroCorrection } from "@/lib/domain/llm-assist/intro-complete";
import { collectActionAuditInput, AuditDispatchBudgetExceededError } from "@/lib/domain/llm-assist/audit-runtime";
import { collectNewsLocalizationRuntimeInput } from "@/lib/domain/llm-assist/news-runtime";
import { parseCliEngineRevision } from "@/lib/llm/cli-engine-config";

const TICK_MS = 100_000;
const NATIVE_EXECUTION_MS = 60_000;
/**
 * backend별 drain은 동시에 시작하고 각 결과를 즉시 기록한다. 느린 M1·DeepSeek를 GPU의 앞에 두지 않는다.
 * 모델은 「작업 ↔ 모델」의 LLM 보강·LLM 보강 독립 감사 순위(lib/domain/llm-assist/rank-backends.ts, 2026-11-11)가 고른다 — 순위가 없을 때만 옛 env
 * LLM_ASSIST_BACKENDS. 순위로 고른 줄은 연결의 키로 부르고, 순위 사정을 ai_task.ranks 로 남긴다(작업 배정 화면의 「실행」).
 */
export async function reviewLlmAssist(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  return runAssistLane(ctx, "regular");
}
export async function reviewLlmAssistAudit(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  return runAssistLane(ctx, "audit");
}
async function runAssistLane(ctx: JobContext<null>, lane: "regular" | "audit"): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("assist_job_lease_required");
  if (ctx.lease.name !== (lane === "audit" ? "product-llm-assist-audit-review" : "product-llm-assist-review")) throw new Error("assist_job_lease_mismatch");
  const lease = ctx.lease, startedAt = Date.now(), role = roleLeaseFromEnv("reviewer", process.env);
  const plan = await assistLanePlan(lane, process.env);
  const claimedByRank = new Map<number, number>();
  // 순위로 고른 줄의 사정(몇 순위가 맡았나·앞 순위를 쓸 수 없던 까닭) — 틱 끝에 한 번(작업 배정 화면 「실행」)
  const logRanks = () => { if (plan.source === "ranks") ctx.log("ai_task.ranks", { ...plan.summary,
    ...Object.fromEntries([...claimedByRank].map(([rank, claimed]) => [`served.${rank}`, claimed])) }); };
  const backends: (AssistBackendDrain | AssistRankDrain)[] = plan.drains;
  if (!backends.length) {
    logRanks();
    // 순위를 모두 쓸 수 없거나 표를 못 읽었어도 보내기가 꺼진 줄이면 설정의 일이 아니다 — 운영자가 끈 것이다
    if (plan.source === "ranks" && plan.degraded && await assistLaneDispatching(assistLaneWork(lane)))
      return { done: true, degraded: plan.degraded };
    ctx.log("assist.disabled", { source: plan.source, ...(plan.source === "ranks" && plan.degraded ? { reason: plan.degraded.code } : {}) });
    return { done: true };
  }
  try { return await drainAssistLane(ctx, lease, startedAt, role, backends, claimedByRank); }
  finally { logRanks(); }
}

async function drainAssistLane(ctx: JobContext<null>, lease: NonNullable<JobContext<null>["lease"]>, startedAt: number,
  role: ReturnType<typeof roleLeaseFromEnv>, backends: readonly (AssistBackendDrain | AssistRankDrain)[], claimedByRank: Map<number, number>): Promise<JobOutcome<null>> {
  if (!role) return { done: true, degraded: { code: "owner_unavailable", detail: "보강 소비자의 reviewer lease가 없습니다" } };
  const owner = { instanceId: role.instanceId, bootId: role.bootId };
  const tickDeadlineAt = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity);
  const remaining = () => tickDeadlineAt - Date.now();
  await recoverAbandonedAssistClaims(lease);
  const drain = async (backend: AssistBackendDrain | AssistRankDrain) => {
    const counts = { claimed: 0, recorded: 0, applied: 0, deferred: 0, human: 0, indeterminate: 0 };
    // 순위로 고른 줄: 키는 그 연결의 키(없으면 키 없이 — 연결에 키를 두지 않은 엔진), 계약은 이 주소·모델로(단계 풀의 CLI 리비전을 따르지 않는다)
    const ranked = "rank" in backend ? backend : null;
    const apiKey = ranked ? ranked.apiKey : assistBackendKey(backend.backendId);
    const servingRevision = ranked ? { servingRevision: null } : {};
    const cliEngine = parseCliEngineRevision(backend.contract.deploymentRevision);
    if (!ranked && !apiKey && !cliEngine) { ctx.log("assist.backend_key_missing", { backendId: backend.backendId }); return counts; }
    for (let index = 0; index < backend.maxClaims && ctx.hasBudget() && !ctx.signal?.aborted && remaining() > 15_000; index++) {
      const claim = await claimAssistWork({ lease, owner, backendId: backend.backendId, tasks: backend.tasks, backendFamily: backend.contract.modelFamily });
      if (!claim) break;
      counts.claimed++;
      if (ranked) claimedByRank.set(ranked.rank.rank, (claimedByRank.get(ranked.rank.rank) ?? 0) + 1);
      let stage: "collection" | "model" = "collection";
      let factualRequestId: string | null = null;
      try {
        const claimBudgetMs = Math.max(1, Math.min(90_000, remaining() - 1000));
        // Collection and admission share the claim budget; both intro passes use this same cutoff.
        const admissionDeadlineAt = Date.now() + claimBudgetMs - NATIVE_EXECUTION_MS;
        const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(claimBudgetMs)]);
        const candidate = assistCandidateSchema.parse(claim.work.source), subject = assistCandidateSubject(candidate);
        let input: AssistInput;
        if (candidate.kind === "uptime") input = await collectUptimeAssist(candidate, signal);
        else if (candidate.kind === "intro_recheck") input = await collectIntroRecheckInput(candidate, signal);
        else if (candidate.kind === "news") {
          const collected = await collectNewsLocalizationRuntimeInput(candidate);
          if (collected.kind !== "ready") {
            await deferAssistClaim(claim, "obsolete", collected.reason); counts.deferred++; continue;
          }
          input = collected.input;
        }
        else if (candidate.kind === "decision_audit" || candidate.kind === "semantic_exception") {
          const collected = await collectActionAuditInput(candidate, { signal });
          if (collected.kind !== "ready") {
            await deferAssistClaim(claim, collected.kind, collected.reason); counts.deferred++; continue;
          }
          input = collected.input;
        }
        else if (candidate.kind === "repo_move") {
          const collected = await collectRepoMoveInput(candidate, { signal });
          if (collected.kind !== "ready") {
            await deferAssistClaim(claim, collected.kind, collected.reason); counts.deferred++; continue;
          }
          input = collected.input;
        } else throw new Error("unsupported_assist_candidate");
        if (!input.sources.some(source => source.completeness === "complete" && source.text.trim())) {
          await deferAssistClaim(claim, "waiting_evidence", "collection_incomplete"); counts.deferred++; continue;
        }
        if (!await prepareAssistInput(claim, input)) {
          await deferAssistClaim(claim, "obsolete", "control_or_input_changed"); counts.deferred++; continue;
        }
        if (!ctx.hasBudget() || signal.aborted || Date.now() >= admissionDeadlineAt) {
          await deferAssistClaim(claim, "waiting_capacity", "tick_budget", { nextAttemptAt: new Date(Date.now() + 60_000) });
          counts.deferred++; break;
        }
        const request = buildAssistModelRequest(input, backend.contract);
        stage = "model";
        const response = await withLocalModelCapacity({ target: { kind: "assist", purpose: "assist_review", workId: claim.work.id,
          workRevision: claim.work.revision, claimToken: claim.token, task: claim.work.task, subjectId: subject.id, backendId: backend.backendId },
          input: assistCapacityInput(claim.work, input), lease, promptVersion: input.promptVersion, allowLegacy: false,
          waitForCapacity: true, admissionDeadlineAt, ...servingRevision }, fetchModel =>
          fetchModel(backend.contract.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: request.wire, signal }));
        const raw = await response.text();
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = null; }
        const parsed = parseAssistModelResponse(input, value);
        if (!parsed.ok) {
          await deferAssistClaim(claim, "human", parsed.error, { consumesAttempt: true }); counts.human++; continue;
        }
        const freshRepoChecks = candidate.kind === "repo_move" && ["update_repo_candidate", "delist_candidate"].includes(parsed.outcome.action.proposal)
          ? await checkRepoMoveBeforeApply(candidate, { signal }) : undefined;
        const saved = await completeAssistClaim(claim, input, parsed.outcome, backend.contract, createHash("sha256").update(raw).digest("hex"), freshRepoChecks);
        if (saved.recorded) counts.recorded++;
        if (saved.applied) counts.applied++;
        if (saved.correctionRequired && saved.resultId && candidate.kind === "intro_recheck") {
          const [factsWork] = await db.select({ capacityRequestId: llmAssistWorks.capacityRequestId }).from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
          factualRequestId = factsWork?.capacityRequestId ?? null;
          const correction = await runIntroCorrectionStage({ candidate, input, factualResultId: saved.resultId, factual: parsed.outcome,
            workId: claim.work.id, contract: backend.contract }, async plan => {
            const response = await withLocalModelCapacity({ target: { kind: "assist", purpose: "intro_correction", workId: claim.work.id,
              workRevision: claim.work.revision, claimToken: claim.token, task: "intro_recheck", subjectId: subject.id, backendId: backend.backendId },
              input: plan.capacityInput, lease, promptVersion: plan.promptVersion, allowLegacy: false,
              waitForCapacity: true, admissionDeadlineAt, ...servingRevision }, fetchModel =>
              fetchModel(backend.contract.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: plan.wire, signal }));
            const [current] = await db.select({ capacityRequestId: llmAssistWorks.capacityRequestId }).from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
            if (!current?.capacityRequestId || current.capacityRequestId === factualRequestId) throw new Error("intro_correction_dispatch_missing");
            return { response, capacityRequestId: current.capacityRequestId };
          });
          if (!correction.ok) {
            await deferAssistClaim(claim, "human", correction.error, { consumesAttempt: true }); counts.human++; continue;
          }
          const applied = await completeAssistIntroCorrection(claim, candidate, input, parsed.outcome, correction);
          if (applied.applied) counts.applied++;
        }
      } catch (error) {
        const [work] = await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.id, claim.work.id));
        if (!work || work.state !== "claimed") continue;
        if (error instanceof AuditDispatchBudgetExceededError) {
          await deferAssistClaim(claim, "obsolete", "audit_weekly_budget_exhausted"); counts.deferred++; break;
        } else if (work.capacityRequestId) {
          const [capacity] = await db.select({ state: modelCapacityRequests.state }).from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, work.capacityRequestId));
          if (capacity?.state === "settled") {
            const capacityWait = error instanceof ModelCapacityDeferredError;
            await deferAssistClaim(claim, capacityWait ? "waiting_capacity" : "waiting_evidence", capacityWait ? `capacity_${error.reason}` : "post_model_validation_failed",
              { consumesAttempt: work.capacityRequestId !== factualRequestId, nextAttemptAt: new Date(Date.now() + 60_000) }); counts.deferred++;
          } else { await deferAssistClaim(claim, "indeterminate", "model_or_commit_unknown"); counts.indeterminate++; }
        } else if (error instanceof ModelCapacityDeferredError) {
          await deferAssistClaim(claim, "waiting_capacity", `capacity_${error.reason}`, { nextAttemptAt: new Date(Date.now() + 60_000) }); counts.deferred++;
          break;
        } else {
          await deferAssistClaim(claim, stage === "collection" ? "waiting_evidence" : "human",
            stage === "collection" ? "collection_failed" : "request_invalid", { consumesAttempt: false }); counts.deferred++;
        }
      }
    }
    ctx.log("assist.backend_done", { backendId: backend.backendId, ...(ranked ? { rank: ranked.rank.rank } : {}), ...counts });
    return counts;
  };
  const results = await Promise.allSettled(backends.map(drain));
  if (results.some(result => result.status === "rejected")) throw new Error("assist_backend_drain_failed");
  return { done: false };
}
