import { currentReplayDb } from "@/lib/db/replay-scope";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { prepareTextProfileGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { textProfileServingProvider } from "@/lib/llm/text-profile-serving-contract";
import { searchVerifyServingProvider } from "@/lib/llm/search-verify-serving-contract";
import { textProfileInputSchema, textProfileInputHash, textProfileDispatchBindingSchema, type GatewayDispatchProvider } from "@/lib/llm/capacity";
import { lockModelCapacityCallerControl, lockTextProfileModelCapacityDispatch,
  finishTextProfileModelCapacityDispatch, findOwnPendingTextProfileRequests } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { assertRoleLease, RoleLeaseLostError, type RoleLease } from "@/lib/jobs/role-leader";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { searchVerifyMemberSchema, searchVerifyDispatchBindingSchema, searchVerifyGenerationHash, searchVerifyLogicalWorkKey,
  searchVerifyInputHash, searchVerifyStepKeywords } from "@/lib/llm/capacity";
import { lockSearchVerifyModelCapacityDispatch, finishSearchVerifyModelCapacityDispatch, lockSearchVerifyResultChain } from "@/lib/llm/capacity-repository";
import { SEARCH_VERIFY_POLICY_HASH } from "./search-verify";
import { assertJobBatchAdmission } from "@/lib/jobs/batch-repository";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { retryBackoffSql } from "@/lib/db/retry-backoff";
import { products, productSearchProfiles, type Product, type ProductSearchProfile } from "@/lib/db/schema";
import { assertJobLease, assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { keywordText, profileEvidence, profileHash } from "./search-profile";
import { isProfileProviderError, MAX_PROFILE_ATTEMPTS as MAX_ATTEMPTS, profileGenerationRetryAllowedSql } from "./search-profile-retry";
import { busyLogicalKeysSql } from "@/lib/llm/capacity-busy-targets";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";

/**
 * 검색 키워드의 대기열과 저장. 짓는 일(게이트웨이)은 search-profile.ts 에 있다.
 */

const FIELDS = {
  id: products.id, slug: products.slug, name: products.name, url: products.url, category: products.category,
  tagline: products.tagline, description: products.description, status: products.status,
  searchTopics: products.searchTopics, searchPageText: products.searchPageText, searchReadme: products.searchReadme,
};
type ProductFields = Pick<Product, keyof typeof FIELDS>;

/** 감사가 남긴 AI 설명 — 제품이 무엇인지 모델이 읽고 적은 글이라 증거로 함께 준다(공개분 6천여 건에 있다) */
// Keep the outer table qualified: Drizzle unqualifies Column references in single-table selects,
// which would make the subquery compare a.product_id with a.id instead of products.id.
const REVIEWER_NOTE = sql<string | null>`(select a.ai_reason from product_audit_items a
  where a.product_id = products.id and a.ai_reason is not null order by a.id desc limit 1)`;

/** 갱신 대기의 기준 시각 — 메모가 지은 뒤에 바뀌었으면 그 판정 시각, 아니면 마지막으로 손댄 때. 글이 바뀐 때는 기록이 없다 */
const REFRESH_SINCE = sql`case when ${productSearchProfiles.needsRefresh} then greatest(${productSearchProfiles.updatedAt},
  (select a.reviewed_at from product_audit_items a where a.product_id = products.id and a.ai_reason is not null order by a.id desc limit 1))
  else ${productSearchProfiles.updatedAt} end`;

export type ProfileTask = { product: ProductFields; profile: ProductSearchProfile | null; reviewerNote: string | null };

/**
 * 키워드를 지어야 하는 공개 제품.
 *
 * 아직 안 지은 것, 원본이 바뀐 것, 실패 후 재시도할 때가 된 것, 30일 주기 점검 대상.
 * 원본 변경은 DB 트리거로 표시하고 실제 생성 입력 해시가 같으면 모델을 부르지 않는다.
 *
 * 안 지은 것이 먼저이고, 그중에서도 소개가 한 줄뿐인 제품(설명=소개, 공개분의 40%)이 먼저다 —
 * 키워드가 가장 크게 보태는 쪽이다.
 *
 * 이미 지은 것은 마지막으로 손댄 지(updated_at) 오래된 것부터다. 트리거는 updated_at 을 건드리지 않아 그 뒤에 들어온
 * 갱신 요청은 모두 그보다 늦다 — 한 번 처리하면 맨 뒤로 가니 굶는 것이 없다. 전에는 id 큰 것부터라 계속 다시 바뀌는
 * 최근 제품들이 앞을 차지해, 9/24부터 기다린 갱신이 10/08에도 남아 있었다.
 *
 * 단, 감사 메모가 바뀌어 기다리는 것은 그 판정 시각(reviewed_at)부터 센다(REFRESH_SINCE). 감사가 공개분 전체를 다시 돌면
 * (2026-10-14 감사 #4, 시간당 240건) 오래전에 지은 제품이 방금 바뀐 메모로 맨 앞에 끼어들어, 먼저 기다리던 갱신이
 * 감사가 끝날 때까지 밀렸다(2026-10-17 프로드: 27시간 기다린 7786 앞에 방금 감사한 12238, 대기 2,300건).
 */
const profileGenerationDueSql = () => sql`(${productSearchProfiles.productId} is null
        or (${productSearchProfiles.errorCode} is not null
            and ${profileGenerationRetryAllowedSql(productSearchProfiles.errorCode, productSearchProfiles.attempts)}
            and (${productSearchProfiles.retryAt} is null or ${productSearchProfiles.retryAt} <= now()))
        or (${productSearchProfiles.errorCode} is null and (${productSearchProfiles.needsRefresh}
            or ${productSearchProfiles.updatedAt} < now() - interval '30 days')))`;

/**
 * 할 일이 된 시각 — 운영 진척(text-stage-progress.ts keywords·text-progress.ts profile_age)의 식에서 갱신 대기만 REFRESH_SINCE 로
 * 센다. 감사가 공개분을 다시 돌 때 오래전에 지은 제품이 방금 바뀐 메모로 이 줄의 맨 앞에 끼지 않게 한다(위 profileGenerationDueSql 설명의 2026-10-17 사례).
 * 그래서 경보의 가장 오래된 나이는 감사 갱신을 updated_at 부터 세어 이 줄보다 길게 보일 수 있다 — 더 늦게 보지는 않는다.
 */
const READY_SINCE = sql`case when ${productSearchProfiles.productId} is null then ${products.createdAt}
  when ${productSearchProfiles.errorCode} is not null then greatest(${productSearchProfiles.updatedAt}, ${productSearchProfiles.retryAt})
  when ${productSearchProfiles.needsRefresh} then ${REFRESH_SINCE}
  else ${productSearchProfiles.updatedAt} + interval '30 days' end`;
/** 한 묶음에서 오래 기다린 순서로 채우는 몫 — 12건 중 4건 */
const OLDEST_SHARE = 3;

/**
 * 우선순위 줄(안 지은 것 → 한 줄 소개 → 오래된 갱신, 같은 차례면 새 제품)과 오래 기다린 순서 줄을 섞는다.
 *
 * 우선순위 줄만 보면 공개분 1만5천 건이 안 지은 채 기다리는 동안 실패 재시도·갱신은 차례를 얻지 못하고, 안 지은 것 안에서도
 * 새 제품(id 큰 것)이 계속 앞에 서 오래된 제품이 굶었다(2026-10-27 운영: 대기 15,511·upstream_stalled). 몫의 3분의 1은
 * 할 일이 된 시각(READY_SINCE)이 가장 이른 것부터 채운다. 실패한 것은 재시도 시각이 그 시각이 되어 뒤로 가므로 자리를 독점하지 않는다.
 * 결과는 우선순위 둘, 오래 기다린 것 하나 순으로 번갈아 놓는다 — 잡이 둘씩 동시에 부르므로 가장 오래 기다린 것은 둘째 차례에 가고,
 * 틱이 일찍 접혀도 빠지지 않는다. 한 건만 고를 때는 예전처럼 우선순위 줄의 머리다.
 */
export function interleaveProfileTasks<T extends { product: { id: number } }>(oldest: readonly T[], priority: readonly T[], limit: number): T[] {
  const result: T[] = [], seen = new Set<number>();
  const push = (task: T | undefined) => { if (task && !seen.has(task.product.id) && result.length < limit) { seen.add(task.product.id); result.push(task); } };
  for (let o = 0, p = 0; (o < oldest.length || p < priority.length) && result.length < limit;) {
    push(priority[p++]); push(priority[p++]);
    push(oldest[o++]);
  }
  return result;
}

/** 이 프로세스가 줄에 세워 둔 요청을 이어받아 고른 일감 → 그 요청의 장부 이름(순위). 잡이 그 순위를 먼저 부른다(PR B). */
const resumedModels = new WeakMap<ProfileTask, string>();
export const resumedProfileModel = (task: ProfileTask): string | null => resumedModels.get(task) ?? null;

/**
 * ranks: 이 틱의 순위들(장부 이름·provider, 순위 차례) — 순위마다 이 프로세스가 줄에 세워 둔 요청을 먼저 이어받는다(PR B).
 * 순위를 주지 않으면 이어받지 않는다(새 일감만 고른다).
 */
export async function pendingProfiles(limit: number, owner?: Pick<RoleLease, "instanceId" | "bootId">,
  excludedProductIds: readonly number[] = [], ranks: readonly Readonly<{ identity: string; provider: GatewayDispatchProvider }>[] = []): Promise<ProfileTask[]> {
  const own = (owner ? (await Promise.all(ranks.map(async rank => (await findOwnPendingTextProfileRequests({
    owner: { instanceId: owner.instanceId, bootId: owner.bootId }, model: rank.identity, provider: rank.provider })).map(row => ({ ...row, model: rank.identity })))))
    .flat() : [])
    .filter(row => !excludedProductIds.includes(row.productId));
  const resumed = own.length ? await onPrimary(() => db.transaction(async tx => {
    const rows = await tx.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
      .from(products).leftJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
      .where(and(inArray(products.id, own.map(row => row.productId)),
        inArray(products.status, ["seeded", "verified"]), profileGenerationDueSql()));
    const tasks = new Map(rows.map(row => [row.product.id, { product: row.product, profile: row.profile ?? null, reviewerNote: row.reviewerNote }]));
    const selected: ProfileTask[] = [];
    for (const candidate of own) {
      const task = tasks.get(candidate.productId);
      if (!task || selected.some(row => row.product.id === candidate.productId)) continue;
      const input = { productId: task.product.id, slug: task.product.slug,
        evidenceHash: profileHash(profileEvidence(task.product, task.reviewerNote)),
        profile: await currentProfileIdentity(tx, task.product.id), model: candidate.model };
      // An old source/profile snapshot gets no priority and no new authority.
      if (candidate.workKey !== `text:profile:${task.product.id}:${textProfileInputHash(input)}`) continue;
      resumedModels.set(task, candidate.model);
      selected.push(task);
      if (selected.length >= limit) break;
    }
    return selected;
  })) : [];
  if (resumed.length >= limit) return resumed;

  // 요청 장부가 이미 쥔 제품은 새로 집지 않는다(capacity-busy-targets.ts) — 이어받을 내 요청은 위 resumed 가 맡는다.
  // 미확인 요청이 걸린 제품이 맨 앞에 서면 일꾼 하나가 'capacity' 미룸을 받아 틱 전체를 접었다. 한 제품은 한 요청만 가진다.
  const excluded = [...new Set([...excludedProductIds, ...resumed.map(task => task.product.id)].filter(id => Number.isSafeInteger(id) && id > 0))];
  const due = and(inArray(products.status, ["seeded", "verified"]), profileGenerationDueSql(),
    sql`('text:profile:' || ${products.id}) NOT IN (${busyLogicalKeysSql("text:profile:")})`,
    excluded.length ? notInArray(products.id, excluded) : undefined);
  const select = () => db.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
    .from(products).leftJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id)).where(due);
  const room = limit - resumed.length;
  const [priority, oldest] = await Promise.all([
    select().orderBy(sql`(${productSearchProfiles.productId} is null) desc,
      (${productSearchProfiles.productId} is null and btrim(${products.description}) = btrim(${products.tagline})) desc,
      ${REFRESH_SINCE}, ${products.id} desc`).limit(room),
    select().orderBy(sql`${READY_SINCE} asc nulls first`, asc(products.id)).limit(Math.max(1, Math.ceil(room / OLDEST_SHARE))),
  ]);
  const task = (row: (typeof priority)[number]): ProfileTask => ({ product: row.product, profile: row.profile ?? null, reviewerNote: row.reviewerNote });
  return [...resumed, ...interleaveProfileTasks(oldest.map(task), priority.map(task), room)];
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
export async function recordProfileResult(task: ProfileTask, lease: JobLease, result: ProfileResult,
  expected?: ProfileWriteExpectation): Promise<boolean> {
  const capturedExpected = expected === undefined ? undefined : textProfileInputSchema.shape.profile.parse(structuredClone(expected));
  return db.transaction(async (tx) => {
    const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, task.product.id)).for("update");
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return false;
    const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
    const sourceHash = profileHash(profileEvidence(product, reviewerNote));
    if (sourceHash !== profileHash(profileEvidence(task.product, task.reviewerNote))) return false;
    const [current] = await tx.select().from(productSearchProfiles)
      .where(eq(productSearchProfiles.productId, product.id)).for("update");
    if (!sameProfile(current, task.profile)) return false;
    if (capturedExpected && reviewHash(await currentProfileIdentity(tx, product.id)) !== reviewHash(capturedExpected)) return false;

    if (result.kind === "reuse") {
      if (!current || current.errorCode || current.sourceHash !== sourceHash) return false;
      await tx.update(productSearchProfiles).set({ needsRefresh: false, updatedAt: sql`now()` }).where(eq(productSearchProfiles.productId, product.id));
    } else if (result.kind === "success") {
      // 새로 지은 키워드는 다시 검수한다(product-search-verify)
      const values = { keywordsEn: result.en, keywordsKo: result.ko, model: result.model, sourceHash,
        needsRefresh: false, errorCode: null, retryAt: null, updatedAt: sql`now()`, generatedAt: sql`now()`,
        verifiedAt: null, removedKeywords: [], verifyModel: null, verifyAttempts: 0, verifyError: null, verifyRetryAt: null };
      await tx.insert(productSearchProfiles).values({ productId: product.id, ...values, attempts: 1 })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { ...values, attempts: sql`${productSearchProfiles.attempts} + 1` } });
      await tx.update(products).set({ searchKeywords: keywordText(result.en, result.ko) }).where(eq(products.id, product.id));
    } else {
      const code = result.error.slice(0, 60);
      const providerError = isProfileProviderError(code);
      const attempt = code === "tokenizer_unavailable" ? 0 : 1;
      await tx.insert(productSearchProfiles).values({ productId: product.id, sourceHash, errorCode: code, attempts: attempt,
        retryAt: providerError ? sql`now() + interval '30 minutes'` : sql`now() + interval '5 minutes'`, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { errorCode: code, updatedAt: sql`now()`,
          attempts: sql`${productSearchProfiles.attempts} + ${attempt}`,
          retryAt: providerError ? sql`now() + interval '30 minutes'`
            : retryBackoffSql(productSearchProfiles.attempts) } });
    }
    await assertJobLeaseAtWallTime(tx, lease);
    return true;
  });
}

