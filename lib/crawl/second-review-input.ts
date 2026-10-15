import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, products, secondReviews,
  type CrawlCandidate, type CrawlDocument, type CrawlReviewAttempt, type SecondReview } from "@/lib/db/schema";
import { lockProductGeneration, type ProductTransaction } from "@/lib/domain/products/generation";
import { findRepositoryProduct } from "@/lib/domain/products/repository-identity";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import { loadReviewInput } from "./agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "./agent-review-contract";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import { sameReviewModel } from "./review-model-identity";
import { firstReviewer } from "./agent-review";
import { reviewSemanticNow } from "./review-replay-context";

/** Grok upstream decisions are usable only while that exact first reviewer is configured. */
export function firstReviewProviderPredicate(settings: CrawlSettings,
  attempts: { provider: AnyPgColumn; model: AnyPgColumn } = crawlReviewAttempts) {
  const reviewer = firstReviewer(settings);
  return or(inArray(attempts.provider, ["claude-cli", "abcllm"]),
    reviewer?.provider === "grok-cli" ? and(eq(attempts.provider, reviewer.provider),
      eq(attempts.model, reviewer.model)) : undefined)!;
}

/** Shared pure validation for a locked worker input and the bounded admission snapshot. */
export function secondReviewInputMatches(row: SecondReview, current: {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings; input: ReviewInput;
  first?: CrawlReviewAttempt | null; root?: SecondReview | null;
}, now = new Date()): boolean {
  now = reviewSemanticNow(now);
  const { candidate, document, settings, input, first, root } = current;
  const expected = row.trigger === "ai_approved" ? "approved" : "needs_review";
  if (candidate.id !== row.candidateId || candidate.repo !== row.repo || document.repo !== row.repo || (row.publishedSlug
    ? candidate.state !== "published" || candidate.publishedSlug !== row.publishedSlug
    : candidate.state !== expected || candidate.decidedBy !== "auto") || candidate.productUrl !== document.productUrl
    || !settings.enabled || !settings.secondReview.enabled) return false;
  if (row.publishedSlug ? row.firstAttemptId !== null || !["risk", "sample"].includes(row.trigger)
    : !["ai_decided", "ai_held", "ai_approved"].includes(row.trigger) || row.inputHash !== input.inputHash) return false;
  const pool = row.fallbackForId ? settings.secondReview.fallbacks ?? [] : settings.secondReview.voters;
  if (!pool.some(voter => voter.provider === row.provider && sameReviewModel(voter.model, row.model))) return false;
  if (row.fallbackForId && (!root || root.id !== row.fallbackForId || root.fallbackForId || root.candidateId !== row.candidateId
    || root.repo !== row.repo || root.firstAttemptId !== row.firstAttemptId || root.trigger !== row.trigger
    || root.publishedSlug !== row.publishedSlug || root.firstDecision !== row.firstDecision
    || (root.firstConfidence ?? null) !== (row.firstConfidence ?? null) || root.firstModel !== row.firstModel
    || root.generationKey !== row.generationKey || root.inputHash !== row.inputHash || root.status !== "resolved"
    || root.resolution !== "fallback" || !settings.secondReview.voters.some(voter => voter.provider === root.provider
      && sameReviewModel(voter.model, root.model)))) return false;
  if (secondReviewGeneration(row.firstAttemptId, input, row.trigger) !== row.generationKey
    || (!row.fallbackForId && sameReviewModel(row.firstModel, row.model))) return false;
  if (!row.publishedSlug) {
    const reviewer = firstReviewer(settings);
    if (!first || !first.model?.trim() || first.id !== row.firstAttemptId || first.candidateId !== row.candidateId
      || first.kind !== "automatic" || first.state !== "succeeded"
      || !["claude-cli", "abcllm", "grok-cli"].includes(first.provider ?? "")
      || (first.provider === "grok-cli" && (reviewer?.provider !== first.provider || reviewer.model !== first.model))
      || first.inputHash !== input.inputHash || first.sourceRevisionHash !== input.sourceRevisionHash
      || first.policyHash !== input.policyHash || first.promptVersion !== REVIEW_PROMPT_VERSION || first.rulesVersion !== REVIEW_RULES_VERSION
      || first.outcome?.decision !== row.firstDecision || (first.outcome?.confidence ?? null) !== (row.firstConfidence ?? null)
      || first.model !== row.firstModel || input.validUntil <= now) return false;
  }
  return true;
}

/**
 * 한 1차 판단·한 입력의 2차 세대.
 *
 * 관문 행(ai_approved)은 세대를 따로 쓴다(2026-09-19). 같은 1차 판단에 observe 때 만든 ai_decided 행이 이미 있으면
 * (후보·입력·모델·세대) 유일 색인에 걸려 관문 행이 조용히 안 들어가고, 후보가 "승인됐지만 발행 불가"로 갇힌다.
 */
