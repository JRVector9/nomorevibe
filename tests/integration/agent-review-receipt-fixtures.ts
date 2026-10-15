import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlReviewAttempts } from "@/lib/db/schema";
import type { Ai1ReviewReceipt } from "@/lib/crawl/agent-review-repository";
import type { JobLease } from "@/lib/jobs/control";
import { lockItemStage, readItemStage } from "@/lib/jobs/items/repository";

/** Re-delivery fixtures read the actual attempt and current stage. The production
 * writer still validates the receipt, original input and actual job itself. */
export async function legacyReviewReceiptFixture(attemptId: number, job: JobLease): Promise<Ai1ReviewReceipt> {
  return db.transaction(async tx => {
    const guard = await lockItemStage(tx, "ai1");
    const stage = await readItemStage(tx, guard);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, attemptId));
    if (!attempt || attempt.kind !== "automatic") throw new Error("review_fixture_attempt_missing");
    return { attemptId: attempt.id,
      origin: attempt.state === "succeeded" ? "direct_reuse" : attempt.reusedFromAttemptId === null ? "fresh" : "semantic_reuse",
      ownership: { kind: "legacy", stageEpoch: stage.epoch, job } };
  });
}
