import { modelLimits, modelTimeoutMs, scopedModel } from "@/lib/llm/model-registry";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { writeKeywordsWithModelCapacity } from "@/lib/domain/products/search-profile-model-capacity";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { PROFILE_MODEL, profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { pendingProfiles, recordProfileResult } from "@/lib/domain/products/search-profiles";
import { otherRoutesWaitingOnGroup } from "@/lib/llm/capacity-busy-targets";
import { isLockNotAvailable, readControlLockHolders } from "@/lib/llm/capacity-lock-diagnostics";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { DEFAULT_RUNTIME_SETTINGS, jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/**
 * 검색 키워드 짓기 — 공개 제품마다 모델이 한·영 검색어를 적는다(search-profile.ts).
 *
 * text 워커에서 돈다. 사유 번역·소개 짓기와 같은 자리다 — 셋 다 게이트웨이에 글을 짓게 하는 일이고,
 * 발행·심사 워커의 차례를 뺏지 않게 따로 뒀다(2026-09-21 text 역할 분리).
 *
 * 공개분 1만8천 건을 처음 채우는 데 오래 걸린다(한 건 5~7초, 한 번에 둘). 소개가 한 줄뿐인 제품부터 짓는다.
 *
 * 이 잡은 1차 심사에 게이트웨이를 양보한다. 둘 다 같은 gpt-oss 를 쓰고, 심사는 24초에 끊기며 세 번 끊기면
 * 자동 심사에서 빠진다. 2026-09-23 게이트웨이가 밀렸을 때(한 줄 응답 30~90초) 동시 셋으로 돌던 이 잡이
 * 심사 호출 앞에 줄을 세웠고, 그날 심사 후보 11건이 그렇게 빠졌다. 정체 자체는 이 잡을 멈춘 뒤에도 이어졌다 —
 * 원인이 아니라 보태는 쪽이었다.
 */

const JOB = "product-search-profile";
/**
 * 한도는 틱마다 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * - runtime_settings jobs.product-search-profile: batch 12(한 번에 집는 수), minCallMs 15초(이만큼 남아 있을 때만 새로 부른다),
 *   slowCallMs 20초(한 건이 이보다 오래 걸리면 게이트웨이가 밀린 것이다 — 평소 7초 안팎 — 이번 틱을 접고 심사에 자리를 준다).
 * - 등록부 경로 product-search-profile(routes.limits): 동시 호출(한 번에 둘 — gpt-oss 서버는 들어온 요청을 묶어 한꺼번에 처리해 둘이면 처리량이
 *   거의 두 배다. 하나일 때 시간당 약 680건(2026-09-24), 셋일 때 1차 심사가 평균 9.7→10.5초로 늘었다(9/23). 게이트웨이가 밀리면 slowCallMs 가
 *   틱을 접어 심사에 자리를 준다)과 한 번 부르는 데 둘 시간.
 * - 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 */
/** 느린 호출 문턱의 코드 기본값(로드 시점 값, 테스트용). 잡은 틱마다 jobs.product-search-profile.slowCallMs 를 읽는다 */
export const SLOW_CALL_MS = jobKnob(DEFAULT_RUNTIME_SETTINGS, JOB, "slowCallMs");

/** 게이트웨이가 막힌 것은 이 제품의 문제가 아니다 — 잇따라 둘이 막히면 이번 틱을 접는다 */
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

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
    const batch = jobKnob(knobs, JOB, "batch"), minCallMs = jobKnob(knobs, JOB, "minCallMs"), slowCallMs = jobKnob(knobs, JOB, "slowCallMs");
    const concurrency = modelLimits(JOB).concurrency, callMs = modelTimeoutMs(JOB);
    let written = 0, reused = 0, failed = 0, blocked = "", inARow = 0;
    // 이번 틱에 이미 집은 제품은 다시 고르지 않는다 — 적지 못하고 돌아온(skipped·쓰기 경합) 머리가 남은 틱을 같은 조회로 맴돌게 하지 않는다
    const visited = new Set<number>();

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const tasks = await pendingProfiles(batch, roleLease, [...visited]);
      if (tasks.length === 0) {
        ctx.log("search_profile.done", { written, reused, failed, drained: true });
        return { done: true };
      }
      let next = 0;
      // 같은 모델 그룹에서 다른 잡이 기다리면 이번 묶음은 일꾼 하나 — 자리가 나는 즉시 둘 다 채워 남을 굶기지 않는다.
      // 장부 예약을 쓰는 경로(역할 lease 가 있는 text 워커)에서만 본다. legacy 경로에는 장부가 없다.
      const fairShare = concurrency > 1 && roleLease !== undefined
        && await otherRoutesWaitingOnGroup("product-search-profile", scopedModel("product-search-profile", PROFILE_MODEL));
      if (fairShare) ctx.log("search_profile.fair_share", { concurrency: 1 });
      const settled = await Promise.allSettled(Array.from({ length: fairShare ? 1 : concurrency }, async () => {
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
            const calledAt = Date.now();
            const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
            const outcome = await writeKeywordsWithModelCapacity(task, lease, { signal, timeoutMs, roleLease });
            if (outcome.kind === "skipped") return;
            const result = outcome.result;
            if (signal.aborted) return;
            if (Date.now() - calledAt >= slowCallMs) blocked = "slow";
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
              if (GATEWAY_DOWN.has(result.error) || result.error.startsWith("http_5")) {
                if (++inARow >= 2) blocked = result.error;
              }
              continue;
            }
            inARow = 0;
            const success = { kind: "success" as const, en: result.en, ko: result.ko, model: scopedModel("product-search-profile", PROFILE_MODEL) };
            if (!await (outcome.expectedProfile ? recordProfileResult(task, lease, success, outcome.expectedProfile)
              : recordProfileResult(task, lease, success))) return;
            written++;
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) {
            // 미룸 사유(capacity·dispatched…)를 남긴다 — 러너는 'model_capacity' 하나로만 적는다
            if (!blocked) ctx.log("search_profile.capacity_deferred", { written, reused, failed, reason: error.reason });
            blocked ||= "model_capacity";
          }
          // 잠금 대기 초과(55P03)는 이 일꾼의 TX 하나가 접힌 것이다 — 옆 일꾼의 보내진 호출을 끊지 않는다(끊으면 그 요청이 미확인으로 남는다).
          // 새 호출만 멈추고 틱은 이 오류로 끝난다(last_error). 누가 잡았는지 한 번 남긴다(2026-10-31).
          else if (isLockNotAvailable(error)) {
            if (!blocked) ctx.log("search_profile.lock_timeout", { written, reused, failed });
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
        ctx.log("search_profile.budget_deferred", { written, reused, failed });
        return { done: false };
      }
      if (blocked) {
        ctx.log("search_profile.gateway_blocked", { error: blocked, written, reused, failed });
        return { done: true };
      }
    }
    ctx.log("search_profile.done", { written, reused, failed, drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
