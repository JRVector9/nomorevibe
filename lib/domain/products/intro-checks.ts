import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productIntroChecks, products, productSearchProfiles, type Product, type ProductIntroCheck } from "@/lib/db/schema";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { decideIntro, type IntroJudgement } from "./intro-check";

/**
 * 소개 검수의 대기열과 저장. 묻는 일(claude-cli)은 intro-check.ts 에 있다.
 */

/** 이만큼 실패하면 손을 뗀다 — 한도에 걸린 것은 세지 않는다 */
const MAX_ATTEMPTS = 5;
const AI_SOURCES = ["ai_page", "ai_readme", "ai_both"] as const;

const FIELDS = {
  id: products.id, slug: products.slug, name: products.name, url: products.url, tagline: products.tagline,
  taglineSource: products.taglineSource, description: products.description, status: products.status,
  searchTopics: products.searchTopics, searchPageText: products.searchPageText, searchReadme: products.searchReadme,
};
type ProductFields = Pick<Product, keyof typeof FIELDS>;

/**
 * 쓸모없어 보이는 메이커 소개 — 레포 경로, 15자 미만("None"·"description"), 이름 그대로, 자리표시.
 * 공개분 275건(2026-09-24). 짧아도 멀쩡한 것("Todo task app")은 검수가 "맞음"으로 둔다.
 */
const MAKER_JUNK = sql`(btrim(${products.tagline}) ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  or length(btrim(${products.tagline})) < 15
  or lower(btrim(${products.tagline})) = lower(btrim(${products.name}))
  or ${products.tagline} ~ '(^|\\s)(Redirecting|Loading|Untitled|Home|Vite \\+ React|React App|Document)(\\s|$|\\.)')`;

export type IntroTask = { product: ProductFields; check: ProductIntroCheck | null };

/** AI 가 지은 소개인지, 메이커가 적은 소개인지 — 무엇을 바꿔도 되는지가 다르다(decideIntro) */
export const introOrigin = (source: ProductFields["taglineSource"]): "ai" | "maker" => source === "maker" ? "maker" : "ai";

/**
 * 검수할 소개 — 주인 없는 공개 수집 제품의 AI 소개와 쓸모없어 보이는 메이커 소개. 최신 것부터 — 새로 발행된
 * 것이 먼저 검수를 받는다. 아직 안 본 것, 소개가 바뀐 것, 실패가 다시 볼 때가 된 것.
 * 검수가 고쳐 쓴 소개(ai_fixed)와 사람이 적은 소개(editor)는 다시 보지 않는다.
 */
export async function pendingIntroChecks(limit: number): Promise<IntroTask[]> {
  const rows = await db.select({ product: FIELDS, check: productIntroChecks })
    .from(products)
    .leftJoin(productIntroChecks, eq(productIntroChecks.productId, products.id))
    .where(and(
      inArray(products.status, ["seeded", "verified"]),
      eq(products.source, "crawler"),
      isNull(products.claimedAt),
      sql`(${inArray(products.taglineSource, [...AI_SOURCES])} or (${products.taglineSource} = 'maker' and ${MAKER_JUNK}))`,
      sql`(${productIntroChecks.productId} is null
        or ${productIntroChecks.checkedTagline} <> ${products.tagline}
        or (${productIntroChecks.errorCode} is not null and ${productIntroChecks.attempts} < ${MAX_ATTEMPTS}
            and (${productIntroChecks.retryAt} is null or ${productIntroChecks.retryAt} <= now())))`,
    ))
    .orderBy(sql`${products.id} desc`)
    .limit(limit);
  return rows.map((row) => ({ product: row.product, check: row.check ?? null }));
}

export type IntroCheckRecord =
  | { kind: "success"; judgement: IntroJudgement; model: string }
  | { kind: "failure"; error: string };

const sameCheck = (a: ProductIntroCheck | undefined, b: ProductIntroCheck | null) =>
  (a ?? null) === null ? b === null : b !== null && a!.updatedAt.getTime() === b.updatedAt.getTime();

