import { modelLimits, modelTimeoutMs, scopedModel } from "@/lib/llm/model-registry";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { pendingVerifications, recordVerificationResult } from "@/lib/domain/products/search-profiles";
import { VERIFY_MODEL } from "@/lib/domain/products/search-verify";
import { verifyKeywordsWithModelCapacity } from "@/lib/domain/products/search-verify-model-capacity";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

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
 */
/** 게이트웨이가 막힌 것은 이 제품의 문제가 아니다 — 잇따라 둘이 막히면 이번 틱을 접는다 */
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

export async function verifySearchKeywords(ctx: JobContext<null>, request?: typeof fetch): Promise<JobOutcome<null>> {
  if (!textRouteCallable("product-search-verify", scopedModel("product-search-verify", VERIFY_MODEL))) {
    ctx.log("search_verify.skipped", { reason: "no_key" });
    return { done: true, degraded: { code: "no_key", detail: "이 경로의 직접 연결 계약도 text 워커의 ABCLLM_API_KEY 도 없습니다" } };
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
    const concurrency = modelLimits(JOB).concurrency, callMs = modelTimeoutMs(JOB);
    let verified = 0, removed = 0, failed = 0, blocked = "", inARow = 0;

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const tasks = await pendingVerifications(batch);
      if (tasks.length === 0) {
        ctx.log("search_verify.done", { verified, removed, failed, drained: true });
        return { done: true };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || signal.aborted || !ctx.hasBudget() || remaining() < minCallMs) return;
            const task = tasks[index];
            const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
            const chunked = ["invalid_output", "timeout"].includes(task.profile!.verifyError ?? "");
            const outcome = await verifyKeywordsWithModelCapacity(task, lease, { request, signal, timeoutMs, chunked });
            if (outcome.kind === "skipped") return;
            // The original shared deadline ended while waiting for a permit: no attempt or failure, next tick starts anew.
            if (outcome.kind === "expired") { blocked ||= "deadline_expired"; return; }
            const result = outcome.result;
            if (signal.aborted) return;
            if (!result.ok) {
              // A shorter deadline comes from this tick's remaining time, not the product.
              // Keep it eligible for the next tick instead of consuming a retry.
              if (result.error === "timeout" && timeoutMs < callMs) {
                blocked = "tick_budget";
                return;
              }
              const failure = { kind: "failure" as const, error: result.error };
              if (await (outcome.expectation ? recordVerificationResult(task, lease, failure, outcome.expectation)
                : recordVerificationResult(task, lease, failure))) failed++;
              if (GATEWAY_DOWN.has(result.error) || result.error.startsWith("http_5")) {
                if (++inARow >= 2) blocked = result.error;
              }
              continue;
            }
            inARow = 0;
            const success = { kind: "success" as const, removed: result.unsupported, model: scopedModel("product-search-verify", VERIFY_MODEL) };
            if (!await (outcome.expectation ? recordVerificationResult(task, lease, success, outcome.expectation)
              : recordVerificationResult(task, lease, success))) continue;
            verified++;
            removed += result.unsupported.length;
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) blocked ||= "model_capacity";
          else { blocked = "result_write_failed"; controller.abort(); }
          throw error;
        }
      }));
      const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const failure = failures.find(item => !(item.reason instanceof ModelCapacityDeferredError)) ?? failures[0];
      if (failure) throw failure.reason;
      if (blocked === "deadline_expired") {
        ctx.log("search_verify.deadline_deferred", { verified, removed, failed });
        return { done: false };
      }
      if (blocked === "tick_budget") {
        ctx.log("search_verify.budget_deferred", { verified, removed, failed });
        return { done: false };
      }
      if (blocked) {
        ctx.log("search_verify.blocked", { error: blocked, verified, removed, failed });
        return { done: true };
      }
    }
    ctx.log("search_verify.done", { verified, removed, failed, drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
