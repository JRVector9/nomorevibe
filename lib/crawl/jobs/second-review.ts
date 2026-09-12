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

/** 한 틱에 함께 보는 수 — 1차 심사와 같다(20초 호출 둘이 25초 틱 하나에 들어간다) */
const CONCURRENT = 2;

/**
 * 2차 심사. 올릴 것을 올리고, 끝난 것을 닫고, 대기 중인 것을 1차와 다른 모델로 본다.
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
  const pending = await pendingSecondReviews(CONCURRENT);
  const remaining = () => 24_000 - (Date.now() - startedAt);
  const { model, provider } = settings.secondReview;
  const limit = provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  let reviewed = 0, failed = 0;

  await Promise.all(pending.map(async (row) => {
    if (!ctx.hasBudget() || remaining() < 5_000) return;
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.candidateId)).limit(1);
    const document = candidate ? await loadReviewDocument(candidate.repo) : undefined;
    if (!candidate || !document) {
      failed += 1;
      await recordSecondReview(row.id, { ok: false, error: "missing_source", model, provider });
      return;
    }
    const input = await loadReviewInput(candidate, document, settings);
    const timeoutMs = Math.max(1, Math.min(limit, remaining()));
    const result = provider === "abcllm"
      ? await reviewWithGateway(input, { model, timeoutMs })
      : await reviewWithAgent(input, { model, timeoutMs });
    if (!result.ok) {
      failed += 1;
      await recordSecondReview(row.id, { ok: false, error: result.error, model, provider });
      return;
    }
    reviewed += 1;
    const second = { decision: result.outcome.decision, confidence: result.outcome.confidence ?? null };
    await recordSecondReview(row.id, { ok: true, ...second, reason: result.outcome.reason, model, provider,
      status: combineVerdicts({ decision: row.firstDecision, confidence: row.firstConfidence }, second, settings.secondReview.agreeAt, Boolean(row.publishedSlug)) });
  }));

  ctx.log("crawl.second_reviewed", { provider, model, enqueued, closed, reviewed, failed });
  return { done: pending.length === 0 };
}
