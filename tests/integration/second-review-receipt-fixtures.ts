import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { admitLegacySecondReview, type SecondReviewReceipt } from "@/lib/crawl/second-review-ownership";
import { closeSettledSecondReviews, enqueueSecondReviews, recordSecondReview, reopenOrphanedGateHolds,
  retryFailedSecondReviews, type SecondReviewResult, type SecondReviewWriteResult } from "@/lib/crawl/second-review";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";

/** Normal fixtures obtain authority through the real runner, never token INSERTs. */
export async function withLegacySecondReviewJob<T>(load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T, failed = false, failure: unknown;
  const result = await runJob<null>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("second_review_fixture_job_missing");
    try { value = await load(ctx.lease); }
    catch (error) { failed = true; failure = error; throw error; }
    return { done: true };
  });
  if (failed) throw failure;
  if (result.status !== "completed") throw new Error(`second_review_fixture_job_${result.status}:${"error" in result ? result.error : "reason" in result ? result.reason : ""}`);
  return value;
}

export async function admitSecondReviewFixture(id: number, lease: JobLease): Promise<SecondReviewReceipt> {
  const claim = await admitLegacySecondReview(id, lease);
  if (claim.kind !== "admitted") throw new Error(`second_review_fixture_admission_${claim.kind === "skipped" ? claim.reason : claim.kind}`);
  return claim.receipt;
}

export function recordSecondReviewFixture(id: number, result: SecondReviewResult, now?: Date): Promise<SecondReviewWriteResult> {
  return withLegacySecondReviewJob(async lease => recordSecondReview({
    receipt: await admitSecondReviewFixture(id, lease), result, now,
  }));
}

export function enqueueSecondReviewsFixture(settings: CrawlSettings, now?: Date): Promise<number> {
  return withLegacySecondReviewJob(lease => enqueueSecondReviews(settings, now, lease));
}

export function closeSettledSecondReviewsFixture(now?: Date): Promise<number> {
  return withLegacySecondReviewJob(lease => closeSettledSecondReviews(now, lease));
}

export function reopenOrphanedGateHoldsFixture(settings: CrawlSettings, now?: Date, limit?: number): Promise<number> {
  return withLegacySecondReviewJob(lease => reopenOrphanedGateHolds(settings, now, lease, limit));
}

export function retryFailedSecondReviewsFixture(now?: Date): Promise<void> {
  return withLegacySecondReviewJob(lease => retryFailedSecondReviews(now, lease));
}