/** 이만큼 검수에 실패하면 손을 뗀다 — 게이트웨이가 막힌 것은 세지 않는다 */
const MAX_VERIFY_ATTEMPTS = 5;
/**
 * 검수할 키워드 — 지은 뒤 아직 검수하지 않은 공개 제품. 오래 기다린 것부터.
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
    .orderBy(productSearchProfiles.updatedAt, products.id)
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
export async function recordVerificationResult(task: ProfileTask, lease: JobLease, result: VerificationResult,
  expectation?: SearchVerifyWriteExpectation): Promise<boolean> {
  if (expectation !== undefined) return writeReservedVerificationResult(task, lease, result, expectation);
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
      const limited = isProfileProviderError(code);
      await tx.update(productSearchProfiles).set({
        verifyError: code,
        updatedAt: sql`now()`,
        verifyAttempts: limited ? productSearchProfiles.verifyAttempts : sql`${productSearchProfiles.verifyAttempts} + 1`,
        verifyRetryAt: limited ? sql`now() + interval '30 minutes'`
          : retryBackoffSql(productSearchProfiles.verifyAttempts),
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
        // Keep the failure cause so the next attempt can select chunked verification.
        await tx.update(productSearchProfiles).set({ verifyAttempts: 0, verifyRetryAt: null, repairVersion: 1,
          sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1`,
        }).where(eq(productSearchProfiles.productId, product.id));
        counts.verificationRetried++;
      }
    });
  }
  return { ...counts, afterId: rows.at(-1)?.product.id ?? options.afterId ?? 0 };
}

export type ProfileWriteExpectation = import("@/lib/llm/capacity").TextProfileInput["profile"];
export type ProfileModelIntent = Readonly<{ task: ProfileTask; evidence: import("./search-profile").ProfileEvidence;
  input: import("@/lib/llm/capacity").TextProfileInput }>;
export type ProfileModelPreparation = { kind: "disabled" } | { kind: "skipped" } | {
  kind: "ready"; intent: ProfileModelIntent; call: import("@/lib/crawl/agent-review-gateway").PreparedTextProfileGatewayCall;
  dispatch?: import("@/lib/llm/capacity").TextProfileModelDispatch;
};
async function currentProfileIdentity(tx: ProductTransaction, productId: number): Promise<ProfileWriteExpectation> {
  const [raw] = await tx.execute<{ row: Record<string, unknown> | null }>(sql`SELECT
    (SELECT to_jsonb(p) FROM product_search_profiles p WHERE p.product_id=${productId}) AS row`);
  if (!raw) throw new Error("profile_identity_unavailable");
  if (raw.row === null) return { kind: "absent" };
  const sourceRevision = raw.row.source_revision, attempts = raw.row.attempts;
  return textProfileInputSchema.shape.profile.parse({ kind: "present", rowIdentityHash: reviewHash(raw.row), sourceRevision, attempts });
}
async function assertTextRoleWall(tx: ProductTransaction, role: RoleLease): Promise<"primary" | "standby"> {
  const [owned] = await tx.execute<{ owned: boolean; kind: "primary" | "standby" }>(sql`SELECT true AS owned, owner_kind AS kind FROM role_leases
    WHERE role='text' AND owner_instance_id=${role.instanceId} AND owner_boot_id=${role.bootId}
      AND owner_release=${role.release} AND epoch=${role.epoch} AND lease_until>clock_timestamp()`);
  if (!owned?.owned || !["primary", "standby"].includes(owned.kind)) throw new Error("role_lease_lost");
  return owned.kind;
}
function immutableProfileIntent<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutableProfileIntent(child);
    Object.freeze(value);
  }
  return value;
}
/** Fixed domain path only. All provider I/O starts after this transaction resolves. */
export async function prepareProfileModelDispatch(task: ProfileTask, lease: JobLease,
  options: { timeoutMs: number; roleLease?: import("@/lib/jobs/role-leader").RoleLease;
    reserved?: { reservation: import("@/lib/llm/capacity").ModelCapacityReservation;
      identity: import("@/lib/llm/capacity").ModelCapacityRequestIdentity;
      expected: import("@/lib/llm/capacity").TextProfileInput;
      call: import("@/lib/crawl/agent-review-gateway").PreparedTextProfileGatewayCall } },
): Promise<ProfileModelPreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const snapshot = structuredClone(task), job = structuredClone(lease), role = options.roleLease && structuredClone(options.roleLease);
  const timeoutMs = options.timeoutMs, reserved = options.reserved && {
    ...structuredClone({ reservation: options.reserved.reservation, identity: options.reserved.identity, expected: options.reserved.expected }),
    call: options.reserved.call,
  };
  if (job.name !== "product-search-profile") throw new Error("invalid_profile_capacity_job");
  return onPrimary(() => db.transaction(async tx => {
    const lock = reserved ? await lockTextProfileModelCapacityDispatch(tx, {
      reservation: reserved.reservation, identity: reserved.identity, productId: snapshot.product.id,
    }) : null;
    if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
    const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
    if (control.mode === "disabled") return { kind: "disabled" };
    if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
    // provider 는 이 선택의 계약이 정한다(PR 3b-E) — 정책 route 도 그 provider 로 매핑돼 있어야 한다
    const model = textTaskModel("product-search-profile"), provider = textProfileServingProvider(model);
    if (!control.policy?.routes.some(route => route.routeId === "product-search-profile" && route.provider === provider
      && route.model === model)) throw new ModelCapacityDeferredError("unmapped");
    if (!role || role.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
    const boundRole = textProfileDispatchBindingSchema.shape.role.parse({ role: role.role, instanceId: role.instanceId,
      bootId: role.bootId, release: role.release, kind: role.kind, epoch: role.epoch,
      batch: role.batchVersion === 1 ? { mode: "versioned", host: role.host, batchEpoch: role.batchEpoch } : { mode: "legacy" },
    });
    await assertJobBatchAdmission(tx, job.name, role);
    await assertRoleLease(tx, role);
    if (!await lockProductGeneration(tx, snapshot.product.id, snapshot.product.slug)) return { kind: "skipped" };
    const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, snapshot.product.id));
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return { kind: "skipped" };
    const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
    const evidence = profileEvidence(product, reviewerNote), evidenceHash = profileHash(evidence);
    if (evidenceHash !== profileHash(profileEvidence(snapshot.product, snapshot.reviewerNote))) return { kind: "skipped" };
    const [profile] = await tx.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id)).for("update");
    if (!sameProfile(profile ?? null, snapshot.profile)) return { kind: "skipped" };
    const [{ due }] = await tx.select({ due: profileGenerationDueSql() }).from(products)
      .leftJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id)).where(eq(products.id, product.id));
    if (!due || profile && !profile.errorCode && profile.sourceHash === evidenceHash
      && (!profile.needsRefresh || profile.keywordsEn.length + profile.keywordsKo.length > 0)) return { kind: "skipped" };
    const input = textProfileInputSchema.parse({ productId: product.id, slug: product.slug, evidenceHash,
      profile: await currentProfileIdentity(tx, product.id), model: textTaskModel("product-search-profile") });
    if (reserved && (textProfileInputHash(input) !== textProfileInputHash(reserved.expected)
      || reserved.identity.owner.instanceId !== role.instanceId || reserved.identity.owner.bootId !== role.bootId)) return { kind: "skipped" };
    const call = prepareTextProfileGatewayCall(evidence, { model, timeoutMs, provider });
    if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
    if (reserved && (call.wireHash !== reserved.call.wireHash || call.servingContractHash !== reserved.call.servingContractHash
      || call.totalTokenBound !== reserved.call.totalTokenBound || call.model !== reserved.call.model || call.provider !== reserved.call.provider
      || reserved.identity.provider !== call.provider)) return { kind: "skipped" };
    const actualKind = await assertTextRoleWall(tx, role);
    await assertJobLeaseAtWallTime(tx, job, "update");
    const intent = immutableProfileIntent({ task: { product, profile: profile ?? null, reviewerNote }, evidence, input });
    if (!reserved || !lock) return { kind: "ready", intent, call };
    const binding = textProfileDispatchBindingSchema.parse({ kind: "text_profile_gateway", version: 1, ...input,
      inputHash: textProfileInputHash(input), logicalWorkKey: `text:profile:${product.id}`,
      provider: call.provider, routeId: "product-search-profile", role: { ...boundRole, kind: actualKind }, job,
      wireHash: call.wireHash, servingContractHash: call.servingContractHash,
      totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound });
    const dispatch = await finishTextProfileModelCapacityDispatch(tx, lock, binding);
    await assertTextRoleWall(tx, role);
    await assertJobLeaseAtWallTime(tx, job, "update");
    return { kind: "ready", intent, call, dispatch };
  }));
}

