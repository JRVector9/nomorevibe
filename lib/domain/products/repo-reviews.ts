import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productHealth, productRepoReviews, products, type ProductRepoReview, type RepoReviewAnswers,
  type RepoReviewDecision } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { repoGone, setStatusWithAudit } from "./repository";

/**
 * 2단계 확인(product_repo_reviews)의 읽기·쓰기 — 잡(product-repo-review)과 어드민 '저장소 사라짐'이 함께 쓴다.
 *
 * 다시 볼 때: keep 은 일주일 뒤, human 은 사흘 뒤(잠깐 죽었거나 막힌 사이트가 돌아오면 저절로 풀린다),
 * delist_candidate 는 운영자를 기다린다. 운영자가 '유지'를 고르면 30일 뒤에 다시 본다.
 * 다시 봐도 운영자 결정은 지우지 않는다 — 운영자 결정보다 새 AI 판정이 keep 이 아니면 다시 줄에 선다(repoReviewOpen).
 */
export const NEXT_REVIEW_DAYS: Record<RepoReviewDecision, number | null> = { keep: 7, human: 3, delist_candidate: null };
export const OPERATOR_KEEP_DAYS = 30;

/** 2단계 대상 — 공개 웹사이트 중 저장소가 사라졌다고 확정된 것(repository.ts repoGone) */
const target = sql`${products.status} in ('seeded', 'verified') and ${products.accessMode} = 'website' and ${repoGone}`;

/**
 * 운영자를 기다리는 것 — AI 가 keep 이 아니라고 했고, 운영자가 아직 안 봤거나 운영자 결정 뒤에 다시 본 것.
 * products 와 product_repo_reviews 를 별칭 없이 조인한 쿼리에서만 쓴다.
 */
export const repoReviewOpen = sql`(${productRepoReviews.decision} <> 'keep'
  and (${productRepoReviews.operatorDecision} is null or ${productRepoReviews.operatorAt} < ${productRepoReviews.reviewedAt}))`;

export type RepoReviewTarget = {
  id: number; slug: string; name: string; tagline: string; description: string; url: string;
  downSince: Date | null;
};

/** 이번에 볼 것 — 아직 안 본 것 먼저, 그다음 다시 볼 때가 지난 것. 운영자가 내린 것은 공개가 아니라 빠진다 */
export async function dueRepoReviews(limit: number): Promise<RepoReviewTarget[]> {
  const due = sql`(${productRepoReviews.productId} is null or ${productRepoReviews.nextReviewAt} <= now())`;
  return db.select({
    id: products.id, slug: products.slug, name: products.name, tagline: products.tagline, description: products.description,
    url: products.url, downSince: productHealth.downSince,
  }).from(products)
    .leftJoin(productRepoReviews, eq(productRepoReviews.productId, products.id))
    .leftJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(and(target, due, sql`${productRepoReviews.operatorDecision} is distinct from 'delist'`))
    .orderBy(sql`(${productRepoReviews.productId} is null) desc`, sql`${productRepoReviews.nextReviewAt} asc nulls first`, products.id)
    .limit(limit);
}

export type RepoReviewRecord = {
  productId: number; decision: RepoReviewDecision; reason: string; answers: RepoReviewAnswers | null; model: string | null;
  pageHttpStatus: number | null; finalUrl: string | null; pageTitle: string | null; pageExcerpt: string | null;
};

/** 판정을 적는다. 운영자 결정 칸은 건드리지 않는다 */
export async function saveRepoReview(record: RepoReviewRecord, lease?: JobLease): Promise<void> {
  const days = NEXT_REVIEW_DAYS[record.decision];
  const nextReviewAt = days === null ? null : sql`now() + ${days}::int * interval '1 day'`;
  const values = {
    decision: record.decision, reason: record.reason.slice(0, 40), answers: record.answers,
    model: record.model?.slice(0, 80) ?? null, pageHttpStatus: record.pageHttpStatus, finalUrl: record.finalUrl,
    pageTitle: record.pageTitle?.slice(0, 300) ?? null, pageExcerpt: record.pageExcerpt?.slice(0, 600) ?? null, nextReviewAt,
  };
  await withJobLeaseWrite(lease, (tx) => tx.insert(productRepoReviews).values({ productId: record.productId, ...values })
    .onConflictDoUpdate({ target: productRepoReviews.productId, set: { ...values, reviewedAt: sql`now()` } }));
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