/**
 * 검수 결과를 남기고, 바꾸기로 했으면 한 트랜잭션에서 소개를 바꾼다.
 *
 * 바꿀 때 원래 소개·출처·설명을 검수 행에 남긴다. 설명이 소개와 같았으면(소개 말고는 글이 없던 제품) 설명도
 * 같이 바꾼다. 그 제품의 검색 키워드는 지운다 — 틀린 소개를 보고 지은 것이라 키워드 잡이 새 소개로 다시 짓는다.
 *
 * 그사이 소개·설명·출처가 바뀌었거나, 주인이 생겼거나, 다른 워커가 먼저 적었거나, 이 잡의 리스를 잃었으면
 * 아무것도 적지 않는다. 리스 확인은 맨 마지막이다.
 */
export async function recordIntroCheck(task: IntroTask, lease: JobLease, result: IntroCheckRecord): Promise<IntroCheckRecordOutcome> {
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ ...FIELDS, source: products.source, claimedAt: products.claimedAt })
      .from(products).where(eq(products.id, task.product.id)).for("update");
    if (!product || (product.status !== "seeded" && product.status !== "verified") || product.source !== "crawler"
      || product.claimedAt || product.tagline !== task.product.tagline || product.taglineSource !== task.product.taglineSource
      || product.description !== task.product.description) return null;
    const [current] = await tx.select().from(productIntroChecks)
      .where(eq(productIntroChecks.productId, product.id)).for("update");
    if (!sameCheck(current, task.check)) return null;

    if (result.kind === "failure") {
      const code = result.error.slice(0, 60);
      // 한도에 걸린 것은 이 제품 탓이 아니다 — 세지 않고 오래 쉰다. 소개가 바뀐 뒤의 실패는 처음부터 센다
      const limited = code === "rate_limited";
      const fresh = !current || current.checkedTagline !== product.tagline;
      const attempts = limited ? (fresh ? 0 : current!.attempts) : (fresh ? 1 : current!.attempts + 1);
      // 5분에서 두 배씩, 하루까지
      const minutes = limited ? 30 : Math.min(24 * 60, 5 * 2 ** (attempts - 1));
      const values = { checkedTagline: product.tagline, errorCode: code, attempts, updatedAt: sql`now()`,
        retryAt: sql`now() + ${sql.raw(`interval '${minutes} minutes'`)}` };
      await tx.insert(productIntroChecks).values({ productId: product.id, ...values })
        .onConflictDoUpdate({ target: productIntroChecks.productId, set: values });
      await assertJobLease(tx, lease);
      return "failed";
    }

    const { outcome, line } = decideIntro(introOrigin(product.taglineSource), result.judgement, product);
    const replaced = outcome === "replaced";
    const values = {
      checkedTagline: product.tagline, verdict: result.judgement.verdict, problem: result.judgement.problem,
      corrected: line, outcome, model: result.model, attempts: 0, errorCode: null, retryAt: null, updatedAt: sql`now()`,
      originalTagline: replaced ? product.tagline : null, originalSource: replaced ? product.taglineSource : null,
      originalDescription: replaced ? product.description : null,
    };
    await tx.insert(productIntroChecks).values({ productId: product.id, ...values })
      .onConflictDoUpdate({ target: productIntroChecks.productId, set: values });
    if (replaced) {
      const sameText = product.description.trim() === product.tagline.trim();
      await tx.update(products).set({ tagline: line, taglineSource: "ai_fixed", searchKeywords: null, ...(sameText ? { description: line } : {}),
        updatedAt: sql`now()` }).where(eq(products.id, product.id));
      await tx.delete(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id));
    }
    await assertJobLease(tx, lease);
    return outcome;
  });
}

export type IntroCheckRecordOutcome = "kept" | "replaced" | "needs_editor" | "failed" | null;