/** Fixed verifier eligibility: the same predicate as pendingVerifications, read from the locked row. */
const verificationDueSql = () => sql`not ${productSearchProfiles.needsRefresh} and ${productSearchProfiles.errorCode} is null and ${productSearchProfiles.verifiedAt} is null
  and jsonb_array_length(${productSearchProfiles.keywordsEn}) + jsonb_array_length(${productSearchProfiles.keywordsKo}) > 0
  and ${productSearchProfiles.verifyAttempts} < ${MAX_VERIFY_ATTEMPTS}
  and (${productSearchProfiles.verifyRetryAt} is null or ${productSearchProfiles.verifyRetryAt} <= now())`;
export type SearchVerifyWriteExpectation = Readonly<{ kind: "search_verify_write" }>;
type VerifyRole = import("@/lib/llm/capacity").SearchVerifyDispatchBinding["role"];
type VerifyMember = import("@/lib/llm/capacity").SearchVerifyMember;
const verifyWrites = new WeakMap<SearchVerifyWriteExpectation, { job: JobLease; role: VerifyRole; model: string;
  productId: number; member: VerifyMember; used: boolean; execution?: number }>();
/** Binds the one execution whose ledger chain the writer must re-verify. Once only; this is not write authority. */
export function sealSearchVerifyWriteExpectation(expectation: SearchVerifyWriteExpectation, execution: number): void {
  const proof = verifyWrites.get(expectation);
  if (!proof || proof.used || proof.execution !== undefined || !Number.isSafeInteger(execution) || execution < 0)
    throw new Error("invalid_search_verify_write_expectation");
  proof.execution = execution;
}
class SearchVerifyChanged extends Error { constructor() { super("search_verify_input_changed"); } }
export type SearchVerifyPreparation = { kind: "disabled" } | { kind: "skipped" } | { kind: "expired" }
  | { kind: "ready"; member: VerifyMember; role: VerifyRole; expectation: SearchVerifyWriteExpectation }
  | { kind: "ready"; dispatch: import("@/lib/llm/capacity").SearchVerifyModelDispatch };
