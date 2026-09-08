import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, crawlReviewAttempts,
  agentRepositoryScans, agentRepositoryObservations,
  type CrawlCandidate, type CrawlDocument, type CrawlReviewAttempt } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import {
  createReviewInput, isReviewCandidate, MAX_REVIEW_ATTEMPTS,
  REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash, reviewHash,
  REVIEW_RETRIABLE_REASONS, validateReviewOutcome,
  type ReviewInput, type ReviewOutcome,
} from "./agent-review-contract";

type Executor = typeof db | ProductTransaction;
export async function loadReviewInput(
  candidate: CrawlCandidate, document: CrawlDocument, settings: CrawlSettings, executor: Executor = db,
): Promise<ReviewInput> {
  const [scan] = await executor.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1);
  const observations = scan ? await executor.select().from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).orderBy(asc(agentRepositoryObservations.id)) : [];
  return createReviewInput(candidate, document, settings, { scan: scan ?? null,
    observations: observations.map(row => ({ id: `observation:${row.id}`, observation: row.facts })) });
}

/** All callers lock candidate → document → settings → scan → lease, with no network while locked. */
async function currentReviewInput(tx: ProductTransaction, expected: {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings; input: ReviewInput; lease: JobLease;
}): Promise<ReviewInput | null> {
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, expected.candidate.id)).for("update");
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id, expected.document.id)).for("share");
  const [settingsRow] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, expected.candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for("share");
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for("share");
  await assertJobLease(tx, expected.lease);
  if (!candidate || !document || !isReviewCandidate(candidate)
    || candidate.productUrl !== document.productUrl
    || !isDeepStrictEqual(candidate, expected.candidate) || !isDeepStrictEqual(document, expected.document)
    || !isDeepStrictEqual(mergeWithDefaults(settingsRow?.values), expected.settings)) return null;
  const input = await loadReviewInput(candidate, document, expected.settings, tx);
  return input.inputHash === expected.input.inputHash && input.sourceRevisionHash === expected.input.sourceRevisionHash
    && input.validUntil > new Date() && document.fetchedAt <= new Date()
    && (!input.source.scanCompletedAt || new Date(input.source.scanCompletedAt) <= new Date()) ? input : null;
}

/** Cheap current revision comparison used before LIMIT; final transactions also recompute inputHash. */
function matchingSource(settings: CrawlSettings): SQL {
  return sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id}
    AND ${crawlReviewAttempts.kind} = 'automatic'
    AND ${crawlReviewAttempts.policyHash} = ${reviewPolicyHash(settings)}
    AND ${crawlReviewAttempts.promptVersion} = ${REVIEW_PROMPT_VERSION}
    AND ${crawlReviewAttempts.rulesVersion} = ${REVIEW_RULES_VERSION}
    AND (${crawlReviewAttempts.source}->>'candidateJudgedAt')::timestamp IS NOT DISTINCT FROM date_trunc('milliseconds', ${crawlCandidates.judgedAt})
    AND EXISTS (SELECT 1 FROM crawl_documents rd
      LEFT JOIN LATERAL (SELECT s.* FROM agent_repository_scans s
        WHERE s.repository_key = lower(${crawlCandidates.repo}) AND s.scope = ''
        ORDER BY s.started_at DESC, s.id DESC LIMIT 1) rs ON true
      WHERE rd.repo = ${crawlCandidates.repo}
        AND rd.id::text = ${crawlReviewAttempts.source}->>'documentId'
        AND date_trunc('milliseconds', rd.fetched_at) = (${crawlReviewAttempts.source}->>'documentFetchedAt')::timestamp
        AND rd.fetched_at <= now()
        AND rd.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND rd.product_url IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'productUrl'
        AND rs.id::text IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanId'
        AND rs.commit_sha IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanSha'
        AND date_trunc('milliseconds', rs.completed_at) IS NOT DISTINCT FROM (${crawlReviewAttempts.source}->>'scanCompletedAt')::timestamp
        AND rs.state IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanState'
        AND rs.last_error_code IS NOT DISTINCT FROM ${crawlReviewAttempts.source}->>'scanError')`;
}

export function reviewApprovalPredicate(settings: CrawlSettings): SQL {
  if (settings.reviewMode !== "enforce") return sql`true`;
  return sql`(${crawlCandidates.decidedBy} = 'admin' OR EXISTS (
    SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
    AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve'
    AND ${crawlReviewAttempts.validUntil} > now()))`;
}

export async function listReviewCandidates(settings: CrawlSettings, limit = 20): Promise<CrawlCandidate[]> {
  if (!settings.enabled || settings.reviewMode === "off") return [];
  return db.select().from(crawlCandidates).where(and(
    eq(crawlCandidates.decidedBy, "auto"),
    sql`EXISTS (SELECT 1 FROM crawl_documents fd
      LEFT JOIN LATERAL (SELECT fs.completed_at FROM agent_repository_scans fs
        WHERE fs.repository_key = lower(${crawlCandidates.repo}) AND fs.scope = ''
        ORDER BY fs.started_at DESC, fs.id DESC LIMIT 1) fres ON true
      WHERE fd.repo = ${crawlCandidates.repo}
        AND fd.product_url IS NOT DISTINCT FROM ${crawlCandidates.productUrl}
        AND fd.fetched_at <= now() AND fd.fetched_at > now() - interval '24 hours'
        AND (fres.completed_at IS NULL OR (fres.completed_at <= now() AND fres.completed_at > now() - interval '24 hours')))`,
    sql`(${crawlCandidates.state} = 'approved' OR (${crawlCandidates.state} = 'needs_review'
      AND ${inArray(crawlCandidates.reason, [...REVIEW_RETRIABLE_REASONS])}))`,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.validUntil} > now()
      AND (${settings.reviewMode === "observe"}
        OR (${crawlCandidates.state} = 'approved' AND ${crawlReviewAttempts.outcome}->>'decision' = 'approve')
        OR (${crawlCandidates.state} = 'needs_review' AND ${crawlReviewAttempts.outcome}->>'decision' = 'needs_review')))`,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} = 'failed' AND ${crawlReviewAttempts.retryAfter} > now())`,
    sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
      AND ${crawlReviewAttempts.state} IN ('failed','superseded')) < ${MAX_REVIEW_ATTEMPTS}`,
  )).orderBy(asc(crawlCandidates.updatedAt), asc(crawlCandidates.id)).limit(Math.max(1, Math.min(100, limit)));
}

