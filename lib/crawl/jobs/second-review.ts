import { eq } from "drizzle-orm";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { db } from "@/lib/db";
import { crawlCandidates } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "@/lib/crawl/agent-review-gateway";
import { closeSettledSecondReviews, combineVerdicts, enqueueSecondReviews, pendingSecondReviews, recordSecondReview,
  retryFailedSecondReviews } from "@/lib/crawl/second-review";
import { loadReviewDocument } from "./review-document";

/**
 * 한 틱에 함께 부르는 수와 틱의 길이.
 *
 * 예산 55초(scripts/worker.ts) 안에서 돈다. 한 건이 게이트웨이 3~16초·CLI 20초라, 넷을 함께
 * 부르고 끝나는 대로 다음 것을 집으면 한 틱에 스무 건 안팎이 된다. 밀린 것이 수천 행이라
 * 5분에 두 건씩으로는 유입을 따라가지 못했다(24시간에 134건, 유입은 시간당 35건).
 */
const CONCURRENT = 4;
const TICK_MS = 54_000;
/** 한 틱에 집어 둘 일감 — 워커가 굶지 않을 만큼만 */
const FETCH = CONCURRENT * 6;

/**
 * 2차 심사. 올릴 것을 올리고, 끝난 것을 닫고, 대기 중인 것을 행에 적힌 모델로 본다.
 * 결과는 기록만 한다 — 대기 후보는 사람이 확정하고, 공개된 제품은 사람이 내릴지 정한다.
 */
export async function secondReviewCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  if (!settings.enabled || !settings.secondReview.enabled) {
    ctx.log("crawl.second_review_skipped", { reason: !settings.enabled ? "disabled" : "second_review_off" });
    return { done: true };
  }
  const enqueued = await enqueueSecondReviews(settings);
  const closed = await closeSettledSecondReviews();
  await retryFailedSecondReviews();
  const queue = [...await pendingSecondReviews(FETCH)];
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  let reviewed = 0, failed = 0, deferred = 0;

  await Promise.all(Array.from({ length: CONCURRENT }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      // 누가 볼지는 행에 적혀 있다 — 도중에 설정이 바뀌어도 올릴 때 정한 모델이 그 표를 낸다
      const provider = row.provider ?? "claude-cli";
      const model = row.model ?? settings.secondReview.voters[0].model;
      const limit = provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
      /*
       * 남은 시간에 끝낼 수 없는 호출은 시작하지 않는다.
       *
       * 잘린 호출은 timeout 으로 적히고 한 시간 뒤에야 다시 본다 — 그냥 다음 틱(1분 뒤)에
       * 온전한 시간으로 부르는 편이 빠르다.
       */
      if (!ctx.hasBudget() || remaining() < limit + 2_000) { deferred += 1; continue; }
      const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.candidateId)).limit(1);
      const document = candidate ? await loadReviewDocument(candidate.repo) : undefined;
      if (!candidate || !document) {
        failed += 1;
        await recordSecondReview(row.id, { ok: false, error: "missing_source", model, provider });
        continue;
      }
      const input = await loadReviewInput(candidate, document, settings);
      const result = provider === "abcllm"
        ? await reviewWithGateway(input, { model, timeoutMs: limit })
        : await reviewWithAgent(input, { model, timeoutMs: limit });
      if (!result.ok) {
        failed += 1;
        await recordSecondReview(row.id, { ok: false, error: result.error, model, provider });
        continue;
      }
      reviewed += 1;
      const second = { decision: result.outcome.decision, confidence: result.outcome.confidence ?? null, provider };
      await recordSecondReview(row.id, { ok: true, ...second, reason: result.outcome.reason, model,
        status: combineVerdicts({ decision: row.firstDecision, confidence: row.firstConfidence }, second, settings.secondReview.agreeAt, Boolean(row.publishedSlug)) });
    }
  }));

  ctx.log("crawl.second_reviewed", { enqueued, closed, reviewed, failed, deferred });
  return { done: reviewed + failed === 0 };
}