async function lockVerifyRole(tx: ProductTransaction, lease: RoleLease): Promise<VerifyRole> {
  const [row] = await tx.execute<{ raw: Record<string, unknown> }>(sql`SELECT to_jsonb(r) AS raw FROM role_leases r WHERE role=${lease.role} FOR SHARE`);
  const raw = row?.raw;
  if (!raw || raw.owner_instance_id !== lease.instanceId || raw.owner_boot_id !== lease.bootId || raw.owner_release !== lease.release
    || raw.epoch !== lease.epoch || !["primary", "standby"].includes(String(raw.owner_kind))) throw new RoleLeaseLostError();
  const role = searchVerifyDispatchBindingSchema.shape.role.parse({ role: lease.role, instanceId: lease.instanceId, bootId: lease.bootId,
    release: lease.release, kind: raw.owner_kind, epoch: lease.epoch,
    batch: lease.batchVersion === 1 ? { mode: "versioned", host: lease.host, batchEpoch: lease.batchEpoch } : { mode: "legacy" } });
  await verifyRoleWall(tx, role);
  return role;
}
async function verifyRoleWall(tx: ProductTransaction, role: VerifyRole): Promise<void> {
  const [row] = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM role_leases WHERE role=${role.role}
    AND owner_instance_id=${role.instanceId} AND owner_boot_id=${role.bootId} AND owner_release=${role.release}
    AND owner_kind=${role.kind} AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS live`);
  if (!row?.live) throw new RoleLeaseLostError();
}
async function finalVerifyWall(tx: ProductTransaction, role: VerifyRole, job: JobLease,
  dispatch?: import("@/lib/llm/capacity").SearchVerifyModelDispatch): Promise<void> {
  await assertJobLeaseAtWallTime(tx, job, "update");
  await verifyRoleWall(tx, role);
  if (!dispatch) return;
  const [wall] = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM model_capacity_requests
    WHERE request_id=${dispatch.requestId}::uuid AND token=${dispatch.token}::uuid AND state='dispatched'
      AND owner_instance_id=${dispatch.owner.instanceId} AND owner_boot_id=${dispatch.owner.bootId}::uuid
      AND epoch=${dispatch.epoch} AND revision=${dispatch.revision} AND policy_hash=${dispatch.policyHash}
      AND dispatch_binding_hash=${dispatch.bindingHash} AND dispatch_binding=${JSON.stringify(dispatch.binding)}::text::jsonb
      AND reserved_until>clock_timestamp()) AS live`);
  if (!wall?.live) throw new Error("search_verify_model_reservation_lost");
}
function verificationMember(product: Pick<ProfileTask['product'], 'id' | 'slug'>, current: ProductSearchProfile,
  raw: Record<string, unknown>, evidenceHash: string, keywords: readonly string[], mode: 'full' | 'chunk') {
  return searchVerifyMemberSchema.parse({ productId: product.id, slug: product.slug, evidenceHash,
    profile: { rowIdentityHash: reviewHash(raw), sourceRevision: current.sourceRevision, verifyAttempts: current.verifyAttempts },
    keywordsHash: reviewHash(keywords), keywordCount: mode === 'chunk' ? new Set(keywords).size : keywords.length, mode, policyHash: SEARCH_VERIFY_POLICY_HASH });
}
/** Read-only affinity snapshot, never a writer or dispatch permit. */
export async function readSearchVerifyAffinityMember(task: ProfileTask) {
  return onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
    const [product] = await tx.select({ ...FIELDS, reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, task.product.id));
    const [profile] = await tx.select({ row: productSearchProfiles, raw: sql<Record<string, unknown>>`to_jsonb(${productSearchProfiles})` })
      .from(productSearchProfiles).where(eq(productSearchProfiles.productId, task.product.id));
    if (!product || !profile || !task.profile || !sameProfile(profile.row, task.profile)) return null;
    const evidenceHash = profileHash(profileEvidence(product, product.reviewerNote));
    if (evidenceHash !== profileHash(profileEvidence(task.product, task.reviewerNote))) return null;
    const keywords = [...profile.row.keywordsEn, ...profile.row.keywordsKo];
    const mode = ['invalid_output', 'timeout'].includes(profile.row.verifyError ?? '') ? 'chunk' : 'full';
    return verificationMember(product, profile.row, profile.raw, evidenceHash, keywords, mode);
  }, { accessMode: 'read only', isolationLevel: 'repeatable read' }));
}
type SearchVerifyPreparationOptions = { roleLease: RoleLease; keywords: readonly string[]; mode: "full" | "chunk";
  call?: import("@/lib/crawl/agent-review-gateway").PreparedSearchVerifyGatewayCall;
  reserved?: { reservation: import("@/lib/llm/capacity").ModelCapacityReservation; identity: import("@/lib/llm/capacity").ModelCapacityRequestIdentity;
    input: import("@/lib/llm/capacity").SearchVerifyInput; role: VerifyRole; remainingMs: number } };
