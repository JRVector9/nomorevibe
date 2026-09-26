import { and, eq, gt, inArray, sql } from "drizzle-orm";
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
 * 아직 안 지은 것, 원본이 바뀐 것, 실패 후 재시도할 때가 된 것, 30일 주기 점검 대상.
 * 원본 변경은 DB 트리거로 표시하고 실제 생성 입력 해시가 같으면 모델을 부르지 않는다.
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
        or (${productSearchProfiles.errorCode} is null and (${productSearchProfiles.needsRefresh}
            or ${productSearchProfiles.updatedAt} < now() - interval '30 days')))`,
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
  (a ?? null) === null ? b === null : b !== null && a!.updatedAt.getTime() === b.updatedAt.getTime() && a!.sourceRevision === b.sourceRevision;

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
    const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
    const sourceHash = profileHash(profileEvidence(product, reviewerNote));
    if (sourceHash !== profileHash(profileEvidence(task.product, task.reviewerNote))) return false;
    const [current] = await tx.select().from(productSearchProfiles)
      .where(eq(productSearchProfiles.productId, product.id)).for("update");
    if (!sameProfile(current, task.profile)) return false;

    if (result.kind === "reuse") {
      if (!current || current.errorCode || current.sourceHash !== sourceHash) return false;
      await tx.update(productSearchProfiles).set({ needsRefresh: false, updatedAt: sql`now()` }).where(eq(productSearchProfiles.productId, product.id));
    } else if (result.kind === "success") {
      // 새로 지은 키워드는 다시 검수한다(product-search-verify)
      const values = { keywordsEn: result.en, keywordsKo: result.ko, model: result.model, sourceHash,
        needsRefresh: false, errorCode: null, retryAt: null, updatedAt: sql`now()`,
        verifiedAt: null, removedKeywords: [], verifyModel: null, verifyAttempts: 0, verifyError: null, verifyRetryAt: null };
      await tx.insert(productSearchProfiles).values({ productId: product.id, ...values, attempts: 1 })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { ...values, attempts: sql`${productSearchProfiles.attempts} + 1` } });
      await tx.update(products).set({ searchKeywords: keywordText(result.en, result.ko) }).where(eq(products.id, product.id));
    } else {
      const code = result.error.slice(0, 60);
      await tx.insert(productSearchProfiles).values({ productId: product.id, sourceHash, errorCode: code, attempts: 1,
        retryAt: sql`now() + interval '5 minutes'`, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { errorCode: code, updatedAt: sql`now()`,
          attempts: sql`${productSearchProfiles.attempts} + 1`,
          retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${productSearchProfiles.attempts}))` } });
    }
    await assertJobLease(tx, lease);
    return true;
  });
}

/** 이만큼 검수에 실패하면 손을 뗀다 — 게이트웨이가 막힌 것은 세지 않는다 */
const MAX_VERIFY_ATTEMPTS = 5;
/** 이 제품 탓이 아닌 실패 — 한도, 모델이 내려감(supa 는 한 번에 한 모델만 띄운다), 연결, 키 없음 */
const NOT_PRODUCT_FAULT = new Set(["rate_limited", "rate_limit", "model_unavailable", "network", "no_key"]);

/**
 * 검수할 키워드 — 지은 뒤 아직 검수하지 않은 공개 제품. 최신 것부터.
 * 키워드가 하나도 없는 것은 검수할 것이 없다.
 */
export async function pendingVerifications(limit: number): Promise<ProfileTask[]> {
  const rows = await db.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
    .from(products)
    .innerJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
    .where(and(
      inArray(products.status, ["seeded", "verified"]),
      sql`not ${productSearchProfiles.needsRefresh} and ${productSearchProfiles.errorCode} is null and ${productSearchProfiles.verifiedAt} is null
        and jsonb_array_length(${productSearchProfiles.keywordsEn}) + jsonb_array_length(${productSearchProfiles.keywordsKo}) > 0
        and ${productSearchProfiles.verifyAttempts} < ${MAX_VERIFY_ATTEMPTS}
        and (${productSearchProfiles.verifyRetryAt} is null or ${productSearchProfiles.verifyRetryAt} <= now())`,
    ))
    .orderBy(sql`${products.id} desc`)
    .limit(limit);
  return rows.map((row) => ({ product: row.product, profile: row.profile, reviewerNote: row.reviewerNote }));
}

export type VerificationResult =
  | { kind: "success"; removed: string[]; model: string }
  | { kind: "failure"; error: string };

/**
 * 검수 결과를 남긴다 — 원본 키워드는 두고, 뺀 키워드를 적고, 색인용 사본(products.search_keywords)에서 뺀다.
 *
 * 그사이 키워드를 다시 지었거나(원본이 바뀌어 옛 키워드에 대한 검수다), 다른 워커가 먼저 적었거나,
 * 이 잡의 리스를 잃었으면 아무것도 적지 않는다. 리스 확인은 맨 마지막이다.
 */