type ReviewContext = {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings; input: ReviewInput; lease: JobLease;
};
export type ReviewClaim = { kind: "claimed" | "reused"; attempt: CrawlReviewAttempt }
  | { kind: "skipped"; reason: string };

export async function claimAgentReview(input: ReviewContext & {
  provider: string; model: string; now?: Date;
}): Promise<ReviewClaim> {
  if (!input.settings.enabled || input.settings.reviewMode === "off") return { kind: "skipped", reason: "disabled" };
  return db.transaction(async tx => {
    const current = await currentReviewInput(tx, input);
    if (!current) return { kind: "skipped", reason: "input_changed" };
    const now = input.now ?? new Date();
    const rows = await tx.select().from(crawlReviewAttempts).where(and(
      eq(crawlReviewAttempts.candidateId, input.candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
      or(eq(crawlReviewAttempts.inputHash, current.inputHash), eq(crawlReviewAttempts.state, "running")),
    )).orderBy(desc(crawlReviewAttempts.id)).limit(16).for("update");
    const running = rows.find(row => row.state === "running");
    if (running) {
      if (running.leaseToken === input.lease.token) return { kind: "skipped", reason: "running" };
      await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "owner_changed", completedAt: now })
        .where(eq(crawlReviewAttempts.id, running.id));
      running.state = "superseded";
    }
    const same = rows.filter(row => row.inputHash === current.inputHash && row.sourceRevisionHash === current.sourceRevisionHash);
    const success = same.find(row => row.state === "succeeded" && row.validUntil > now && row.outcome
      && row.provider === input.provider);
    if (success) return { kind: "reused", attempt: success };
    if (input.provider !== "rules" && same.length >= MAX_REVIEW_ATTEMPTS) return { kind: "skipped", reason: "attempts_exhausted" };
    if (same.some(row => row.state === "failed" && row.retryAfter && row.retryAfter > now)) {
      return { kind: "skipped", reason: "retry_wait" };
    }
    const reusable = rows.find(row => row.inputHash === current.inputHash && row.state === "succeeded"
      && row.provider === input.provider
      && row.promptVersion === REVIEW_PROMPT_VERSION && row.rulesVersion === REVIEW_RULES_VERSION && row.outcome);
    // Observation database IDs can change on a fresh scan with the same semantic evidence.
    const copiedOutcome = reusable?.outcome ? { ...reusable.outcome,
      evidenceIds: reusable.outcome.evidenceIds.map(id => {
        if (id === "product") return id;
        const old = reusable.snapshot.evidence.find(item => item.id === id);
        return current.snapshot.evidence.find(item => old && reviewHash(item.observation) === reviewHash(old.observation))?.id ?? id;
      }),
    } : undefined;
    const [attempt] = await tx.insert(crawlReviewAttempts).values({
      candidateId: input.candidate.id, kind: "automatic", state: "running",
      inputHash: current.inputHash, policyHash: current.policyHash, sourceRevisionHash: current.sourceRevisionHash,
      snapshot: current.snapshot, source: current.source,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
      provider: input.provider.slice(0, 80), model: input.model.slice(0, 160), attemptNumber: same.length + 1,
      reusedFromAttemptId: reusable?.id ?? null,
      outcome: copiedOutcome ? validateReviewOutcome(current, copiedOutcome) : null,
      leaseToken: input.lease.token, validUntil: current.validUntil, startedAt: now,
    }).returning();
    return { kind: reusable ? "reused" : "claimed", attempt };
  });
}

