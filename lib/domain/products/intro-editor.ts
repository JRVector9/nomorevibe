import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productIntroChecks, products, productSearchProfiles, type IntroVerdict } from "@/lib/db/schema";
import { lockProductGeneration } from "./generation";
import { LIMITS } from "./schema";

/**
 * 관리자 '소개 확인 필요'(검수 outcome = needs_editor)의 읽기와 '그대로 두기'(2026-10-08 UX 감사 ADM-23).
 * 검수 잡의 대기열·저장은 intro-checks.ts 에 있다.
 */

export type IntroEditorNote = { verdict: IntroVerdict | null; problem: string };

/** 줄마다 검수가 왜 사람에게 넘겼는지 — 지금 소개를 검수한 행만(소개가 바뀌었으면 목록에서 이미 빠진다) */
export async function introEditorNotes(productIds: readonly number[]): Promise<Map<number, IntroEditorNote>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.select({ productId: productIntroChecks.productId, verdict: productIntroChecks.verdict, problem: productIntroChecks.problem })
    .from(productIntroChecks)
    .where(and(inArray(productIntroChecks.productId, [...productIds]), eq(productIntroChecks.outcome, "needs_editor")));
  return new Map(rows.map((row) => [row.productId, { verdict: row.verdict, problem: row.problem }]));
}

/**
 * 그대로 두기 — 사람이 지금 소개를 보고 두기로 했다. 검수 결과를 kept 로 바꿔 '소개 확인 필요'에서 뺀다.
 * 판정(verdict)·사유(problem)는 남긴다 — AI 가 둔 것(verdict ok)과 사람이 둔 것을 가를 수 있다.
 * 검수 잡은 소개가 그대로면 다시 보지 않고(pendingIntroChecks), 그 사이 이 행을 읽어 둔 잡은 updated_at 이 달라져
 * 적지 않는다(recordIntroCheck sameCheck). 소개가 그 사이 바뀌었거나 이미 처리했으면 false.
 */
export async function keepIntro(slug: string): Promise<boolean> {
  const updated = await db.update(productIntroChecks)
    .set({ outcome: "kept", updatedAt: sql`now()` })
    .from(products)
    .where(and(eq(products.slug, slug), eq(productIntroChecks.productId, products.id), eq(productIntroChecks.outcome, "needs_editor"),
      eq(productIntroChecks.checkedTagline, products.tagline)))
    .returning({ productId: productIntroChecks.productId });
  return updated.length === 1;
}

/**
 * 소개 고치기 — 사람이 지금 소개 대신 새 한 줄을 적는다(ADM-23). 출처는 editor 라 검수 잡이 다시 보지 않는다
 * (pendingIntroChecks 는 AI 가 쓴 소개만 본다). 검수 잡이 고쳐 쓸 때(intro-checks.ts recordIntroCheck)처럼 검색 키워드를 비우고
 * 검색 프로필을 지워 새 소개로 다시 짓게 하고, 소개와 같은 글이던 설명도 함께 바꾼다. 메이커 수정(repository.ts update)처럼
 * 제품 세대를 잠근다. 검수 행은 그대로 둔다 — 소개가 바뀌어 '소개 확인 필요'(checked_tagline = tagline)에서 저절로 빠진다.
 * 그 사이 소개가 바뀌었거나 이미 처리했으면 null, 고쳤으면 고치기 전 소개.
 */
export async function editIntro(slug: string, line: string): Promise<{ before: string } | null> {
  const tagline = line.trim();
  if (!tagline || tagline.length > LIMITS.tagline) return null;
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id, tagline: products.tagline, description: products.description, status: products.status })
      .from(products).where(eq(products.slug, slug));
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return null;
    if (!(await lockProductGeneration(tx, product.id, slug))) return null;
    const [check] = await tx.select({ outcome: productIntroChecks.outcome, checkedTagline: productIntroChecks.checkedTagline })
      .from(productIntroChecks).where(eq(productIntroChecks.productId, product.id)).for("update");
    const [locked] = await tx.select({ tagline: products.tagline, description: products.description }).from(products).where(eq(products.id, product.id));
    if (!check || check.outcome !== "needs_editor" || check.checkedTagline !== locked.tagline) return null;
    const sameText = locked.description.trim() === locked.tagline.trim();
    await tx.update(products).set({ tagline, taglineSource: "editor", searchKeywords: null, ...(sameText ? { description: tagline } : {}),
      updatedAt: sql`now()` }).where(eq(products.id, product.id));
    await tx.delete(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id));
    return { before: locked.tagline };
  });
}
