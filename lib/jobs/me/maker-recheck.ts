import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { recheckMakerMemberships } from "@/lib/me/maker-claims";

/**
 * 운영자 확인 재확인 — 확인한 지 30일 지난 GitHub 저장소 주인 행을 한 틱에 20개까지 다시 본다(maker-claims.ts).
 * 주인이 바뀌었거나 저장소가 없어졌으면 운영자 확인을 푼다. 날짜가 지난 행이 없으면 조회 한 번으로 끝난다
 */
export async function recheckMakers(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const deadlineAt = Date.now() + 20_000;
  const summary = await recheckMakerMemberships({ lease: ctx.lease, deadlineAt, signal: ctx.signal, hasBudget: ctx.hasBudget });
  ctx.log("maker.recheck_done", summary);
  return { done: true };
}
