import { modelRequestBudget, modelRouteTimeoutMs } from "@/lib/llm/model-registry";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { writeKeywordsWithModelCapacity } from "@/lib/domain/products/search-profile-model-capacity";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { pendingProfiles, recordProfileResult, resumedProfileModel } from "@/lib/domain/products/search-profiles";
import { isLockNotAvailable, readControlLockHolders } from "@/lib/llm/capacity-lock-diagnostics";
import { logger } from "@/lib/observability/logger";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { TextTaskRanks, type TextRankRun } from "@/lib/llm/ai-task-resolver";

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
  // 「작업 ↔ 모델」 순위(PR B)만 부른다 — 순위가 없거나 모두 쓸 수 없으면 기본값으로 부르지 않고 제 일 못 한 틱으로 남긴다
  const ranks = await TextTaskRanks.open(JOB);
  try { return await writeSearchProfilesWithRanks(ctx, ranks); }
  finally { ctx.log("ai_task.ranks", ranks.summary()); }
}

type Flow = "next" | "stop";

async function writeSearchProfilesWithRanks(ctx: JobContext<null>, ranks: TextTaskRanks): Promise<JobOutcome<null>> {
  const early = ranks.earlyDegraded();
  if (early) {
    ctx.log("search_profile.skipped", { reason: early.code });
    return { done: true, degraded: early };
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
    const concurrency = modelRequestBudget(JOB).concurrency, callMs = modelRouteTimeoutMs(JOB);
    let written = 0, reused = 0, failed = 0, passed = 0, blocked = "";
    // 이번 틱에 이미 집은 제품은 다시 고르지 않는다 — 적지 못하고 돌아온(skipped·쓰기 경합·이 제품만의 미룸) 머리가 남은 틱을 같은 조회로 맴돌게 하지 않는다
    const visited = new Set<number>();

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      // 순위마다 이 프로세스가 줄에 세워 둔 요청을 먼저 이어받는다(쉬는 순위는 빼고)
      const tasks = await pendingProfiles(batch, roleLease, [...visited], ranks.usable());
      if (tasks.length === 0) {
        ctx.log("search_profile.done", { written, reused, failed, passed, drained: true });
        return { done: true };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || ranks.exhausted || signal.aborted || !ctx.hasBudget() || remaining() < minCallMs) return;
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
            let attempt: TextRankRun<Flow>;
            try {
              // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 제품을 다음 순위로(TextTaskRanks.run)
              attempt = await ranks.run(async (binding): Promise<Flow> => {
                const outcome = await writeKeywordsWithModelCapacity(task, lease, { signal, timeoutMs, roleLease });
                if (outcome.kind === "skipped") return "stop";
                const result = outcome.result;
                // Keep an already completed answer after the internal budget abort. The
                // fenced writer checks current ownership; external shutdown/failures still stop.
                if (ctx.signal?.aborted || signal.aborted && !result.ok) return "stop";
                if (!result.ok) {
                  // A shorter deadline comes from this tick's remaining time, not the product.
                  // Keep it eligible for the next tick instead of consuming a retry.
                  if (result.error === "timeout" && timeoutMs < callMs) {
                    blocked = "tick_budget";
                    return "stop";
                  }
                  const failure = { kind: "failure" as const, error: result.error };
                  if (!await (outcome.expectedProfile ? recordProfileResult(task, lease, failure, outcome.expectedProfile)
                    : recordProfileResult(task, lease, failure))) return "stop";
                  failed++;
                  // 그 제품의 실패로 남겼다. 엔진이 모든 제품에 대해 내려갔음이 증명되면(engine-down.ts) 이 순위만 쉬고 다음 제품은 다음 순위로 간다
                  if (ranks.failed(binding, result.error)) ctx.log("search_profile.rank_down", binding.memberId
                    ? { memberId: binding.memberId, configRevision: binding.configRevision } : { rank: binding.rank });
                  return "next";
                }
                ranks.answered(binding);
                const success = { kind: "success" as const, en: result.en, ko: result.ko, model: textTaskModel(JOB) };
                if (!await (outcome.expectedProfile ? recordProfileResult(task, lease, success, outcome.expectedProfile)
                  : recordProfileResult(task, lease, success))) return "stop";
                written++;
                return "next";
              }, { prefer: resumedProfileModel(task) });
            } catch (error) {
              // 이 제품만의 미룸 — 앞선 호출이 보내진 중(dispatched)·같은 제품이 다른 요청에 묶임(work_busy)·장부 세대 어긋남(ledger_mismatch).
              // 제품 하나를 건너뛰고 틱을 계속 돈다(호출·시도·실패 기록 없음; visited 가 이 틱에 다시 집지 않게 한다).
              if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerWork(error.reason)) {
                passed++;
                ctx.log("search_profile.passed", { productId: task.product.id, reason: error.reason });
                continue;
              }
              throw error;
            }
            // 모든 순위를 이 틱에 쓸 수 없다 — 이 제품은 그대로 두고(호출·시도 기록 없음) 틱을 접는다
            if (attempt.kind === "unusable" || attempt.value === "stop") return;
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) {
            // 전역 미룸(draining·owner…)을 남긴다 — 러너는 'model_capacity' 하나로만 적는다
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
      if (failure) {
        // 항목을 끝낸 뒤의 모델 미룸은 던지지 않고 건수를 실어 돌려준다. 러너는 1건 이상이면 lastSuccessAt 을 옮긴다.
        // 한 건도 못 끝냈거나 모델 미룸이 아닌 오류(잠금 대기 등)는 종전대로 던진다.
        const processed = written + reused + failed;
        if (failure.reason instanceof ModelCapacityDeferredError && processed >= 1) return deferredJob("model_capacity", processed);
        throw failure.reason;
      }
      if (blocked === "tick_budget") {
        ctx.log("search_profile.budget_deferred", { written, reused, failed, passed });
        return { done: false };
      }
      if (ranks.exhausted || !ranks.usable().length) {
        // 모든 순위가 이 틱에 쉰다. 포화면 예전처럼 미루고, 아니면 일을 했을 때만 보통 틱 — 한 건도 못 했으면 까닭을 남긴다
        const processed = written + reused + failed;
        if (ranks.saturated()) return deferredJob("model_capacity", processed);
        // 쓸 수 있던 순위가 모두 엔진 쪽 까닭으로 쉰다 — 예전의 「엔진이 내려가 틱을 접는다」(engine-down.ts)와 같다
        const down = ranks.engineDown();
        if (down) {
          ctx.log("search_profile.gateway_blocked", { error: down, written, reused, failed, passed });
          return { done: true };
        }
        ctx.log("search_profile.all_ranks_unusable", { written, reused, failed, passed });
        return processed ? { done: false } : { done: true, degraded: ranks.degraded() };
      }
    }
    ctx.log("search_profile.done", { written, reused, failed, passed, drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
