import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, operationsAudit, type CrawlCandidate, type Product } from "@/lib/db/schema";
import { findRepositoryProduct, lockProductRepository } from "@/lib/domain/products/repository-identity";

// A model's prose is never proof of a duplicate. Only our own rules record qualifies.
const repairable = and(eq(crawlCandidates.state, "rejected"), eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug),
  or(eq(crawlCandidates.reason, "already_listed"), and(eq(crawlCandidates.reason, "not_a_product"), sql`exists (
    select 1 from ${crawlReviewAttempts} r where r.id::text = ${crawlCandidates.signals}->>'agentReviewAttemptId'
      and r.candidate_id = ${crawlCandidates.id} and r.provider = 'rules' and r.state = 'succeeded'
      and r.outcome->>'decision' = 'reject'
      and r.outcome->>'reason' in ('기존 등재 규칙에 해당합니다: already_listed', '기존 등재 규칙에 해당합니다: banned')
  )`)));

function correction(candidate: CrawlCandidate, existing: Product | undefined) {
  if (!existing) return null;
  const reason = existing.status === "banned" ? "banned" as const : "already_listed" as const;
  if (candidate.reason === reason && candidate.signals?.existingSlug === existing.slug && candidate.signals?.existingStatus === existing.status) return null;
  return { reason, signals: { ...candidate.signals, existingSlug: existing.slug, existingStatus: existing.status,
    stoppedAt: { rule: "기존 제품 확인", detail: `같은 저장소 또는 URL이 /p/${existing.slug} 로 ${existing.status === "banned" ? "차단" : "등재"}되어 있음` } } };
}

/** Read-only by default. Fix metadata on the same row; never publish or delete historical records. */
export async function reconcileCrawlDuplicates(options: { actor: string; apply?: boolean }) {
  if (!options.actor.trim() || options.actor.length > 120) throw new Error("invalid_actor");
  const rows = await db.select().from(crawlCandidates).where(repairable).orderBy(asc(crawlCandidates.id)).limit(2000);
  const entries: { repo: string; previousReason: string | null; reason: string; existingSlug: string }[] = [];
  let updated = 0, changed = 0;
  for (const candidate of rows) {
    const existing = await findRepositoryProduct(candidate.repo, candidate.productUrl);
    const next = correction(candidate, existing);
    if (!next) continue;
    entries.push({ repo: candidate.repo, previousReason: candidate.reason, reason: next.reason, existingSlug: next.signals.existingSlug });
    if (!options.apply) continue;
    const applied = await db.transaction(async tx => {
      await lockProductRepository(tx, `https://github.com/${candidate.repo}`);
      const [current] = await tx.select().from(crawlCandidates).where(and(eq(crawlCandidates.id, candidate.id), repairable)).for("update");
      if (!current || !isDeepStrictEqual(current, candidate)) return false;
      const verified = await findRepositoryProduct(current.repo, current.productUrl, tx);
      const correctionNow = correction(current, verified);
      if (!correctionNow || !isDeepStrictEqual(next, correctionNow)) return false;
      await tx.update(crawlCandidates).set({ ...correctionNow, updatedAt: new Date() }).where(eq(crawlCandidates.id, current.id));
      await tx.insert(operationsAudit).values({ actor: options.actor, action: "reconcile-crawl-duplicate", target: current.repo,
        detail: { candidateId: current.id, previousReason: current.reason, previousSignals: current.signals, ...correctionNow } });
      return true;
    });
    if (applied) updated++; else changed++;
  }
  return { examined: rows.length, eligible: entries.length, updated, changed, entries };
}