/** Initial read and every reserved physical step share these domain checks; only the fixed ledger prefix differs.
 * The shared deadline is fixed at the first step and never reset: a later step past it is expired, not timed out. */
export async function prepareSearchVerifyModelDispatch(task: ProfileTask, lease: JobLease,
  valueOptions: SearchVerifyPreparationOptions): Promise<SearchVerifyPreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const snapshot = structuredClone(task), job = structuredClone(lease), roleLease = structuredClone(valueOptions.roleLease);
  const keywords = z.array(z.string()).min(1).parse(structuredClone(valueOptions.keywords)), mode = valueOptions.mode;
  const reserved = valueOptions.reserved && structuredClone(valueOptions.reserved), call = valueOptions.call;
  if (job.name !== "product-search-verify") throw new Error("invalid_search_verify_capacity_job");
  if (reserved && !call) throw new Error("search_verify_call_required");
  let writer: Parameters<typeof verifyWrites.set>[1] | undefined;
  try {
    const prepared = await onPrimary(() => db.transaction(async (tx): Promise<SearchVerifyPreparation> => {
      const lock = reserved ? await lockSearchVerifyModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
      const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && control.mode === "disabled") return { kind: "disabled" };
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
      const provider = searchVerifyServingProvider(textTaskModel("product-search-verify"));
      if (!control.policy?.routes.some(route => route.routeId === "product-search-verify" && route.provider === provider
        && route.model === textTaskModel("product-search-verify"))) throw new ModelCapacityDeferredError("unmapped");
      if (!roleLease || roleLease.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
      await assertJobBatchAdmission(tx, job.name, roleLease);
      const role = await lockVerifyRole(tx, roleLease);
      if (!await lockProductGeneration(tx, snapshot.product.id, snapshot.product.slug)) throw new SearchVerifyChanged();
      const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, snapshot.product.id));
      if (!product || (product.status !== "seeded" && product.status !== "verified")) throw new SearchVerifyChanged();
      const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
      const evidence = profileEvidence(product, reviewerNote), evidenceHash = profileHash(evidence);
      if (evidenceHash !== profileHash(profileEvidence(snapshot.product, snapshot.reviewerNote))) throw new SearchVerifyChanged();
      const [current] = await tx.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id)).for("update");
      const [state] = await tx.execute<{ row: Record<string, unknown>; due: boolean }>(sql`SELECT to_jsonb(product_search_profiles) AS row,
        (${verificationDueSql()}) AS due FROM product_search_profiles WHERE product_id=${product.id}`);
      if (!current || !state?.due || !snapshot.profile || !sameProfile(current, snapshot.profile)) throw new SearchVerifyChanged();
      const input = [...current.keywordsEn, ...current.keywordsKo];
      if (!isDeepStrictEqual(input, keywords) || mode !== (["invalid_output", "timeout"].includes(current.verifyError ?? "") ? "chunk" : "full"))
        throw new SearchVerifyChanged();
      const member = verificationMember(product, current, state.row, evidenceHash, input, mode);
      const [clock] = await tx.execute<{ now: number }>(sql`SELECT (extract(epoch from clock_timestamp())*1000)::float8 AS now`);
      const nowMs = Math.floor(Number(clock.now));
      if (!reserved) {
        await finalVerifyWall(tx, role, job);
        writer = { job, role, model: textTaskModel("product-search-verify"), productId: product.id, member, used: false };
        return { kind: "ready", member, role, expectation: Object.freeze({ kind: "search_verify_write" as const }) };
      }
      if (!isDeepStrictEqual(member, reserved.input.member) || reserved.input.model !== textTaskModel("product-search-verify") || !isDeepStrictEqual(role, reserved.role)
        || reserved.identity.owner.instanceId !== role.instanceId || reserved.identity.owner.bootId !== role.bootId) throw new SearchVerifyChanged();
      const sent = searchVerifyStepKeywords(mode === "chunk" ? [...new Set(input)] : input, reserved.input.step);
      if (call!.model !== textTaskModel("product-search-verify") || call!.provider !== provider || reserved.identity.provider !== provider
        || call!.evidenceHash !== evidenceHash
        || call!.keywordsHash !== createHash("sha256").update(JSON.stringify(sent)).digest("hex")) throw new SearchVerifyChanged();
      const deadlineAt = lock!.parentDeadlineAt ?? nowMs + Math.max(1, Math.floor(reserved.remainingMs));
      if (nowMs >= deadlineAt) return { kind: "expired" };
      const value = reserved.input;
      const binding = searchVerifyDispatchBindingSchema.parse({ ...value, kind: "search_verify_gateway", version: 1,
        generationHash: searchVerifyGenerationHash(value), logicalWorkKey: searchVerifyLogicalWorkKey(value), inputHash: searchVerifyInputHash(value),
        deadlineAt, provider: call!.provider, routeId: "product-search-verify", wireHash: call!.wireHash, servingContractHash: call!.servingContractHash,
        totalTokenBound: call!.totalTokenBound, chargedTokens: call!.totalTokenBound, job, role });
      const dispatch = await finishSearchVerifyModelCapacityDispatch(tx, lock!, binding);
      await finalVerifyWall(tx, role, job, dispatch);
      return { kind: "ready", dispatch };
    }));
    if (prepared.kind === "ready" && "expectation" in prepared) verifyWrites.set(prepared.expectation, writer!); // only after commit acknowledgement
    return prepared;
  } catch (error) {
    if (error instanceof SearchVerifyChanged) return { kind: "skipped" };
    if (error instanceof Error && error.message === "search_verify_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

/** One-use positive writer: raw profile row CAS (every column and microsecond), current text role and job wall, original attempts/backoff. */
async function writeReservedVerificationResult(value: ProfileTask, job: JobLease, valueResult: VerificationResult,
  expectation: SearchVerifyWriteExpectation): Promise<boolean> {
  const proof = verifyWrites.get(expectation), task = structuredClone(value), lease = structuredClone(job), result = structuredClone(valueResult);
  if (!proof || proof.used || proof.execution === undefined || !isDeepStrictEqual(lease, proof.job) || task.product.id !== proof.productId
    || result.kind === "success" && (result.model !== proof.model || !Array.isArray(result.removed))
    || result.kind === "failure" && typeof result.error !== "string" || !["success", "failure"].includes(result.kind))
    throw new Error("invalid_search_verify_write_expectation");
  proof.used = true;
  const execution = proof.execution;
  return onPrimary(() => db.transaction(async tx => {
    // Stored/returned results are not authority: the settled ledger chain of the sealed execution must produce exactly this result.
    const chain = await lockSearchVerifyResultChain(tx, { member: proof.member, model: proof.model, execution });
    if (!(result.kind === "success" ? chain?.kind === "done" && isDeepStrictEqual([...chain.removed], result.removed)
      : result.error === "invalid_output" ? chain?.kind === "stop" || chain?.kind === "unresolved"
        : result.error === "timeout" ? chain?.kind === "open" || chain?.kind === "unresolved" : chain?.kind === "unresolved")) return false;
    await tx.execute(sql`SELECT role FROM role_leases WHERE role=${proof.role.role} FOR SHARE`);
    await verifyRoleWall(tx, proof.role);
    const [product] = await tx.select(FIELDS).from(products).where(eq(products.id, proof.productId)).for("update");
    if (!product || (product.status !== "seeded" && product.status !== "verified")) return false;
    const [current] = await tx.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id)).for("update");
    const [state] = await tx.execute<{ row: Record<string, unknown> | null }>(sql`SELECT
      (SELECT to_jsonb(p) FROM product_search_profiles p WHERE p.product_id=${product.id}) AS row`);
    if (!current || !state?.row || reviewHash(state.row) !== proof.member.profile.rowIdentityHash) return false;
    const [{ reviewerNote }] = await tx.select({ reviewerNote: REVIEWER_NOTE }).from(products).where(eq(products.id, product.id));
    const sourceHash = profileHash(profileEvidence(product, reviewerNote));
    if (sourceHash !== current.sourceHash) {
      await tx.update(productSearchProfiles).set({ needsRefresh: true,
        sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1`, attempts: 0, errorCode: null, retryAt: null,
      }).where(eq(productSearchProfiles.productId, product.id));
      await finalVerifyWall(tx, proof.role, lease);
      return false;
    }
    if (sourceHash !== proof.member.evidenceHash) return false;
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
      const limited = isProfileProviderError(code);
      await tx.update(productSearchProfiles).set({
        verifyError: code,
        updatedAt: sql`now()`,
        verifyAttempts: limited ? productSearchProfiles.verifyAttempts : sql`${productSearchProfiles.verifyAttempts} + 1`,
        verifyRetryAt: limited ? sql`now() + interval '30 minutes'`
          : retryBackoffSql(productSearchProfiles.verifyAttempts),
      }).where(eq(productSearchProfiles.productId, product.id));
    }
    await finalVerifyWall(tx, proof.role, lease);
    return true;
  }));
}
