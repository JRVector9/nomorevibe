import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { pendingVerifications, recordVerificationResult } from "@/lib/domain/products/search-profiles";
import { VERIFY_MODEL } from "@/lib/domain/products/search-verify";
import { verifyKeywordsWithModelCapacity } from "@/lib/domain/products/search-verify-model-capacity";

/**
 * 검색 키워드 검수 — 지은 키워드를 게이트웨이의 Qwen3.8 이 근거와 대조해 뒷받침되지 않는 것을 뺀다(search-verify.ts).
 *
 * text 워커에서 돈다 — 게이트웨이 키가 있고, 키워드 짓기가 끝나 자리가 비었다. 심사 워커의 차례를 뺏지 않는다.
 * supa 서버는 동시 넷과 여덟의 처리량이 같았다(시간당 650~700건, 2026-09-25) — 넷으로 부른다.
 */

/** 한 번에 집는 수. 대기열은 한 번에 읽어 나눈다 — 따로 읽으면 같은 제품을 두 번 부른다 */
const BATCH = 16;
const CONCURRENCY = 4;
/** 한 건(키워드 16개)에 둘 시간 — 시험에서 동시 넷일 때 5~25초 */
const CALL_MS = 60_000;
/** 틱 예산(worker.ts jobRunOptions 110초)보다 조금 짧게 */
const TICK_MS = 105_000;
/** 이만큼 남아 있을 때만 새로 부른다 */
const MIN_CALL_MS = 20_000;
/** 게이트웨이가 막힌 것은 이 제품의 문제가 아니다 — 잇따라 둘이 막히면 이번 틱을 접는다 */
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

export async function verifySearchKeywords(ctx: JobContext<null>, request?: typeof fetch): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("search_verify.skipped", { reason: "no_key" });
    return { done: true, degraded: { code: "no_key", detail: "text 워커에 ABCLLM_API_KEY 가 없습니다" } };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Search keyword verification requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = () => TICK_MS - (Date.now() - startedAt);
    let verified = 0, removed = 0, failed = 0, blocked = "", inARow = 0;

    while (!signal.aborted && ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
      const tasks = await pendingVerifications(BATCH);
      if (tasks.length === 0) {
        ctx.log("search_verify.done", { verified, removed, failed, drained: true });
        return { done: true };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || signal.aborted || !ctx.hasBudget() || remaining() < MIN_CALL_MS) return;
            const task = tasks[index];
            const timeoutMs = Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000));
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
              if (result.error === "timeout" && timeoutMs < CALL_MS) {
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
            const success = { kind: "success" as const, removed: result.unsupported, model: VERIFY_MODEL };
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