export function secondReviewGeneration(firstAttemptId: number | null, input: Pick<ReviewInput, "inputHash" | "sourceRevisionHash">,
  trigger?: string | null): string {
  const parts: unknown[] = [firstAttemptId, input.inputHash, input.sourceRevisionHash];
  if (trigger === "ai_approved") parts.push("gate");
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** No network or mutation. With a transaction, lock in the same order as first-review recording. */
export async function loadSecondReviewInput(row: SecondReview, tx?: ProductTransaction): Promise<ReviewInput | null> {
  return (await secondReviewInputContext(row, tx))?.input ?? null;
}

/** Replay final writers hold every row read by the publication gate before taking the job lock. */
export async function loadLockedSecondReviewInput(row: SecondReview, tx: ProductTransaction): Promise<{
  input: ReviewInput; settings: CrawlSettings;
} | null> {
  const context = await secondReviewInputContext(row, tx, true);
  return context ? { input: context.input, settings: context.settings } : null;
}

export type SecondReviewDomainContext = {
  row: SecondReview; candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings;
  input: ReviewInput; first: CrawlReviewAttempt | null; root: SecondReview;
  /** Actual lifecycle-locked product generation; absent for unpublished inputs. */
  publishedProductId: number | null;
};

async function lockSecondReviewRows(tx: ProductTransaction, row: SecondReview): Promise<void> {
  // Keep the replay gate's full visibility, including damaged foreign bindings.
  await tx.select({ id: secondReviews.id }).from(secondReviews).where(or(
    eq(secondReviews.id, row.id),
    row.firstAttemptId ? eq(secondReviews.firstAttemptId, row.firstAttemptId) : undefined,
    row.fallbackForId ? eq(secondReviews.id, row.fallbackForId) : undefined,
    row.firstAttemptId ? sql`${secondReviews.id} IN (SELECT g.fallback_for_id FROM second_reviews g
      WHERE g.first_attempt_id = ${row.firstAttemptId} AND g.fallback_for_id IS NOT NULL)` : undefined,
  )).orderBy(secondReviews.id).for("update");
}

/** Caller acquires S3 first. No jobs or item locks occur in this domain phase.
 * Even an invalid input leaves the original vote/root locked for the narrowly
 * authorized legacy invalidation controller; null never grants result authority. */
export async function lockSecondReviewDomain(tx: ProductTransaction, id: number): Promise<SecondReviewDomainContext | null> {
  const [hint] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id));
  if (!hint) return null;
  let productId: number | undefined;
  if (hint.publishedSlug) {
    const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.slug, hint.publishedSlug));
    if (product && await lockProductGeneration(tx, product.id, hint.publishedSlug)) productId = product.id;
  }
  const context = await secondReviewInputContext(hint, tx, true);
  // Early invalidity in the existing read loader must not skip the vote lock.
  if (!context) { await lockSecondReviewRows(tx, hint); return null; }
  const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id));
  const root = row?.fallbackForId
    ? (await tx.select().from(secondReviews).where(eq(secondReviews.id, row.fallbackForId)))[0] : row;
  if (!row || !root || !secondReviewInputMatches(row, { ...context, root })) return null;
  if (row.publishedSlug && (!productId || (await findRepositoryProduct(row.repo, context.candidate.productUrl, tx))?.id !== productId)) return null;
  return { ...context, row, root, publishedProductId: row.publishedSlug ? productId! : null };
}

async function secondReviewInputContext(row: SecondReview, tx?: ProductTransaction, lockGate = false): Promise<SecondReviewDomainContext | null> {
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
  const input = await loadReviewInput(candidate, document, settings, executor);
  if (secondReviewGeneration(row.firstAttemptId, input, row.trigger) !== row.generationKey || (!row.fallbackForId && sameReviewModel(row.firstModel, row.model))) return null;
  let first: CrawlReviewAttempt | undefined;
  if (!row.publishedSlug) {
    // 관문은 그 1차 심사자(제공자·모델)의 최신 판단에 붙는다 — 다른 심사자의 더 새 판단과 견주지 않는다(codex 2차)
    const identityQuery = row.trigger === "ai_approved" && row.firstAttemptId
      ? executor.select({ provider: crawlReviewAttempts.provider, model: crawlReviewAttempts.model }).from(crawlReviewAttempts)
        .where(and(eq(crawlReviewAttempts.id, row.firstAttemptId), eq(crawlReviewAttempts.candidateId, row.candidateId))) : null;
    const [gateFirst] = identityQuery ? await (lockGate ? identityQuery.for("share") : identityQuery) : [];
    const firstQuery = executor.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, row.candidateId), eq(crawlReviewAttempts.kind, "automatic"),
      eq(crawlReviewAttempts.state, "succeeded"), firstReviewProviderPredicate(settings),
      gateFirst ? sql`${crawlReviewAttempts.provider} IS NOT DISTINCT FROM ${gateFirst.provider} AND ${crawlReviewAttempts.model} IS NOT DISTINCT FROM ${gateFirst.model}` : undefined,
    )).orderBy(desc(crawlReviewAttempts.id)).limit(1);
    [first] = await (lockGate ? firstQuery.for("share") : firstQuery);
    if (!first || first.id !== row.firstAttemptId || first.inputHash !== input.inputHash
      || first.sourceRevisionHash !== input.sourceRevisionHash || first.outcome?.decision !== row.firstDecision
      || first.model !== row.firstModel || input.validUntil <= reviewSemanticNow()) return null;
  }
  if (lockGate) {
    // Include all rows the SQL gate can see, even a wrongly bound candidate/root; the
    // recorder validates their bindings instead of silently omitting them from the gate.
    await lockSecondReviewRows(tx!, row);
  }
  let root: SecondReview | undefined;
  if (row.fallbackForId) [root] = await executor.select().from(secondReviews).where(eq(secondReviews.id, row.fallbackForId));
  return secondReviewInputMatches(row, { candidate, document, settings, input, first, root })
    ? { row, candidate, document, settings, input, first: first ?? null, root: root ?? row, publishedProductId: null } : null;
}
