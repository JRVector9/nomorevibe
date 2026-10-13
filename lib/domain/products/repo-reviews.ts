import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productEvidenceAudit, productRepoReviews, products, type ProductRepoReview, type RepoReviewAnswers,
  type RepoReviewDecision } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { repoGone, setStatusWithAudit } from "./repository";

/**
 * 2단계 확인(product_repo_reviews)의 읽기·쓰기 — 잡(product-repo-review)과 어드민 '저장소 사라짐'이 함께 쓴다.
 *
 * 다시 볼 때: keep 은 일주일 뒤, human 은 사흘 뒤(옮겨 간 저장소가 사라지거나 옛 저장소가 돌아오면 저절로 풀린다).
 * 저장소가 없다고 확인된 것은 잡이 그 자리에서 내린다(delistGoneRepository) — 하루 한도를 넘었거나 운영자가 전에 '유지'를
 * 고른 것만 delist_candidate 로 운영자를 기다린다. 운영자가 '유지'를 고르면 30일 뒤에 다시 본다.
 * 다시 봐도 운영자 결정은 지우지 않는다 — 운영자 결정보다 새 판정이 keep 이 아니면 다시 줄에 선다(repoReviewOpen).
 */
export const NEXT_REVIEW_DAYS: Record<RepoReviewDecision, number | null> = { keep: 7, human: 3, delist_candidate: null };
export const OPERATOR_KEEP_DAYS = 30;

/** 2단계 대상 — 공개 제품 중 저장소가 사라졌다고 확정된 것(repository.ts repoGone). 2026-10-13 부터 설치형도 본다 */
const target = sql`${products.status} in ('seeded', 'verified') and ${repoGone}`;
/** 잡이 스스로 내릴 때 감사 행·운영자 칸에 남기는 이름과 사유 */
export const REPO_GONE_AUTO_ACTOR = "auto:repo-gone";
export const REPO_GONE_AUTO_REASON = "repo_gone";
/**
 * 하루에 스스로 내리는 수의 상한 — 넘으면 내리지 않고 운영자 몫(delist_candidate)으로 둔다.
 * 새로 사라지는 저장소는 하루 수십 건 꼴이다. 하루 확인이나 github.com 이 잘못 답해 한꺼번에 내리는 일을 막는다(spam-rescan 과 같은 장치)
 */
export const MAX_REPO_GONE_DELISTS_PER_DAY = 100;

/**
 * 운영자를 기다리는 것 — AI 가 keep 이 아니라고 했고, 운영자가 아직 안 봤거나 운영자 결정 뒤에 다시 본 것.
 * products 와 product_repo_reviews 를 별칭 없이 조인한 쿼리에서만 쓴다.
 */
export const repoReviewOpen = sql`(${productRepoReviews.decision} <> 'keep'
  and (${productRepoReviews.operatorDecision} is null or ${productRepoReviews.operatorAt} < ${productRepoReviews.reviewedAt}))`;

export type RepoReviewTarget = {
  id: number; slug: string; name: string; url: string; repoUrl: string | null; renamedTo: string | null;
  /** 운영자가 전에 고른 것 — '유지'였으면 잡이 스스로 내리지 않는다 */
  operatorDecision: string | null;
};

/** 이번에 볼 것 — 아직 안 본 것 먼저, 그다음 다시 볼 때가 지난 것. 운영자가 내린 것은 공개가 아니라 빠진다 */
export async function dueRepoReviews(limit: number): Promise<RepoReviewTarget[]> {
  const due = sql`(${productRepoReviews.productId} is null or ${productRepoReviews.nextReviewAt} <= now())`;
  return db.select({
    id: products.id, slug: products.slug, name: products.name, url: products.url, repoUrl: products.repoUrl,
    renamedTo: products.repoRenamedTo, operatorDecision: productRepoReviews.operatorDecision,
  }).from(products)
    .leftJoin(productRepoReviews, eq(productRepoReviews.productId, products.id))
    .where(and(target, due, sql`${productRepoReviews.operatorDecision} is distinct from 'delist'`))
    .orderBy(sql`(${productRepoReviews.productId} is null) desc`, sql`${productRepoReviews.nextReviewAt} asc nulls first`, products.id)
    .limit(limit);
}

export type RepoReviewRecord = {
  productId: number; decision: RepoReviewDecision; reason: string; answers: RepoReviewAnswers | null; model: string | null;
  pageHttpStatus: number | null; finalUrl: string | null; pageTitle: string | null; pageExcerpt: string | null;
};

function reviewValues(record: RepoReviewRecord) {
  const days = NEXT_REVIEW_DAYS[record.decision];
  return {
    decision: record.decision, reason: record.reason.slice(0, 40), answers: record.answers,
    model: record.model?.slice(0, 80) ?? null, pageHttpStatus: record.pageHttpStatus, finalUrl: record.finalUrl,
    pageTitle: record.pageTitle?.slice(0, 300) ?? null, pageExcerpt: record.pageExcerpt?.slice(0, 600) ?? null,
    nextReviewAt: days === null ? null : sql`now() + ${days}::int * interval '1 day'`,
  };
}

