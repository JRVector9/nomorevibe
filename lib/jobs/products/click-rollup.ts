import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { rollupDaily, pruneEvents } from "@/lib/domain/products/clicks";

/**
 * 클릭 집계 잡.
 *
 * 원천(click_events)을 하루 단위로 굴려 남기고, 오래된 원천을 지운다. 개별 클릭은 오래 두면
 * 행만 늘고 쓸 데가 없지만, 하루 합계는 몇 달 뒤에도 "언제 뜨거웠나"에 답한다.
 *
 * 최근 며칠을 매번 다시 계산해 덮어쓰므로 멱등이다 — 커서가 없고, 몇 틱 걸러 돌아도 빈 날이
 * 생기지 않는다.
 */
export async function rollupClicks(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const rolled = await rollupDaily();
  await pruneEvents();
  ctx.log("clicks.rolled", { rows: rolled });
  return { done: true };
}
