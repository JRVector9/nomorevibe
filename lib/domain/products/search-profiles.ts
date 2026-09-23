import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productSearchProfiles, type Product, type ProductSearchProfile } from "@/lib/db/schema";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { keywordText, profileEvidence, profileHash } from "./search-profile";

/**
 * 검색 키워드의 대기열과 저장. 짓는 일(게이트웨이)은 search-profile.ts 에 있다.
 */

/** 이만큼 실패하면 손을 뗀다 */
const MAX_ATTEMPTS = 5;

const FIELDS = {
  id: products.id, slug: products.slug, name: products.name, url: products.url, category: products.category,
  tagline: products.tagline, description: products.description, status: products.status,
  searchTopics: products.searchTopics, searchPageText: products.searchPageText, searchReadme: products.searchReadme,
};
type ProductFields = Pick<Product, keyof typeof FIELDS>;

/** 감사가 남긴 AI 설명 — 제품이 무엇인지 모델이 읽고 적은 글이라 증거로 함께 준다(공개분 6천여 건에 있다) */
const REVIEWER_NOTE = sql<string | null>`(select a.ai_reason from product_audit_items a
  where a.product_id = ${products.id} and a.ai_reason is not null order by a.id desc limit 1)`;

export type ProfileTask = { product: ProductFields; profile: ProductSearchProfile | null; reviewerNote: string | null };

/**
 * 키워드를 지어야 하는 공개 제품.
 *
 * 아직 안 지은 것, 실패가 다시 볼 때가 된 것, 지은 지 30일이 지난 것(글이 바뀌었는지 해시로 본다).
 * 30일을 두는 것은 동적 페이지 때문이다 — 날짜·숫자가 매번 바뀌는 페이지를 바뀔 때마다 다시 지으면
 * 게이트웨이를 헛돌린다.
 *
 * 안 지은 것이 먼저이고, 그중에서도 소개가 한 줄뿐인 제품(설명=소개, 공개분의 40%)이 먼저다 —
 * 키워드가 가장 크게 보태는 쪽이다.
 */
export async function pendingProfiles(limit: number): Promise<ProfileTask[]> {
  const rows = await db.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
    .from(products)
    .leftJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
    .where(and(
      inArray(products.status, ["seeded", "verified"]),
      sql`(${productSearchProfiles.productId} is null
        or (${productSearchProfiles.errorCode} is not null and ${productSearchProfiles.attempts} < ${MAX_ATTEMPTS}
            and (${productSearchProfiles.retryAt} is null or ${productSearchProfiles.retryAt} <= now()))
        or (${productSearchProfiles.errorCode} is null and ${productSearchProfiles.updatedAt} < now() - interval '30 days'))`,
    ))
    .orderBy(sql`(${productSearchProfiles.productId} is null) desc,
      (btrim(${products.description}) = btrim(${products.tagline})) desc, ${products.id} desc`)
    .limit(limit);
  return rows.map((row) => ({ product: row.product, profile: row.profile ?? null, reviewerNote: row.reviewerNote }));
}

export type ProfileResult =
  | { kind: "reuse" }
  | { kind: "success"; en: string[]; ko: string[]; model: string }
  | { kind: "failure"; error: string };

const sameProfile = (a: ProductSearchProfile | null | undefined, b: ProductSearchProfile | null) =>
  (a ?? null) === null ? b === null : b !== null && a!.updatedAt.getTime() === b.updatedAt.getTime();

/**
 * 결과를 남긴다 — 한 트랜잭션에서 원본 키워드와 색인용 사본(products.search_keywords)을 같이 적는다.
 *
 * 그사이 제품 글이 바뀌었거나(메이커 수정·재수집), 다른 워커가 먼저 적었거나, 이 잡의 리스를 잃었으면
 * 아무것도 적지 않는다. 리스 확인은 맨 마지막이다 — 잃었으면 적은 것 전부가 되돌려진다.
 */
export async function recordProfileResult(task: ProfileTask, lease: JobLease, result: ProfileResult): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, task.product.id)).for("update");
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return false;
    const sourceHash = profileHash(profileEvidence(product, task.reviewerNote));
    if (sourceHash !== profileHash(profileEvidence(task.product, task.reviewerNote))) return false;
    const [current] = await tx.select().from(productSearchProfiles)
      .where(eq(productSearchProfiles.productId, product.id)).for("update");
    if (!sameProfile(current, task.profile)) return false;

    if (result.kind === "reuse") {
      if (!current || current.errorCode || current.sourceHash !== sourceHash) return false;
      await tx.update(productSearchProfiles).set({ updatedAt: sql`now()` }).where(eq(productSearchProfiles.productId, product.id));
    } else if (result.kind === "success") {
      const values = { keywordsEn: result.en, keywordsKo: result.ko, model: result.model, sourceHash,
        errorCode: null, retryAt: null, updatedAt: sql`now()` };
      await tx.insert(productSearchProfiles).values({ productId: product.id, ...values, attempts: 1 })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { ...values, attempts: sql`${productSearchProfiles.attempts} + 1` } });
      await tx.update(products).set({ searchKeywords: keywordText(result.en, result.ko) }).where(eq(products.id, product.id));
    } else {
      const code = result.error.slice(0, 60);
      await tx.insert(productSearchProfiles).values({ productId: product.id, sourceHash, errorCode: code, attempts: 1,
        retryAt: sql`now() + interval '5 minutes'`, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { sourceHash, errorCode: code, updatedAt: sql`now()`,
          attempts: sql`${productSearchProfiles.attempts} + 1`,
          retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${productSearchProfiles.attempts}))` } });
    }
    await assertJobLease(tx, lease);
    return true;
  });
}
