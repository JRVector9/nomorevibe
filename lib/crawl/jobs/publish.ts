import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { publishCandidate } from "@/lib/crawl/publish";

/**
 * 발행 잡 — 통과한 후보를 목록에 올린다. 파이프라인의 마지막 단계다.
 *
 * 크롤과 색인이 끊겨 있다는 것이 이 구조의 요지다. 수집기가 무엇을 긁어오든 products는
 * 이 단계를 거쳐야만 바뀐다.
 *
 * 커서가 없다. 발행하면 후보가 published로 바뀌어 대기 목록에서 빠진다.
 */

/** 한 번에 발행하는 수. 후보마다 insert와 OG 이미지 복사가 붙으므로 작게 잡는다 */
const BATCH = 10;

export async function publishCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.publish_skipped", { reason: "disabled" });
    return { done: true };
  }

  let published = 0;
  let skipped = 0;

  while (ctx.hasBudget()) {
    const candidates = await crawl.listCandidates(["approved"], BATCH);
    if (candidates.length === 0) {
      ctx.log("crawl.publish_done", { published, skipped, drained: true });
      return { done: true };
    }

    for (const candidate of candidates) {
      const result = await publishCandidate(candidate);

      if (!result.ok) {
        /**
         * 발행할 수 없는 후보는 거부로 내린다. 그대로 두면 다음 틱이 같은 것을 또 집어
         * 큐가 막힌다 — approved 상태가 곧 대기 목록이기 때문이다.
         */
        await crawl.recordJudgement({
          repo: candidate.repo,
          productUrl: candidate.productUrl,
          state: "rejected",
          reason: result.reason === "already_listed" ? "already_listed" : "not_a_product",
          decidedBy: "auto",
          signals: candidate.signals ?? undefined,
        });
        ctx.log("crawl.publish_skipped_candidate", { repo: candidate.repo, reason: result.reason });
        skipped++;
        continue;
      }

      published++;
      if (!ctx.hasBudget()) break;
    }
  }

  ctx.log("crawl.publish_done", { published, skipped, drained: false });
  return { done: false };
}
