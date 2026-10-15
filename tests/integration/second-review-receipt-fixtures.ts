import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { admitLegacySecondReview, type SecondReviewReceipt } from "@/lib/crawl/second-review-ownership";
import { recordSecondReview, type SecondReviewResult, type SecondReviewWriteResult } from "@/lib/crawl/second-review";

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