/** 판정을 적는다. 운영자 결정 칸은 건드리지 않는다 */
export async function saveRepoReview(record: RepoReviewRecord, lease?: JobLease): Promise<void> {
  const values = reviewValues(record);
  await withJobLeaseWrite(lease, (tx) => tx.insert(productRepoReviews).values({ productId: record.productId, ...values })
    .onConflictDoUpdate({ target: productRepoReviews.productId, set: { ...values, reviewedAt: sql`now()` } }));
}

/** 지난 24시간에 잡이 스스로 내린 수 — 하루 한도(MAX_REPO_GONE_DELISTS_PER_DAY)와 견준다 */
export async function repoGoneDelistsLastDay(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(productEvidenceAudit).where(and(
    eq(productEvidenceAudit.action, "admin.product.ban"), eq(productEvidenceAudit.actor, REPO_GONE_AUTO_ACTOR),
    eq(productEvidenceAudit.reason, REPO_GONE_AUTO_REASON), sql`${productEvidenceAudit.createdAt} > now() - interval '24 hours'`,
  ));
  return row?.count ?? 0;
}

/**
 * 저장소가 없다고 확인된 제품을 내린다 — 운영자 '내리기'(decideRepoReview)와 같은 차단(admin.product.ban, 차단 해제로 되돌린다).
 * 판정과 운영자 칸(auto:repo-gone)을 같은 트랜잭션에 적는다. 고르고 나서 공개가 아니게 됐거나 저장소가 돌아왔으면 아무것도 하지 않는다.
 */
export async function delistGoneRepository(record: RepoReviewRecord & { slug: string }, lease?: JobLease): Promise<boolean> {
  return withJobLeaseWrite(lease, async (tx) => {
    const [row] = await tx.select({ status: products.status, gone: sql<boolean>`${repoGone}` }).from(products)
      .where(eq(products.id, record.productId)).for("update");
    if (!row || !["seeded", "verified"].includes(row.status) || !row.gone) return false;
    const banned = await setStatusWithAudit({ id: record.productId, slug: record.slug, status: "banned", action: "admin.product.ban",
      actor: REPO_GONE_AUTO_ACTOR, reason: REPO_GONE_AUTO_REASON }, tx);
    if (!banned) return false;
    const values = { ...reviewValues(record), operatorDecision: "delist" as const, operatorBy: REPO_GONE_AUTO_ACTOR, operatorAt: sql`now()` };
    await tx.insert(productRepoReviews).values({ productId: record.productId, ...values })
      .onConflictDoUpdate({ target: productRepoReviews.productId, set: { ...values, reviewedAt: sql`now()` } });
    return true;
  });
}

/** 어드민 줄에 붙일 판정 */
export async function repoReviewsFor(productIds: readonly number[]): Promise<Map<number, ProductRepoReview>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.select().from(productRepoReviews).where(inArray(productRepoReviews.productId, [...productIds]));
  return new Map(rows.map((row) => [row.productId, row]));
}

export type RepoReviewOperatorResult = { ok: true } | { ok: false; error: string };
const STALE = "이미 처리했거나 바뀌었습니다. 새로고침해주세요.";

/**
 * 운영자 결정. '유지'는 결정만 적고 30일 뒤에 다시 본다. '내리기'는 어드민 차단과 같은 길(setStatusWithAudit
 * 'admin.product.ban' — banProduct·감사 내리기와 같다)로 차단하고 결정을 같은 트랜잭션에 적는다.
 * 2단계 판정이 있는 공개 제품만 받는다 — 판정 없이 '내리기'를 누르는 다른 길을 만들지 않는다.
 */
export async function decideRepoReview(input: { slug: string; decision: "keep" | "delist"; by: string }): Promise<RepoReviewOperatorResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: products.id, status: products.status }).from(products)
      .innerJoin(productRepoReviews, eq(productRepoReviews.productId, products.id))
      .where(eq(products.slug, input.slug)).for("update", { of: productRepoReviews });
    if (!row || !["seeded", "verified"].includes(row.status)) return { ok: false, error: STALE };
    if (input.decision === "delist") {
      const banned = await setStatusWithAudit({ id: row.id, slug: input.slug, status: "banned", action: "admin.product.ban" }, tx);
      if (!banned) return { ok: false, error: STALE };
    }
    await tx.update(productRepoReviews).set({
      operatorDecision: input.decision, operatorBy: input.by.slice(0, 120), operatorAt: sql`now()`,
      ...(input.decision === "keep" ? { nextReviewAt: sql`now() + ${OPERATOR_KEEP_DAYS}::int * interval '1 day'` } : {}),
    }).where(eq(productRepoReviews.productId, row.id));
    return { ok: true };
  });
}
