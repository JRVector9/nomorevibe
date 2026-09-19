import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews, type SecondReview } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import { loadReviewInput } from "./agent-review-repository";
import type { ReviewInput } from "./agent-review-contract";
import { mergeWithDefaults } from "./settings";
import { sameReviewModel } from "./review-model-identity";

export function secondReviewGeneration(firstAttemptId: number | null, input: Pick<ReviewInput, "inputHash" | "sourceRevisionHash">): string {
  return createHash("sha256").update(JSON.stringify([firstAttemptId, input.inputHash, input.sourceRevisionHash])).digest("hex");
}

/** No network or mutation. With a transaction, lock in the same order as first-review recording. */
export async function loadSecondReviewInput(row: SecondReview, tx?: ProductTransaction): Promise<ReviewInput | null> {
  const executor = tx ?? db;
  const candidateQuery = executor.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.candidateId)).limit(1);
  const [candidate] = await (tx ? candidateQuery.for("update") : candidateQuery);
  // 관문 행(ai_approved)은 1차가 승인해 발행을 기다리는 후보에, 나머지는 보류 후보에 붙는다
  const expected = row.trigger === "ai_approved" ? "approved" : "needs_review";
  if (!candidate || candidate.repo !== row.repo || (row.publishedSlug
    ? candidate.state !== "published" || candidate.publishedSlug !== row.publishedSlug
    : candidate.state !== expected || candidate.decidedBy !== "auto")) return null;
  const documentQuery = executor.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo)).limit(1);
  const [document] = await (tx ? documentQuery.for("share") : documentQuery);
  const settingsQuery = executor.select().from(crawlSettings).limit(1);
  const [saved] = await (tx ? settingsQuery.for("share") : settingsQuery);
  if (!document || candidate.productUrl !== document.productUrl) return null;
  if (tx) await lockRepositoryAgentEvidence(tx, row.repo);
  const settings = mergeWithDefaults(saved?.values);
  if (!settings.enabled || !settings.secondReview.enabled) return null;
  const pool = row.fallbackForId ? settings.secondReview.fallbacks ?? [] : settings.secondReview.voters;
  if (!pool.some(voter => voter.provider === row.provider && sameReviewModel(voter.model, row.model))) return null;
  if (row.fallbackForId) {
    const [root] = await executor.select().from(secondReviews).where(eq(secondReviews.id, row.fallbackForId));
    if (!root || root.fallbackForId || root.candidateId !== row.candidateId || root.generationKey !== row.generationKey
      || root.inputHash !== row.inputHash || root.status !== "resolved" || root.resolution !== "fallback"
      || !settings.secondReview.voters.some(voter => voter.provider === root.provider && sameReviewModel(voter.model, root.model))) return null;
  }
  const input = await loadReviewInput(candidate, document, settings, executor);
  if (secondReviewGeneration(row.firstAttemptId, input) !== row.generationKey || (!row.fallbackForId && sameReviewModel(row.firstModel, row.model))) return null;
  if (!row.publishedSlug) {
    const [first] = await executor.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, row.candidateId), eq(crawlReviewAttempts.kind, "automatic"),
      eq(crawlReviewAttempts.state, "succeeded"), inArray(crawlReviewAttempts.provider, ["claude-cli", "abcllm"]),
    )).orderBy(desc(crawlReviewAttempts.id)).limit(1);
    if (!first || first.id !== row.firstAttemptId || first.inputHash !== input.inputHash
      || first.sourceRevisionHash !== input.sourceRevisionHash || first.outcome?.decision !== row.firstDecision
      || first.model !== row.firstModel || input.validUntil <= new Date()) return null;
  }
  return input;
}
