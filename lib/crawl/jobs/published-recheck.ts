import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { ensureRollingStream, recheckLimits, scanPublishedChanges, type RecheckCursor } from "@/lib/crawl/published-recheck";

/**
 * 공개분 변경 재검수 잡(published-recheck) — 공개 제품을 id 순서로 한 바퀴씩 돌며 받아 둔 원본을 모델이 마지막으로 본 내용과 견주고,
 * 뜻있게 바뀐 것을 감사 표의 늘 열린 줄에 올린다(lib/crawl/published-recheck.ts). 모델도 GitHub·사이트도 부르지 않는다.
 * 올린 것은 감사 잡(product-audit)이 1차 순위 모델로 묻고, 거절은 감사 보류와 같이 다룬다.
 *
 * 멈춤: 크롤 설정의 수집 스위치(비상 정지)가 꺼져 있거나 하루 상한(실시간 한도 jobs.published-recheck.dailyCap)이 0 이면 아무것도 하지 않는다.
 * 커서: 다음에 볼 제품 id. 한 바퀴를 마치면 처음부터 다시 돈다. 하루 상한에 닿으면 올리지 못한 제품 앞에 머문다.
 */
export async function recheckPublishedChanges(ctx: JobContext<RecheckCursor>): Promise<JobOutcome<RecheckCursor>> {
  const cursor: RecheckCursor = { afterId: Number.isSafeInteger(ctx.cursor?.afterId) && (ctx.cursor?.afterId ?? 0) >= 0 ? ctx.cursor!.afterId : 0 };
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("published_recheck.skipped", { reason: "disabled" });
    return { done: true, cursor };
  }
  const limits = recheckLimits();
  if (limits.dailyCap === 0) {
    ctx.log("published_recheck.skipped", { reason: "daily_cap_zero" });
    return { done: true, cursor };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("published recheck requires a valid worker job lease");
  const rolling = await ensureRollingStream(lease);
  const result = await scanPublishedChanges(ctx, { settings, limits, rolling, afterId: cursor.afterId, lease });
  ctx.log("published_recheck.scanned", { stream: rolling.id, ...result, scanBatch: limits.scanBatch, dailyCap: limits.dailyCap });
  if (result.capped) ctx.log("published_recheck.capped", { stream: rolling.id, dailyCap: limits.dailyCap, afterId: result.afterId });
  return { done: true, cursor: { afterId: result.finishedPass ? 0 : result.afterId } };
}
