import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "../settings";
import { runHeldQwenRetry } from "../held-qwen-retry";

/**
 * 보류 Qwen-v2 재심사 잡(held-qwen-retry) — 소개 없음·재시도 소진·판단 보류로 사람 큐에 남은 후보를 gpu3090 Qwen-v2 에 다시 묻는다
 * (lib/crawl/held-qwen-retry.ts, 한 틱 perTick 개·budgetSeconds 초). 2026-10-31(PR 3a-C) 전에는 사람 큐 위임 잡(human-deepseek-review)의 앞부분이었다 —
 * M3 DeepSeek 위임·갈림 확인과 한 틱에 차례로 돌아 한 장비의 느림이 다른 장비의 큐를 미뤘다. 이제 자기 줄(held)에서 혼자 돈다.
 * 스위치는 qwenAuto.heldRetry(기본 꺼짐). 틱의 모양·기록·물러나기(qwen-endpoint-backoff.ts)·두 번째 자리(withQwenSecondarySlot)는 그대로다.
 */
export async function retryHeldQwen(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("held_qwen_job_required");
  const settings = await getSettings();
  const qwen = await runHeldQwenRetry(ctx, settings);
  ctx.log("crawl.held_qwen_retry", { started: qwen.started, pipeline: qwen.pipeline, rejected: qwen.rejected, held: qwen.held,
    failed: qwen.failed, reapplied: qwen.reapplied, refreshed: qwen.refreshed ?? 0, ...(qwen.skipped ? { skipped: qwen.skipped } : {}),
    ...(qwen.backoffUntil ? { backoffUntil: qwen.backoffUntil } : {}) });
  return { done: qwen.started + qwen.reapplied + (qwen.refreshed ?? 0) === 0 };
}
