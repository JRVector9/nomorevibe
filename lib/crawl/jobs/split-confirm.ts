import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { runSplitTiebreakConfirmations } from "../gate-split-confirm";

/**
 * 2차 갈림 판가름의 DeepSeek 확인 잡(split-confirm) — 갈림 판가름(split-tiebreak)이 awaiting_deepseek 로 둔 Qwen-v2 거부를 M3 DeepSeek 에
 * 관문 입력 그대로 다시 묻고, DeepSeek 도 거부해야 닫는다(lib/crawl/gate-split-confirm.ts, 한 틱 SPLIT_CONFIRM_PER_TICK 건·SPLIT_CONFIRM_LANE_MS 안).
 * 2026-10-31(PR 3a-C) 전에는 사람 큐 위임 잡(human-deepseek-review)의 뒷부분이었다 — 위임이 끝난 뒤에만 차례가 왔다. 이제 자기 줄(confirm)에서
 * 돌고, M3 DeepSeek 에 한 번에 한 호출이라는 약속은 프로세스의 DeepSeek 자리(deepseek-slot.ts)가 지킨다. 스위치는 qwenAuto.splitTiebreak.
 */
export async function confirmGateSplits(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const lease = ctx.lease;
  if (!lease) throw new Error("split_confirm_job_required");
  const tick = await runSplitTiebreakConfirmations(ctx, lease);
  return { done: tick.calls === 0 };
}