export async function recordAgentReview(input: ReviewContext & {
  attempt: CrawlReviewAttempt; outcome?: ReviewOutcome; error?: string; retryAfter?: Date; now?: Date;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null };
}): Promise<{ applied: boolean; state: "succeeded" | "failed" | "superseded" }> {
  return db.transaction(async tx => {
    const current = await currentReviewInput(tx, input);
    const [attempt] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, input.attempt.id)).for("update");
    const now = input.now ?? new Date();
    const owns = attempt?.state === "running" && attempt.leaseToken === input.lease.token;
    const reusable = attempt?.state === "succeeded";
    if (!attempt || attempt.candidateId !== input.candidate.id || (!owns && !reusable)) return { applied: false, state: "superseded" };
    if (!current || attempt.inputHash !== current.inputHash || attempt.sourceRevisionHash !== current.sourceRevisionHash) {
      if (owns) await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "input_changed", completedAt: now })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      return { applied: false, state: "superseded" };
    }
    if (input.error) {
      if (owns) await tx.update(crawlReviewAttempts).set({ state: "failed", errorCode: input.error.slice(0, 120),
        retryAfter: input.retryAfter ?? new Date(now.getTime() + 60_000), completedAt: now })
        .where(eq(crawlReviewAttempts.id, attempt.id));
      return { applied: false, state: reusable ? "succeeded" : "failed" };
    }
    const outcome = validateReviewOutcome(current, reusable ? attempt.outcome : input.outcome ?? attempt.outcome);
    if (owns) await tx.update(crawlReviewAttempts).set({ state: "succeeded", outcome, completedAt: now, errorCode: null,
      inputTokens: input.usage?.inputTokens ?? null, outputTokens: input.usage?.outputTokens ?? null,
      costUsd: input.usage?.costUsd ?? null }).where(eq(crawlReviewAttempts.id, attempt.id));
    const applied = input.settings.reviewMode === "enforce";
    if (applied) await tx.update(crawlCandidates).set({
      state: outcome.decision === "approve" ? "approved" : outcome.decision === "reject" ? "rejected" : "needs_review",
      reason: outcome.decision === "approve" ? "passed" : outcome.decision === "reject" ? "not_a_product" : "ambiguous",
      decidedBy: "auto", updatedAt: now,
      signals: { ...input.candidate.signals, agentReviewAttemptId: attempt.id },
    }).where(eq(crawlCandidates.id, input.candidate.id));
    return { applied, state: "succeeded" };
  });
}

export class ReviewApprovalChangedError extends Error {
  constructor() { super("review_approval_changed"); }
}
export async function assertReviewApproval(tx: ProductTransaction, input: {
  candidate: CrawlCandidate; document: CrawlDocument; settings: CrawlSettings;
  input?: ReviewInput; lease: JobLease; approvalId?: number;
}): Promise<CrawlReviewAttempt | null> {
  if (input.settings.reviewMode !== "enforce" || input.candidate.decidedBy === "admin") {
    await assertJobLease(tx, input.lease);
    return null;
  }
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, input.candidate.repo.toLowerCase()), eq(agentRepositoryScans.scope, ""),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for("share");
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for("share");
  const current = await loadReviewInput(input.candidate, input.document, input.settings, tx);
  const [approval] = await tx.select().from(crawlReviewAttempts).where(and(
    eq(crawlReviewAttempts.candidateId, input.candidate.id), eq(crawlReviewAttempts.kind, "automatic"),
    eq(crawlReviewAttempts.state, "succeeded"), eq(crawlReviewAttempts.inputHash, current.inputHash),
    eq(crawlReviewAttempts.sourceRevisionHash, current.sourceRevisionHash),
    eq(crawlReviewAttempts.policyHash, current.policyHash),
    eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION), eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION),
    sql`${crawlReviewAttempts.outcome}->>'decision' = 'approve'`, sql`${crawlReviewAttempts.validUntil} > now()`,
    input.approvalId ? eq(crawlReviewAttempts.id, input.approvalId) : undefined,
  )).orderBy(desc(crawlReviewAttempts.id)).limit(1).for("share");
  await assertJobLease(tx, input.lease);
  if (!approval || current.validUntil <= new Date() || input.document.fetchedAt > new Date()
    || input.input && input.input.inputHash !== current.inputHash) throw new ReviewApprovalChangedError();
  validateReviewOutcome(current, approval.outcome);
  return approval;
}
