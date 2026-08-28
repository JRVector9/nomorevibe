import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { rollupDaily, pruneEvents } from "@/lib/domain/products/clicks";
import { pruneExpiredRateLimits } from "@/lib/rate-limit";

/**
 * 클릭 집계 잡.
 *
 * 원천(click_events)을 하루 단위로 굴려 남기고, 오래된 원천을 지운다. 개별 클릭은 오래 두면
 * 행만 늘고 쓸 데가 없지만, 하루 합계는 몇 달 뒤에도 "언제 뜨거웠나"에 답한다. 일별 고유
 * 방문자도 남기지만 여러 날의 값을 더해 기간 고유 방문자로 쓰지는 않는다.
 *
 * 지난 창이 지난 rate limit 행도 함께 지운다 — 클릭 중복 제거가 그 표를 제일 빨리 키운다.
 *
 * 최근 며칠을 매번 다시 계산해 덮어쓰므로 멱등이다 — 커서가 없고, 몇 틱 걸러 돌아도 빈 날이
 * 생기지 않는다.
 */
export async function rollupClicks(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const rolled = await rollupDaily();
  await pruneEvents();
  // 클릭 중복 제거가 rate_limits에 (제품 × 방문자)마다 키를 남긴다. 같이 지운다.
  const prunedLimits = await pruneExpiredRateLimits();
  ctx.log("clicks.rolled", { rows: rolled, prunedRateLimits: prunedLimits });
  return { done: true };
}
