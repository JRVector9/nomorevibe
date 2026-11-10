import { modelRequestBudget, modelRouteTimeoutMs } from "@/lib/llm/model-registry";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { pendingVerifications, recordVerificationResult, readSearchVerifyAffinityMember, restExpiredVerification } from "@/lib/domain/products/search-profiles";
import { verifyKeywordsWithModelCapacity } from "@/lib/domain/products/search-verify-model-capacity";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { pendingTextPoolTargetModel } from "@/lib/llm/text-task-pool-resume";
import { TextTaskRanks, type TextRankRun } from "@/lib/llm/ai-task-resolver";

/**
 * 검색 키워드 검수 — 지은 키워드를 게이트웨이의 Qwen3.8 이 근거와 대조해 뒷받침되지 않는 것을 뺀다(search-verify.ts).
 *
 * text 워커에서 돈다 — 게이트웨이 키가 있고, 키워드 짓기가 끝나 자리가 비었다. 심사 워커의 차례를 뺏지 않는다.
 * supa 서버는 동시 넷과 여덟의 처리량이 같았다(시간당 650~700건, 2026-09-25) — 넷으로 부른다.
 */

const JOB = "product-search-verify";
/**
 * 한도는 틱마다 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * - runtime_settings jobs.product-search-verify: batch 16(한 번에 집는 수. 대기열은 한 번에 읽어 나눈다 — 따로 읽으면 같은 제품을 두 번 부른다),
 *   minCallMs 20초(이만큼 남아 있을 때만 새로 부른다).
 * - 등록부 경로 product-search-verify(routes.limits): 동시 호출(넷)과 한 건(키워드 16개)에 둘 시간 — 시험에서 동시 넷일 때 5~25초.
 * - 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 *
 * 2026-10-31(PR 3a-B): 한 제품의 실패(시간 초과·429·5xx)는 그 제품의 시도로만 남고 다음 제품을 본다 — 예전의 "잇따라 둘이 막히면 틱을 접는다"는
 * 없앴다. 틱을 접는 것은 엔진이 모든 제품에 대해 내려갔음이 증명될 때만이다(lib/jobs/engine-down.ts).
 */

export async function verifySearchKeywords(ctx: JobContext<null>, request?: typeof fetch): Promise<JobOutcome<null>> {
  // 「작업 ↔ 모델」 순위(PR B)만 부른다 — 순위가 없거나 모두 쓸 수 없으면 기본값으로 부르지 않고 제 일 못 한 틱으로 남긴다
  const ranks = await TextTaskRanks.open(JOB);
  try { return await verifySearchKeywordsWithRanks(ctx, ranks, request); }
  finally { ctx.log("ai_task.ranks", ranks.summary()); }
}

type Flow = "next" | "stop";

