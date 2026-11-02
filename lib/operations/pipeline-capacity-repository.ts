import { asc, eq, inArray } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews,
  type CrawlReviewAttempt, type SecondReview } from "@/lib/db/schema";
import { loadReviewInput, secondGateRequired, secondReviewApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { firstReviewers, hasFirstReviewer } from "@/lib/crawl/first-reviewers";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { canonicalReviewModel, sameReviewModel } from "@/lib/crawl/review-model-identity";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { requireReviewTaskRanks } from "@/lib/crawl/review-task-ranks";
import { secondReviewFallbacks, secondReviewVoters } from "@/lib/crawl/second-review-voters";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, type CapacityManifest, type GenerationRecord } from "./pipeline-capacity";

function gateTime(attempt: CrawlReviewAttempt, votes: SecondReview[], current: {
  candidate: typeof crawlCandidates.$inferSelect; document: typeof crawlDocuments.$inferSelect;
  settings: CrawlSettings; input: ReviewInput;
}, now: Date): string | null {
  const slots = current.settings.secondReview.voters.filter(v => !sameReviewModel(v.model, attempt.model));
  if (!slots.length) return null;
  // Original approval-slot validation precedes publication. Publication alone must
  // not erase that completed gate; published audit rows are still excluded below.
  const candidate = current.candidate.state === "published" && current.candidate.decidedBy === "auto"
    ? { ...current.candidate, state: "approved" as const } : current.candidate;
  const times: number[] = [];
  for (const slot of slots) {
    const matching = votes.filter(vote => {
      const root = vote.fallbackForId ? votes.find(row => row.id === vote.fallbackForId) : undefined;
      return vote.firstAttemptId === attempt.id && vote.trigger === "ai_approved" && !vote.publishedSlug
        && vote.status === "agreed" && vote.secondDecision === "approve" && vote.reviewedAt
        && (root?.provider ?? vote.provider) === slot.provider
        && sameReviewModel(root?.model ?? vote.model, slot.model)
        && secondReviewInputMatches(vote, { ...current, candidate, first: attempt, root }, now);
    }).map(row => row.reviewedAt!.getTime());
    if (!matching.length) return null;
    times.push(Math.min(...matching));
  }
  return new Date(Math.max(...times)).toISOString();
}

export async function snapshotPipelineGenerations(candidateIds: number[], expectedPolicyHash: string,
  expected?: Pick<CapacityManifest, "models" | "inputPolicyHash" | "comparisonPolicyHash">) {
  if (!candidateIds.length || candidateIds.length > 1000 || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("invalid_snapshot_candidates");
  if (expected) await requireReviewTaskRanks();
  return onPrimary(() => db.transaction(async tx => {
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    const settings = mergeWithDefaults(saved?.values);
    const policyHash = fullReviewPolicyHash(settings);
    if (policyHash !== expectedPolicyHash) throw new Error("snapshot_policy_mismatch");
    // 1차·2차 심사자는 「작업 ↔ 모델」 순위(PR C1) — 실행 쪽이 읽는 그대로 견준다(격리 replay 는 설정 행)
    const reviewers = firstReviewers(settings);
    const reviewer = reviewers[0] ?? null;
    if (expected) {
      // The certified manifest declares one AI1 model; it does not authorize an additive pool(1차 순위가 둘 이상이면 거절한다).
      if (reviewers.length > 1) throw new Error("unsupported_capacity_first_review_pool");
      if (expected.inputPolicyHash !== reviewPolicyHash(settings)
        || expected.comparisonPolicyHash !== comparisonReviewPolicyHash(settings)) throw new Error("snapshot_policy_mismatch");
      const identity = (row: { provider: string; model: string }) => ({ provider: row.provider, model: row.model,
        canonicalModel: canonicalReviewModel(row.model) });
      const pool = (rows: { provider: string; model: string }[]) => rows.map(identity)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const models = { first: reviewer ? identity(reviewer) : null, second: pool(secondReviewVoters(settings)),
        fallbacks: pool(secondReviewFallbacks(settings)) };
      const declared = { first: identity(expected.models.first), second: pool(expected.models.second),
        fallbacks: pool(expected.models.fallbacks) };
      if (JSON.stringify(models) !== JSON.stringify(declared)) throw new Error("snapshot_model_mismatch");
    }
    const capturedAt = new Date();
    const candidates = await tx.select().from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds));
    if (candidates.length !== candidateIds.length) throw new Error("snapshot_candidate_missing");
    const attempts = await tx.select({ attempt: crawlReviewAttempts, gate: secondReviewApprovalPredicate(settings) })
      .from(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, candidateIds))
      .orderBy(asc(crawlReviewAttempts.id)).limit(10001);
    const votes = await tx.select().from(secondReviews).where(inArray(secondReviews.candidateId, candidateIds)).limit(10001);
    if (attempts.length > 10000 || votes.length > 10000) throw new Error("snapshot_row_limit");
    const documents = await tx.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, candidates.map(c => c.repo)));
    const records: GenerationRecord[] = [];
    for (const candidate of candidates) {
      const document = documents.find(row => row.repo === candidate.repo);
      const input = document ? await loadReviewInput(candidate, document, settings, tx) : null;
      for (const { attempt, gate } of attempts.filter(row => row.attempt.candidateId === candidate.id)) {
        const currentInputMatched = Boolean(input && document && settings.enabled && settings.reviewMode === "enforce"
          && candidate.productUrl === document.productUrl && document.fetchedAt <= capturedAt
          && (!input.source.scanCompletedAt || new Date(input.source.scanCompletedAt) <= capturedAt)
          && input.validUntil > capturedAt && attempt.inputHash === input.inputHash
          && attempt.sourceRevisionHash === input.sourceRevisionHash && attempt.policyHash === input.policyHash
          && attempt.promptVersion === REVIEW_PROMPT_VERSION && attempt.rulesVersion === REVIEW_RULES_VERSION
          && hasFirstReviewer(reviewers, attempt));
        const required = attempt.outcome?.decision === "approve" && secondGateRequired(settings);
        const completed = required && gate && input && document && currentInputMatched
          ? gateTime(attempt, votes, { candidate, document, settings, input }, capturedAt) : null;
        const appliedId = candidate.signals?.agentReviewAttemptId;
        records.push({ candidateId: candidate.id, firstAttemptId: attempt.id,
          inputHash: attempt.inputHash, sourceRevisionHash: attempt.sourceRevisionHash, policyHash: attempt.policyHash,
          provider: attempt.provider, model: attempt.model, kind: attempt.kind, state: attempt.state,
          reusedFromAttemptId: attempt.reusedFromAttemptId, decision: attempt.outcome?.decision ?? null,
          startedAt: attempt.startedAt.toISOString(), completedAt: attempt.completedAt?.toISOString() ?? null,
          validUntil: attempt.validUntil.toISOString(), candidateState: candidate.state,
          decidedBy: candidate.decidedBy === "auto" || candidate.decidedBy === "admin" ? candidate.decidedBy : null,
          appliedAttemptId: typeof appliedId === "number" && Number.isSafeInteger(appliedId) ? appliedId : null,
          currentInputMatched, secondGateRequired: required,
          secondGateSatisfied: !required || Boolean(gate && completed), secondGateCompletedAt: completed });
      }
    }
    return { capturedAt: capturedAt.toISOString(), fullReviewPolicyHash: policyHash, generations: records };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }));
}
