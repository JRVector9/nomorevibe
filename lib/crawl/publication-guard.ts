import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlSettings, agentRepositoryScans, type CrawlCandidate, type CrawlDocument, type DecisionReason } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { assertReviewApproval, ReviewApprovalChangedError } from "./agent-review-repository";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";

export class PublicationStateChangedError extends Error {
  constructor() { super("publication_state_changed"); }
}
type Snapshot = {candidate:unknown;document:unknown;settings:unknown};
export function publicationSourceChanged(candidate:Pick<CrawlCandidate,"productUrl">,document:Pick<CrawlDocument,"productUrl">):boolean {
  return candidate.productUrl !== document.productUrl;
}
export function assertPublicationSnapshot(expected: Snapshot, current: Snapshot) {
  if ((current.candidate as {state?:string}|undefined)?.state !== "approved" || !isDeepStrictEqual(expected,current)) {
    throw new PublicationStateChangedError();
  }
}

/**
 * Failure handling has the same race as insertion: never overwrite a newer review decision.
 *
 * state "new"는 실패가 아니라 되돌림이다 — 판정 뒤에 바뀐 원본이 지금 규칙을 통과하지 못한
 * 자동 승인(publish.ts의 stale_judgement)을 판정 잡에 다시 맡긴다. 결과를 여기서 지어 적지
 * 않는 것은, 판정 기록(신호·발자국·중복 URL 확인)을 남기는 곳이 판정 잡 하나여야 해서다.
 */
export async function recordPublicationFailure(candidate: CrawlCandidate, failure: {
  state:"needs_review"|"rejected"|"new"; reason:DecisionReason;
}, lease?: JobLease):Promise<boolean> {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id,candidate.id)).for("update");
    if (lease) await assertJobLease(tx, lease);
    if (!current || current.state !== "approved" || !isDeepStrictEqual(candidate,current)) return false;
    const now = new Date();
    await tx.update(crawlCandidates).set({
      state:failure.state,reason:failure.reason,judgedAt:now,updatedAt:now,
      // Retain the original reviewer and signals; an unsuccessful publish is not a new review.
    }).where(eq(crawlCandidates.id,current.id));
    return true;
  });
}

/** Locks the reviewed rows and marks publication in the same transaction as the product insert. */
export async function guardPublication(tx: ProductTransaction, input: {
  decision?: { revision: number | null; sourceHash: string | null };
  candidate:CrawlCandidate; document:CrawlDocument; settings:CrawlSettings; slug:string; scanId:number|null; lease?: JobLease;
}) {
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo,input.candidate.repo)).for("update");
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo,input.document.repo)).for("share");
  const [settingsRow] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id,1)).for("share");
  assertPublicationSnapshot(
    {candidate:input.candidate,document:input.document,settings:input.settings},
    {candidate,document,settings:mergeWithDefaults(settingsRow?.values)},
  );
  if (input.decision) {
    const [decision] = await tx.select().from(categoryDecisions).where(eq(categoryDecisions.repo,input.candidate.repo)).for('share');
    if ((decision?.revision ?? null) !== input.decision.revision || (decision?.sourceHash ?? null) !== input.decision.sourceHash) throw new PublicationStateChangedError();
  }
  await lockRepositoryAgentEvidence(tx, input.candidate.repo);
  if (input.scanId !== null) {
    const now = Date.now();
    const documentAge = now-document.fetchedAt.getTime();
    if (!Number.isFinite(documentAge) || documentAge < 0 || documentAge >= 24*3600_000) throw new PublicationStateChangedError();
    const [scan] = await tx.select().from(agentRepositoryScans).where(and(
      eq(agentRepositoryScans.repositoryKey,input.candidate.repo.toLowerCase()),eq(agentRepositoryScans.scope,""),
    )).orderBy(desc(agentRepositoryScans.startedAt),desc(agentRepositoryScans.id)).limit(1).for("share");
    if (!scan || scan.id !== input.scanId || scan.state !== "complete" || scan.lastErrorCode !== null
      || scan.detectorVersion !== input.settings.agentEvidence.detectorVersion
      || !scan.completedAt || !Number.isFinite(scan.completedAt.getTime())
      || now-scan.completedAt.getTime() < 0 || now-scan.completedAt.getTime() >= 24*3600_000) throw new PublicationStateChangedError();
  }
  if (input.lease) await assertReviewApproval(tx, { candidate, document, settings: input.settings, lease: input.lease });
  else if (input.settings.reviewMode === "enforce") throw new ReviewApprovalChangedError();
  await tx.update(crawlCandidates).set({state:"published",publishedSlug:input.slug,updatedAt:new Date()})
    .where(eq(crawlCandidates.id,candidate.id));
}
