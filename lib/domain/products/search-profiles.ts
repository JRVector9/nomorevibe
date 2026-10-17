import { currentReplayDb } from "@/lib/db/replay-scope";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { prepareTextProfileGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { textProfileInputSchema, textProfileInputHash, textProfileDispatchBindingSchema } from "@/lib/llm/capacity";
import { lockModelCapacityCallerControl, lockTextProfileModelCapacityDispatch,
  finishTextProfileModelCapacityDispatch } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import { assertJobBatchAdmission } from "@/lib/jobs/batch-repository";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products, productSearchProfiles, type Product, type ProductSearchProfile } from "@/lib/db/schema";
import { assertJobLease, assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { PROFILE_MODEL, keywordText, profileEvidence, profileHash } from "./search-profile";
import { isProfileProviderError, MAX_PROFILE_ATTEMPTS as MAX_ATTEMPTS, profileGenerationRetryAllowedSql } from "./search-profile-retry";

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

export async function pendingProfiles(limit: number): Promise<ProfileTask[]> {
  const rows = await db.select({ product: FIELDS, profile: productSearchProfiles, reviewerNote: REVIEWER_NOTE })
    .from(products)
    .leftJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
    .where(and(
      inArray(products.status, ["seeded", "verified"]),
      profileGenerationDueSql(),
    ))
    .orderBy(sql`(${productSearchProfiles.productId} is null) desc,
      (${productSearchProfiles.productId} is null and btrim(${products.description}) = btrim(${products.tagline})) desc,
      ${REFRESH_SINCE}, ${products.id} desc`)
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
      await tx.insert(productSearchProfiles).values({ productId: product.id, sourceHash, errorCode: code, attempts: 1,
        retryAt: providerError ? sql`now() + interval '30 minutes'` : sql`now() + interval '5 minutes'`, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: productSearchProfiles.productId, set: { errorCode: code, updatedAt: sql`now()`,
          attempts: sql`${productSearchProfiles.attempts} + 1`,
          retryAt: providerError ? sql`now() + interval '30 minutes'`
            : sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${productSearchProfiles.attempts}))` } });
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
      const limited = isProfileProviderError(code);
      await tx.update(productSearchProfiles).set({
        verifyError: code,
        updatedAt: sql`now()`,
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
    if (!control.policy?.routes.some(route => route.routeId === "product-search-profile" && route.provider === "abcllm"
      && route.model === PROFILE_MODEL)) throw new ModelCapacityDeferredError("unmapped");
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
      profile: await currentProfileIdentity(tx, product.id), model: PROFILE_MODEL });
    if (reserved && (textProfileInputHash(input) !== textProfileInputHash(reserved.expected)
      || reserved.identity.owner.instanceId !== role.instanceId || reserved.identity.owner.bootId !== role.bootId)) return { kind: "skipped" };
    const call = prepareTextProfileGatewayCall(evidence, { model: PROFILE_MODEL, timeoutMs });
    if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
    if (reserved && (call.wireHash !== reserved.call.wireHash || call.servingContractHash !== reserved.call.servingContractHash
      || call.totalTokenBound !== reserved.call.totalTokenBound || call.model !== reserved.call.model)) return { kind: "skipped" };
    const actualKind = await assertTextRoleWall(tx, role);
    await assertJobLeaseAtWallTime(tx, job, "update");
    const intent = immutableProfileIntent({ task: { product, profile: profile ?? null, reviewerNote }, evidence, input });
    if (!reserved || !lock) return { kind: "ready", intent, call };
    const binding = textProfileDispatchBindingSchema.parse({ kind: "text_profile_gateway", version: 1, ...input,
      inputHash: textProfileInputHash(input), logicalWorkKey: `text:profile:${product.id}`,
      provider: "abcllm", routeId: "product-search-profile", role: { ...boundRole, kind: actualKind }, job,
      wireHash: call.wireHash, servingContractHash: call.servingContractHash,
      totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound });
    const dispatch = await finishTextProfileModelCapacityDispatch(tx, lock, binding);
    await assertTextRoleWall(tx, role);
    await assertJobLeaseAtWallTime(tx, job, "update");
    return { kind: "ready", intent, call, dispatch };
  }));
}
