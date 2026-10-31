import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { runGateSplitTiebreak } from "../gate-split-tiebreak";

/**
 * 틱의 길이 — 2차 심사 잡이 판가름을 나란히 띄울 때 넘기던 마감(TICK_MS 108초)과 같다. 판가름 자체는 LANE_MS(45초) 안에서만 새로 부른다
 * (gate-split-tiebreak.ts) — 잡 예산(110초)은 그대로이고 이 마감은 그 안의 상한일 뿐이다.
 */
const TICK_MS = 108_000;

/**
 * 2차 갈림 판가름 잡(split-tiebreak) — 두 모델 승인 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻는다(lib/crawl/gate-split-tiebreak.ts).
 * 2026-10-31(PR 3a-C) 전에는 2차 심사 잡(second-review) 틱 안에서 표 심사와 나란히 돌았다 — AI2 items 모드의 정비 틱·게이트웨이 표 심사와 한 잡이라
 * 한쪽의 실패가 다른 쪽의 틱을 실패로 남겼다. 이제 자기 줄(tiebreak)에서 돈다. 스위치는 qwenAuto.splitTiebreak. gpu3090 의 두 번째 자리
 * (withQwenSecondarySlot)·함께 쓰는 물러나기(qwen-endpoint-backoff.ts)는 그대로다.
 */
export async function tiebreakGateSplits(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const lease = ctx.lease;
  if (!lease) throw new Error("split_tiebreak_job_required");
  const tick = await runGateSplitTiebreak(ctx, lease, { deadlineAt: Date.now() + TICK_MS });
  return { done: tick.calls === 0 };
}
