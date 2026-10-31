import { modelLimits, modelTimeoutMs, scopedModel } from "@/lib/llm/model-registry";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { writeKeywordsWithModelCapacity } from "@/lib/domain/products/search-profile-model-capacity";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { EngineDownTally } from "@/lib/jobs/engine-down";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { PROFILE_MODEL, profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { pendingProfiles, recordProfileResult } from "@/lib/domain/products/search-profiles";
import { isLockNotAvailable, readControlLockHolders } from "@/lib/llm/capacity-lock-diagnostics";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/**
 * 검색 키워드 짓기 — 공개 제품마다 모델이 한·영 검색어를 적는다(search-profile.ts).
 *
 * text 워커에서 돈다. 사유 번역·소개 짓기와 같은 자리다 — 셋 다 게이트웨이에 글을 짓게 하는 일이고,
 * 발행·심사 워커의 차례를 뺏지 않게 따로 뒀다(2026-09-21 text 역할 분리).
 *
 * 공개분 1만8천 건을 처음 채우는 데 오래 걸린다(한 건 5~7초, 한 번에 둘). 소개가 한 줄뿐인 제품부터 짓는다.
 *
 * 2026-10-31(PR 3a-B) 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다":
 *  - 이 잡은 더 이상 다른 단계를 보고 양보하지 않는다 — 같은 장비의 다른 route 대기(otherRoutesWaitingOnGroup)·느린 호출(slowCallMs)로
 *    틱을 접던 것을 없앴다. 1차 심사와의 장비 나눔은 장비 순위(PR 1b)가 입장 TX 에서 정한다(2026-09-23 정체의 교훈은 그 표에 산다).
 *  - 한 제품의 실패(시간 초과·429·5xx)는 그 제품의 시도로만 남고 다음 제품을 본다. 틱을 접는 것은 엔진이 모든 제품에 대해 내려갔음이
 *    증명될 때만이다(lib/jobs/engine-down.ts). 한 제품만의 미룸(dispatched·work_busy·ledger_mismatch)은 그 제품만 넘긴다.
 */

const JOB = "product-search-profile";
/**
 * 한도는 틱마다 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * - runtime_settings jobs.product-search-profile: batch 12(한 번에 집는 수), minCallMs 15초(이만큼 남아 있을 때만 새로 부른다).
 *   slowCallMs 는 이제 읽지 않는다(표에는 남아 있다 — 관리자 정리는 3b-D).
 * - 등록부 경로 product-search-profile(routes.limits): 동시 호출(한 번에 둘 — gpt-oss 서버는 들어온 요청을 묶어 한꺼번에 처리해 둘이면 처리량이
 *   거의 두 배다. 하나일 때 시간당 약 680건(2026-09-24))과 한 번 부르는 데 둘 시간.
 * - 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 */

export async function writeSearchProfiles(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!textRouteCallable("product-search-profile", scopedModel("product-search-profile", PROFILE_MODEL))) {
    ctx.log("search_profile.skipped", { reason: "no_key" });
    return { done: true, degraded: { code: "no_key", detail: "이 경로의 직접 연결 계약도 text 워커의 ABCLLM_API_KEY 도 없습니다" } };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Search profile worker requires a job lease");
  const roleLease = roleLeaseFromEnv("text", process.env);
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
    let written = 0, reused = 0, failed = 0, passed = 0, blocked = "";
    const engine = new EngineDownTally();
    // 이번 틱에 이미 집은 제품은 다시 고르지 않는다 — 적지 못하고 돌아온(skipped·쓰기 경합·이 제품만의 미룸) 머리가 남은 틱을 같은 조회로 맴돌게 하지 않는다
    const visited = new Set<number>();

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const tasks = await pendingProfiles(batch, roleLease, [...visited]);
      if (tasks.length === 0) {
        ctx.log("search_profile.done", { written, reused, failed, passed, drained: true });
        return { done: true };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || signal.aborted || !ctx.hasBudget() || remaining() < minCallMs) return;
            const task = tasks[index];
            visited.add(task.product.id);
            const evidence = profileEvidence(task.product, task.reviewerNote);
            // 지은 지 30일이 지나 다시 집었는데 글이 그대로다 — 본 시각만 새로 적는다
            if (task.profile && !task.profile.errorCode && task.profile.sourceHash === profileHash(evidence)
              && (!task.profile.needsRefresh || task.profile.keywordsEn.length + task.profile.keywordsKo.length > 0)) {
              if (!await recordProfileResult(task, lease, { kind: "reuse" })) return;
              reused++;
              continue;
            }
            const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
            let outcome: Awaited<ReturnType<typeof writeKeywordsWithModelCapacity>>;
            try { outcome = await writeKeywordsWithModelCapacity(task, lease, { signal, timeoutMs, roleLease }); }
            catch (error) {
              // 이 제품만의 미룸 — 앞선 호출이 보내진 중(dispatched)·같은 제품이 다른 요청에 묶임(work_busy)·장부 세대 어긋남(ledger_mismatch).
              // 제품 하나를 건너뛰고 틱을 계속 돈다(호출·시도·실패 기록 없음; visited 가 이 틱에 다시 집지 않게 한다).
              if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerWork(error.reason)) {
                passed++;
                ctx.log("search_profile.passed", { productId: task.product.id, reason: error.reason });
                continue;
              }
              throw error;
            }
            if (outcome.kind === "skipped") return;
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
              if (!await (outcome.expectedProfile ? recordProfileResult(task, lease, failure, outcome.expectedProfile)
                : recordProfileResult(task, lease, failure))) return;
              failed++;
              // 그 제품의 실패로 남겼다. 엔진이 모든 제품에 대해 내려갔음이 증명될 때만 틱을 접는다(engine-down.ts)
              const down = engine.failed(result.error);
              if (down) blocked = down;
              continue;
            }
            engine.answered();
            const success = { kind: "success" as const, en: result.en, ko: result.ko, model: scopedModel("product-search-profile", PROFILE_MODEL) };
            if (!await (outcome.expectedProfile ? recordProfileResult(task, lease, success, outcome.expectedProfile)
              : recordProfileResult(task, lease, success))) return;
            written++;
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) {
            // 모델·전역 미룸(capacity·draining…)을 남긴다 — 러너는 'model_capacity' 하나로만 적는다
            if (!blocked) ctx.log("search_profile.capacity_deferred", { written, reused, failed, passed, reason: error.reason });
            blocked ||= "model_capacity";
          }
          // 잠금 대기 초과(55P03)는 이 일꾼의 TX 하나가 접힌 것이다 — 옆 일꾼의 보내진 호출을 끊지 않는다(끊으면 그 요청이 미확인으로 남는다).
          // 새 호출만 멈추고 틱은 이 오류로 끝난다(last_error). 누가 잡았는지 한 번 남긴다(2026-10-31).
          else if (isLockNotAvailable(error)) {
            if (!blocked) ctx.log("search_profile.lock_timeout", { written, reused, failed, passed });
            blocked = "lock_timeout";
          }
          else { blocked = "result_write_failed"; controller.abort(); }
          throw error;
        }
      }));
      if (blocked === "lock_timeout") {
        const holders = await readControlLockHolders();
        logger.warn("search_profile.lock_timeout_holders", { holders, written, reused, failed });
      }
      const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const failure = failures.find(item => !(item.reason instanceof ModelCapacityDeferredError)) ?? failures[0];
      if (failure) throw failure.reason;
      if (blocked === "tick_budget") {
        ctx.log("search_profile.budget_deferred", { written, reused, failed, passed });
        return { done: false };
      }
      if (blocked) {
        ctx.log("search_profile.gateway_blocked", { error: blocked, written, reused, failed, passed });
        return { done: true };
      }
    }
    ctx.log("search_profile.done", { written, reused, failed, passed, drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
