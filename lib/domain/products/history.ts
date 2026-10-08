import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  crawlCandidates, crawlReviewAttempts, operationsAudit, productAuditItems, productEvidenceAudit, productRepoReviews, products,
} from "@/lib/db/schema";
import { githubOwnerFromRepositoryUrl } from "./github-owner";

/**
 * 제품 하나의 기록(2026-10-08 UX 감사 ADM-20) — 관리자 상세의 '이 제품의 기록'.
 *
 * 흩어진 다섯 곳을 시각 순(최근 것부터)으로 합친다.
 * - admin: 관리자 작업 로그(operations_audit) 중 이 제품을 겨눈 것 — 대상은 slug(차단·내리기·저장소 판정·감사)거나
 *   후보 저장소 owner/repo(심사 결정)다
 * - review: 이 제품이 된 후보의 심사 기록(crawl_review_attempts) — 끝난 자동 심사와 관리자 결정(admin_override)
 * - audit: 발행분 감사(product_audit_items)의 AI 판정과 사람 결정
 * - repo_review: 저장소가 사라진 웹사이트의 2단계 판정(product_repo_reviews)과 운영자 결정 — 한 행이라 마지막 것만 남아 있다
 * - status: 차단·해제 감사 행(product_evidence_audit) — 자동 차단(스팸 재검사)·내려달라는 요청 처리도 여기 남는다
 *
 * 관리자 차단은 작업 로그와 차단 감사 행에 한 번씩, 두 줄로 보인다 — 누가 눌렀는지와 상태가 바뀐 것은 다른 기록이다.
 * 각 출처에서 limit 건까지만 읽고 합친 뒤 다시 자른다.
 */

export type ProductHistoryKind = "admin" | "review" | "audit" | "repo_review" | "status";

export type ProductHistoryEntry = {
  at: Date;
  kind: ProductHistoryKind;
  /** 기록의 코드 — 화면이 라벨로 바꾸고 원래 코드는 툴팁으로 둔다 */
  action: string;
  actor: string | null;
  /** 사유·메모 한 줄 */
  note: string | null;
  ok: boolean;
};

export const PRODUCT_HISTORY_LIMIT = 30;

/** 작업 로그 detail 에서 사람이 읽을 사유·메모 */
function detailNote(detail: Record<string, unknown>): string | null {
  const parts = [detail.reason, detail.note, detail.tagline, detail.undo === true ? "알림에서 되돌림" : null]
    .filter((value): value is string => typeof value === "string" && value !== "");
  return parts.length ? parts.join(" · ") : null;
}

/** 이 제품을 겨눈 작업 로그 대상 — slug, 후보 저장소들, 저장소 URL 의 owner/repo */
function targetsOf(slug: string, repoUrl: string | null, candidateRepos: string[]): string[] {
  const owner = githubOwnerFromRepositoryUrl(repoUrl);
  const repo = owner ? owner.repositoryUrl.replace("https://github.com/", "") : null;
  return [...new Set([slug, ...candidateRepos, ...(repo ? [repo] : [])])];
}

export async function productHistory(slug: string, limit = PRODUCT_HISTORY_LIMIT): Promise<ProductHistoryEntry[]> {
  const [product] = await db.select({ id: products.id, repoUrl: products.repoUrl }).from(products).where(eq(products.slug, slug));
  if (!product) return [];
  const candidates = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo }).from(crawlCandidates)
    .where(eq(crawlCandidates.publishedSlug, slug));
  const candidateIds = candidates.map((candidate) => candidate.id);

  const [admin, reviews, audits, repoReview, status] = await Promise.all([
    db.select().from(operationsAudit)
      .where(inArray(operationsAudit.target, targetsOf(slug, product.repoUrl, candidates.map((candidate) => candidate.repo))))
      .orderBy(desc(operationsAudit.id)).limit(limit),
    candidateIds.length === 0 ? [] : db.select({
      kind: crawlReviewAttempts.kind, outcome: crawlReviewAttempts.outcome, actor: crawlReviewAttempts.actor,
      model: crawlReviewAttempts.model, reason: crawlReviewAttempts.reason, completedAt: crawlReviewAttempts.completedAt,
    }).from(crawlReviewAttempts)
      .where(and(inArray(crawlReviewAttempts.candidateId, candidateIds), eq(crawlReviewAttempts.state, "succeeded"),
        isNotNull(crawlReviewAttempts.completedAt)))
      .orderBy(desc(crawlReviewAttempts.completedAt)).limit(limit),
    db.select().from(productAuditItems).where(eq(productAuditItems.productId, product.id))
      .orderBy(desc(productAuditItems.id)).limit(limit),
    db.select().from(productRepoReviews).where(eq(productRepoReviews.productId, product.id)),
    db.select().from(productEvidenceAudit)
      .where(and(eq(productEvidenceAudit.slug, slug), inArray(productEvidenceAudit.action, ["admin.product.ban", "admin.product.unban"])))
      .orderBy(desc(productEvidenceAudit.id)).limit(limit),
  ]);

  const entries: ProductHistoryEntry[] = [
    ...admin.map((row) => ({ at: row.createdAt, kind: "admin" as const, action: row.action, actor: row.actor,
      note: row.ok ? detailNote(row.detail) : row.error, ok: row.ok })),
    ...reviews.map((row) => ({ at: row.completedAt!, kind: "review" as const,
      action: `${row.kind === "admin_override" ? "admin" : "ai"}-${row.outcome?.decision ?? "unknown"}`,
      actor: row.kind === "admin_override" ? row.actor : row.model, note: row.outcome?.reason ?? row.reason, ok: true })),
    ...audits.flatMap((row) => [
      ...(row.aiDecision && row.reviewedAt ? [{ at: row.reviewedAt, kind: "audit" as const, action: `ai-${row.aiDecision}`,
        actor: null, note: row.aiReason, ok: true }] : []),
      ...(row.humanDecision && row.humanAt ? [{ at: row.humanAt, kind: "audit" as const, action: `human-${row.humanDecision}`,
        actor: row.humanBy, note: row.humanNote, ok: true }] : []),
    ]),
    ...repoReview.flatMap((row) => [
      { at: row.reviewedAt, kind: "repo_review" as const, action: `ai-${row.decision}`, actor: row.model, note: row.reason, ok: true },
      ...(row.operatorDecision && row.operatorAt ? [{ at: row.operatorAt, kind: "repo_review" as const,
        action: `operator-${row.operatorDecision}`, actor: row.operatorBy, note: null, ok: true }] : []),
    ]),
    ...status.map((row) => ({ at: row.createdAt, kind: "status" as const, action: row.action, actor: row.actor, note: row.reason, ok: true })),
  ];
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