async function verifySearchKeywordsWithRanks(ctx: JobContext<null>, ranks: TextTaskRanks, request?: typeof fetch): Promise<JobOutcome<null>> {
  const early = ranks.earlyDegraded();
  if (early) {
    ctx.log("search_verify.skipped", { reason: early.code });
    return { done: true, degraded: early };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Search keyword verification requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = tickRemaining(ctx, JOB, startedAt);
    const knobs = runtimeSettings();
    const batch = jobKnob(knobs, JOB, "batch"), minCallMs = jobKnob(knobs, JOB, "minCallMs");
    const concurrency = modelRequestBudget(JOB).concurrency, callMs = modelRouteTimeoutMs(JOB);
    let verified = 0, removed = 0, failed = 0, blocked = "";
    /** 이 틱에 넘긴 제품(이 제품만의 미룸) — 다시 고르지 않는다. 같은 머리가 남은 틱을 같은 조회로 맴돌게 하지 않는다 */
    const passed = new Set<number>();

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const fetched = await pendingVerifications(batch), tasks = fetched.filter(task => !passed.has(task.product.id));
      if (fetched.length === 0) {
        ctx.log("search_verify.done", { verified, removed, failed, drained: true });
        return { done: true };
      }
      if (tasks.length === 0) {
        ctx.log("search_verify.done", { verified, removed, failed, passed: passed.size, drained: false });
        return { done: false };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || ranks.exhausted || signal.aborted || !ctx.hasBudget() || remaining() < minCallMs) return;
            const task = tasks[index];
            const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
            const chunked = ["invalid_output", "timeout"].includes(task.profile!.verifyError ?? "");
            let attempt: TextRankRun<Flow>;
            try {
              // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 제품을 다음 순위로(TextTaskRanks.run)
              let prefer: string | null = null;
              if (ranks.mode === 'workload_pool') {
                const member = await readSearchVerifyAffinityMember(task);
                if (!member) { passed.add(task.product.id); continue; }
                prefer = await pendingTextPoolTargetModel(ranks, { routeId: JOB, member });
              }
              attempt = await ranks.run(async (binding): Promise<Flow> => {
                const outcome = await verifyKeywordsWithModelCapacity(task, lease, { request, signal, timeoutMs, chunked, minStepMs: minCallMs });
                if (outcome.kind === "skipped") return "stop";
                // The original shared deadline ended while waiting for a permit: no attempt or failure.
                // The product rests instead of staying at the queue head; each tick would otherwise restart it from step one forever (prod 11-10).
                if (outcome.kind === "expired") {
                  if (await restExpiredVerification(task, lease)) ctx.log("search_verify.expired_rest", { productId: task.product.id });
                  blocked ||= "deadline_expired";
                  return "stop";
                }
                const result = outcome.result;
                if (signal.aborted) return "stop";
                if (!result.ok) {
                  // A shorter deadline comes from this tick's remaining time, not the product.
                  // Keep it eligible for the next tick instead of consuming a retry.
                  if (result.error === "timeout" && timeoutMs < callMs) {
                    blocked = "tick_budget";
                    return "stop";
                  }
                  const failure = { kind: "failure" as const, error: result.error };
                  if (await (outcome.expectation ? recordVerificationResult(task, lease, failure, outcome.expectation)
                    : recordVerificationResult(task, lease, failure))) failed++;
                  // 그 제품의 실패로 남겼다. 엔진이 모든 제품에 대해 내려갔음이 증명되면(engine-down.ts) 이 순위만 쉬고 다음 제품은 다음 순위로 간다
                  if (ranks.failed(binding, result.error)) ctx.log("search_verify.rank_down", binding.memberId
                    ? { memberId: binding.memberId, configRevision: binding.configRevision } : { rank: binding.rank });
                  return "next";
                }
                ranks.answered(binding);
                const success = { kind: "success" as const, removed: result.unsupported, model: textTaskModel(JOB) };
                if (!await (outcome.expectation ? recordVerificationResult(task, lease, success, outcome.expectation)
                  : recordVerificationResult(task, lease, success))) return "next";
                verified++;
                removed += result.unsupported.length;
                return "next";
              }, { prefer });
            } catch (error) {
              // 이 제품만의 미룸이다 — 앞선 호출이 아직 보내진 중이거나(dispatched) 이 제품 한 세대의 장부가 사슬로 읽히지 않는다(ledger_mismatch).
              // 제품 하나를 건너뛰고 틱을 계속 돈다(틱 전체를 접지 않는다, 2026-10-31).
              if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerWork(error.reason)) {
                passed.add(task.product.id);
                ctx.log(error.reason === "dispatched" ? "search_verify.skipped_in_flight" : "search_verify.skipped", { productId: task.product.id, reason: error.reason });
                continue;
              }
              throw error;
            }
            // 모든 순위를 이 틱에 쓸 수 없다 — 이 제품은 그대로 두고(호출·시도 기록 없음) 틱을 접는다
            if (attempt.kind === "unusable" || attempt.value === "stop") return;
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) blocked ||= "model_capacity";
          else { blocked = "result_write_failed"; controller.abort(); }
          throw error;
        }
      }));
      const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const failure = failures.find(item => !(item.reason instanceof ModelCapacityDeferredError)) ?? failures[0];
      if (failure) {
        const processed = verified + failed;
        if (failure.reason instanceof ModelCapacityDeferredError && processed >= 1) return deferredJob("model_capacity", processed);
        throw failure.reason;
      }
      if (blocked === "deadline_expired") {
        ctx.log("search_verify.deadline_deferred", { verified, removed, failed });
        return { done: false };
      }
      if (blocked === "tick_budget") {
        ctx.log("search_verify.budget_deferred", { verified, removed, failed });
        return { done: false };
      }
      if (ranks.exhausted || !ranks.usable().length) {
        // 모든 순위가 이 틱에 쉰다. 포화면 예전처럼 미루고, 아니면 일을 했을 때만 보통 틱 — 한 건도 못 했으면 까닭을 남긴다
        const processed = verified + failed;
        if (ranks.saturated()) return deferredJob("model_capacity", processed);
        // 쓸 수 있던 순위가 모두 엔진 쪽 까닭으로 쉰다 — 예전의 「엔진이 내려가 틱을 접는다」(engine-down.ts)와 같다
        const down = ranks.engineDown();
        if (down) {
          ctx.log("search_verify.blocked", { error: down, verified, removed, failed });
          return { done: true };
        }
        ctx.log("search_verify.all_ranks_unusable", { verified, removed, failed });
        return processed ? { done: false } : { done: true, degraded: ranks.degraded() };
      }
    }
    ctx.log("search_verify.done", { verified, removed, failed, drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
