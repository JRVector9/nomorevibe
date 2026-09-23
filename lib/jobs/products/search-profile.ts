import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { PROFILE_MODEL, profileEvidence, profileHash, writeKeywords } from "@/lib/domain/products/search-profile";
import { pendingProfiles, recordProfileResult } from "@/lib/domain/products/search-profiles";

/**
 * 검색 키워드 짓기 — 공개 제품마다 모델이 한·영 검색어를 적는다(search-profile.ts).
 *
 * text 워커에서 돈다. 사유 번역·소개 짓기와 같은 자리다 — 셋 다 게이트웨이에 글을 짓게 하는 일이고,
 * 발행·심사 워커의 차례를 뺏지 않게 따로 뒀다(2026-09-21 text 역할 분리).
 *
 * 공개분 1만8천 건을 처음 채우는 데 오래 걸린다(한 건 7초 안팎, 동시 셋). 소개가 한 줄뿐인 제품부터 짓는다.
 */

/** 한 번에 집는 수 */
const BATCH = 12;
/** 게이트웨이를 1·2차 심사와 같이 쓴다 — 셋을 넘기면 심사가 밀린다(심사 동시 4가 천장이었다) */
const CONCURRENCY = 3;
/** 한 번 부르는 데 둘 시간 */
const CALL_MS = 45_000;
/** 틱 예산(worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 54_000;
/** 이만큼 남아 있을 때만 새로 부른다 */
const MIN_CALL_MS = 15_000;

/** 게이트웨이가 막힌 것은 이 제품의 문제가 아니다 — 잇따라 둘이 막히면 이번 틱을 접는다 */
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

export async function writeSearchProfiles(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("search_profile.skipped", { reason: "no_key" });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Search profile worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = () => TICK_MS - (Date.now() - startedAt);
    let written = 0, reused = 0, failed = 0, blocked = "", inARow = 0;

    while (!signal.aborted && ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
      const tasks = await pendingProfiles(BATCH);
      if (tasks.length === 0) {
        ctx.log("search_profile.done", { written, reused, failed, drained: true });
        return { done: true };
      }
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (blocked || signal.aborted || !ctx.hasBudget() || remaining() < MIN_CALL_MS) return;
            const task = tasks[index];
            const evidence = profileEvidence(task.product, task.reviewerNote);
            // 지은 지 30일이 지나 다시 집었는데 글이 그대로다 — 본 시각만 새로 적는다
            if (task.profile && !task.profile.errorCode && task.profile.sourceHash === profileHash(evidence)) {
              if (!await recordProfileResult(task, lease, { kind: "reuse" })) return;
              reused++;
              continue;
            }
            const result = await writeKeywords(evidence, { signal, timeoutMs: Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000)) });
            if (signal.aborted) return;
            if (!result.ok) {
              if (!await recordProfileResult(task, lease, { kind: "failure", error: result.error })) return;
              failed++;
              if (GATEWAY_DOWN.has(result.error) || result.error.startsWith("http_5")) {
                if (++inARow >= 2) blocked = result.error;
              }
              continue;
            }
            inARow = 0;
            if (!await recordProfileResult(task, lease, { kind: "success", en: result.en, ko: result.ko, model: PROFILE_MODEL })) return;
            written++;
          }
        } catch (error) { blocked = "result_write_failed"; controller.abort(); throw error; }
      }));
      const failure = settled.find((item) => item.status === "rejected");
      if (failure) throw failure.reason;
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