export async function recordVerificationResult(task: ProfileTask, lease: JobLease, result: VerificationResult): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, task.product.id)).for("update");
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return false;
    const [current] = await tx.select().from(productSearchProfiles)
      .where(eq(productSearchProfiles.productId, product.id)).for("update");
    if (!current || !task.profile || !sameProfile(current, task.profile) || current.needsRefresh || current.errorCode || current.verifiedAt) return false;
    const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
    const sourceHash = profileHash(profileEvidence(product, reviewerNote));
    if (sourceHash !== current.sourceHash) {
      await tx.update(productSearchProfiles).set({ needsRefresh: true,
        sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1`, attempts: 0, errorCode: null, retryAt: null,
      }).where(eq(productSearchProfiles.productId, product.id));
      await assertJobLease(tx, lease);
      return false;
    }
    if (sourceHash !== profileHash(profileEvidence(task.product, task.reviewerNote))) return false;

    if (result.kind === "success") {
      const removed = new Set(result.removed);
      await tx.update(productSearchProfiles).set({
        verifiedAt: sql`now()`, removedKeywords: [...removed], verifyModel: result.model,
        verifyError: null, verifyRetryAt: null, verifyAttempts: sql`${productSearchProfiles.verifyAttempts} + 1`,
      }).where(eq(productSearchProfiles.productId, product.id));
      await tx.update(products).set({
        searchKeywords: keywordText(current.keywordsEn.filter((k) => !removed.has(k)), current.keywordsKo.filter((k) => !removed.has(k))),
      }).where(eq(products.id, product.id));
    } else {
      const code = result.error.slice(0, 60);
      // 게이트웨이가 막힌 것은 이 제품 탓이 아니다 — 세지 않고 오래 쉰다
      const limited = NOT_PRODUCT_FAULT.has(code);
      await tx.update(productSearchProfiles).set({
        verifyError: code,
        verifyAttempts: limited ? productSearchProfiles.verifyAttempts : sql`${productSearchProfiles.verifyAttempts} + 1`,
        verifyRetryAt: limited ? sql`now() + interval '30 minutes'`
          : sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${productSearchProfiles.verifyAttempts}))`,
      }).where(eq(productSearchProfiles.productId, product.id));
    }
    await assertJobLease(tx, lease);
    return true;
  });
}

/** 기존 데이터 복구. 해시를 덮지 않고 실제 생성/검수 대기열에 넣는다. 기본은 읽기 전용. */
export async function reconcileSearchProfileBatch(options: {
  afterId?: number; limit?: number; apply?: boolean; retryInvalidOutput?: boolean; retryEmpty?: boolean;
}) {
  const rows = await db.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
    .from(products).innerJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
    .where(and(inArray(products.status, ["seeded", "verified"]), gt(products.id, options.afterId ?? 0)))
    .orderBy(products.id).limit(Math.max(1, Math.min(500, options.limit ?? 250)));
  const counts = { scanned: rows.length, mismatched: 0, alreadyPending: 0, queued: 0, verificationRetried: 0 };
  const classify = (product: ProductFields, profile: ProductSearchProfile, reviewerNote: string | null) => {
    const mismatch = profile.sourceHash !== profileHash(profileEvidence(product, reviewerNote));
    const retryGeneration = profile.repairVersion < 1 && options.retryInvalidOutput && profile.errorCode === "invalid_output" && profile.attempts >= MAX_ATTEMPTS;
    const retryEmpty = profile.repairVersion < 1 && options.retryEmpty && !profile.errorCode && profile.keywordsEn.length + profile.keywordsKo.length === 0;
    const refresh = mismatch || retryGeneration || retryEmpty;
    const retryVerification = profile.repairVersion < 1 && !refresh && !profile.needsRefresh && options.retryInvalidOutput
      && profile.verifyError === "invalid_output" && profile.verifyAttempts >= MAX_VERIFY_ATTEMPTS;
    return { mismatch, refresh, retryGeneration, retryEmpty, retryVerification };
  };
  for (const row of rows) {
    const reason = classify(row.product, row.profile, row.reviewerNote);
    if (reason.mismatch) counts.mismatched++;
    if (row.profile.needsRefresh && !reason.retryGeneration) { counts.alreadyPending++; continue; }
    if (!reason.refresh && !reason.retryVerification) continue;
    if (!options.apply) {
      if (reason.refresh) counts.queued++;
      if (reason.retryVerification) counts.verificationRetried++;
      continue;
    }
    await db.transaction(async (tx) => {
      const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, row.product.id)).for("update");
      if (!product || !["seeded", "verified"].includes(product.status)) return;
      const [profile] = await tx.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id)).for("update");
      if (!profile) return;
      const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
      const latest = classify(product, profile, reviewerNote);
      if (profile.needsRefresh && !latest.retryGeneration) return;
      if (latest.refresh) {
        await tx.update(productSearchProfiles).set({ needsRefresh: true,
          sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1`, attempts: 0, errorCode: null, retryAt: null,
          ...(latest.retryGeneration || latest.retryEmpty ? { repairVersion: 1 } : {}),
        }).where(eq(productSearchProfiles.productId, product.id));
        counts.queued++;
      } else if (latest.retryVerification) {
        await tx.update(productSearchProfiles).set({ verifyAttempts: 0, verifyError: null, verifyRetryAt: null, repairVersion: 1,
          sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1`,
        }).where(eq(productSearchProfiles.productId, product.id));
        counts.verificationRetried++;
      }
    });
  }
  return { ...counts, afterId: rows.at(-1)?.product.id ?? options.afterId ?? 0 };
}
