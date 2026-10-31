import { scopedModel } from "@/lib/llm/model-registry";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { productIntroChecks, products, productTranslations, takedownRequests,
  type ProductTranslation, type ProductTranslationField, type ProductTranslationLocale } from "@/lib/db/schema";
import { isLocale, type Locale } from "@/lib/i18n/locales";
import { assertJobLease, requestJob, type JobLease } from "@/lib/jobs/control";
import { assertJobLeaseAtWallTime } from "@/lib/jobs/control";
import { JobLeaseLostError, STALE_LOCK_MS } from "@/lib/jobs/lease";
import { RoleLeaseLostError, type RoleLease } from "@/lib/jobs/role-leader";
import { assertJobBatchAdmission } from "@/lib/jobs/batch-repository";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { PRODUCT_TRANSLATE_MODEL } from "@/lib/crawl/translate";
import type { PreparedProductTranslationGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { lockProductGeneration } from "./generation";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { productTranslationInputSchema, productTranslationDispatchBindingSchema, productTranslationInputHash,
  productTranslationLogicalWorkKey, type ProductTranslationMember, type ProductTranslationDispatchBinding,
  type ModelCapacityReservation, type ModelCapacityRequestIdentity, type ProductTranslationModelDispatch } from "@/lib/llm/capacity";
import { lockModelCapacityCallerControl, lockProductTranslationModelCapacityDispatch,
  finishProductTranslationModelCapacityDispatch } from "@/lib/llm/capacity-repository";
import { busyMemberKeysSql, capacityOwnerFromEnv, type CapacityOwner } from "@/lib/llm/capacity-busy-targets";
import { detectTranslationSourceLocale, isProductTranslationField, productTranslationSourceHash, translationSourceText,
  PRODUCT_TRANSLATION_POLICY, productTranslationPolicy,
  type ProductTranslationReadiness, type ProductTranslationSource } from "./translation-policy";

export { selectProductTranslation, productTranslationSourceHash, detectTranslationSourceLocale } from "./translation-policy";
export type { ProductTranslationSource, ProductTranslationSelection } from "./translation-policy";
export type { ProductTranslation, ProductTranslationField } from "@/lib/db/schema";
export const PRODUCT_TRANSLATION_JOB = "product-translate";
export type ProductTranslationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const t = productTranslations;
const sourceColumns = { id: products.id, name: products.name, tagline: products.tagline, description: products.description };
// The intro-review queue is neither requested nor resumed. Current editor holds and takedowns block translation.
export const productTranslationEligible = sql`${products.status} in ('seeded', 'verified')
  and not exists (select 1 from ${takedownRequests} r where r.slug = ${products.slug} and r.handled_at is null)
  and not exists (select 1 from ${productIntroChecks} i where i.product_id = ${products.id}
    and i.checked_tagline = ${products.tagline} and i.outcome = 'needs_editor')`;
const eligible = productTranslationEligible;

/** Detail/query extras can expose the same current-source hold guard to metadata. */
export const productTranslationEligibilityField = {
  translationEligible: sql<boolean>`(${eligible})`.as("translation_eligible"),
};

function demandIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, productTranslationPolicy().demandLimit).sort((a, b) => a - b);
}
function requireLocale(locale: Locale): void {
  if (!isLocale(locale)) throw new Error("invalid_translation_locale");
}

/** Batch read only. Safe inside a replica/cache loader; never requests work or calls a model. */
export async function readProductTranslations(sources: readonly ProductTranslationSource[], locale: Locale): Promise<ProductTranslation[]> {
  requireLocale(locale);
  if (locale === "ko") return [];
  const ids = demandIds(sources.map((source) => source.id));
  if (!ids.length) return [];
  const visible = new Map(sources.slice(0, productTranslationPolicy().demandLimit).map((source) => [source.id, source]));
  const rows = await db.select({ translation: t, source: sourceColumns }).from(t)
    .innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.productId, ids), eq(t.locale, locale), inArray(t.status, ["ready", "reviewed"]), eligible));
  return rows.flatMap(({ translation, source }) => {
    const requested = visible.get(source.id);
    return requested && translation.sourceHash === productTranslationSourceHash(requested, translation.field)
      && translation.sourceHash === productTranslationSourceHash(source, translation.field) ? [translation] : [];
  });
}

/** SEO reads all ready locales together so every HTML language emits the same reciprocal set. */
export async function readProductTranslationReadiness(sources: readonly ProductTranslationSource[]): Promise<ProductTranslationReadiness[]> {
  const ids = demandIds(sources.map((source) => source.id));
  if (!ids.length) return [];
  const visible = new Map(sources.slice(0, productTranslationPolicy().demandLimit).map((source) => [source.id, source]));
  const rows = await db.select({ translation: {
    productId: t.productId, locale: t.locale, field: t.field, sourceHash: t.sourceHash, status: t.status, errorCode: t.errorCode,
    text: sql<string | null>`case when length(btrim(${t.text})) > 0 then 'present' end`,
  }, source: sourceColumns }).from(t).innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.productId, ids), inArray(t.status, ["ready", "reviewed"]), eligible));
  return rows.flatMap(({ translation, source }) => {
    const requested = visible.get(source.id);
    return requested && translation.sourceHash === productTranslationSourceHash(requested, translation.field)
      && translation.sourceHash === productTranslationSourceHash(source, translation.field) ? [translation] : [];
  });
}

/** Post-render demand only. Primary scope is explicit, even if a caller accidentally retains replica scope. */
export async function requestProductTranslations(
  productIds: readonly number[], locale: Locale, fields: readonly ProductTranslationField[] = ["tagline"],
  transaction?: ProductTranslationTransaction,
): Promise<number> {
  requireLocale(locale);
  if (fields.some((field) => !isProductTranslationField(field))) throw new Error("invalid_translation_field");
  if (locale === "ko") return 0;
  const ids = demandIds(productIds), requestedFields = [...new Set(fields)].sort();
  if (!ids.length || !requestedFields.length) return 0;
  const demand = async (tx: ProductTranslationTransaction) => {
    const sources = await tx.select({ ...sourceColumns, sourceOrigin: products.taglineSource })
      .from(products).where(and(inArray(products.id, ids), eligible)).orderBy(products.id).for("share");
    const values: (typeof t.$inferInsert)[] = [];
    for (const source of sources) for (const field of requestedFields) {
      const text = translationSourceText(source, field);
      if (!text.trim() || detectTranslationSourceLocale(text) === locale) continue;
      values.push({
        productId: source.id, locale, field, sourceHash: productTranslationSourceHash(source, field),
        sourceLocale: detectTranslationSourceLocale(text), text: null, status: "pending" as const,
        provenance: { kind: "machine" as const, source: source.sourceOrigin, policy: PRODUCT_TRANSLATION_POLICY },
        model: "", attempts: 0, errorCode: null, retryAt: null,
      });
    }
    if (!values.length) return 0;
    const inserted = await tx.insert(t).values(values).onConflictDoUpdate({ target: [t.productId, t.locale, t.field],
      set: { sourceHash: sql`excluded.source_hash`, sourceLocale: sql`excluded.source_locale`, text: null, status: "pending",
        provenance: sql`excluded.provenance`, model: "", attempts: 0, errorCode: null, retryAt: null, updatedAt: sql`now()` },
      setWhere: sql`${t.sourceHash} <> excluded.source_hash or ${t.errorCode} in ('ineligible', 'stale_source')`,
    }).returning({ productId: t.productId });
    const requested = inserted.length;
    if (requested) await requestJob(PRODUCT_TRANSLATION_JOB, tx);
    return requested;
  };
  return onPrimary(() => transaction ? demand(transaction) : db.transaction(demand));
}

export type ProductTranslationTask = {
  source: ProductTranslationSource; locale: ProductTranslationLocale; field: ProductTranslationField;
  sourceHash: string; attempts: number; eligible: boolean;
};

/**
 * 전송 계약이 받는 시도 상한 — 묶음 binding 의 demand.attempts 는 0..3 이다(capacity.ts productTranslationMemberSchema·DB dispatch CHECK
 * `BETWEEN 0 AND 3`). 관리자 maxAttempts(1..20)가 이보다 크면 고르기는 시도 4회 이상인 행을 집지만 전송 직전 due 판정이 skipped 로 돌려,
 * 그 행이 매 틱 맨 앞에 남아 뒤의 수요를 막았다(2026-10-30 점검). 고르기·복구·due 판정은 이 값과 실시간 maxAttempts 중 작은 쪽을 쓴다.
 */
const DISPATCHABLE_ATTEMPTS = 4;
const dispatchableAttempts = () => Math.min(productTranslationPolicy().maxAttempts, DISPATCHABLE_ATTEMPTS);
/** productTranslationTaskKey(translation-policy.ts)와 같은 키의 SQL 식 */
const MEMBER_KEY = sql`('product-translate:' || ${t.productId} || ':' || ${t.locale} || ':' || ${t.field})`;

/**
 * Only demanded rows. Never scans the product catalog to generate a blanket backfill.
 *
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 다른 요청(대기·예약·보냄)에 묶인 멤버는 건너뛴다(capacity-busy-targets.ts).
 * 예전에는 같은 맨 앞 묶음을 매 틱 다시 골라 장부 fence 에 미뤄지며 경로 전체가 무진척이었다. keepOwn: 이 boot 의 대기·예약 요청 멤버는
 * 빼지 않는다 — 조정기가 그 요청을 이어받거나(복구 먼저) 지운다. `exclude` 는 이 틱에 이미 시도해 넘긴 멤버(잡이 다음 수요로 고른다).
 * 재시도 간격(retry_at)·최대 시도(maxAttempts)가 그대로 조절판이다.
 */
export async function pendingProductTranslations(limit = 4, options: { owner?: CapacityOwner; exclude?: readonly string[] } = {}):
  Promise<ProductTranslationTask[]> {
  const owner = "owner" in options ? options.owner : capacityOwnerFromEnv();
  const exclude = [...new Set(options.exclude ?? [])];
  const rows = await db.select({ source: sourceColumns, locale: t.locale, field: t.field,
    sourceHash: t.sourceHash, attempts: t.attempts, eligible: sql<boolean>`(${eligible})` }).from(t)
    .innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.status, ["pending", "failed"]), sql`${t.attempts} < ${dispatchableAttempts()}`,
      sql`(${t.retryAt} is null or ${t.retryAt} <= now())`,
      sql`${MEMBER_KEY} NOT IN (${busyMemberKeysSql(`${PRODUCT_TRANSLATION_JOB}:`, { owner, keepOwn: true })})`,
      exclude.length ? sql`${MEMBER_KEY} NOT IN (${sql.join(exclude.map(key => sql`${key}`), sql`, `)})` : undefined))
    .orderBy(asc(t.updatedAt), asc(t.productId), asc(t.locale), asc(t.field)).limit(Math.max(1, Math.min(8, limit)));
  return rows;
}

/** Complete original membership only; fresh queue ordering cannot replace one member of an admitted batch. */
export async function pendingProductTranslationBatch(memberKeys: readonly string[]): Promise<ProductTranslationTask[] | null> {
  const keys = z.array(z.string().regex(/^product-translate:[1-9]\d*:(en|zh-Hans|zh-Hant):(tagline|description)$/)).min(1).max(4).parse(memberKeys);
  if (new Set(keys).size !== keys.length) throw new Error("invalid_product_translation_members");
  const targets = keys.map(key => { const [, id, locale, field] = key.split(":");
    return { productId: z.number().int().positive().safe().parse(Number(id)), locale, field }; });
  return onPrimary(async () => {
    const rows = await db.select({ source: sourceColumns, locale: t.locale, field: t.field,
      sourceHash: t.sourceHash, attempts: t.attempts, eligible: sql<boolean>`(${eligible})` }).from(t)
      .innerJoin(products, eq(products.id, t.productId)).where(and(eligible,
        or(...targets.map(target => and(eq(t.productId, target.productId), eq(t.locale, target.locale as ProductTranslationLocale),
          eq(t.field, target.field as ProductTranslationField)))), inArray(t.status, ["pending", "failed"]),
        sql`${t.attempts} < ${dispatchableAttempts()}`, sql`(${t.retryAt} is null or ${t.retryAt} <= clock_timestamp())`));
    if (rows.length !== keys.length) return null;
    const batch = targets.map(target => rows.find(row => row.source.id === target.productId && row.locale === target.locale && row.field === target.field)!);
    if (batch.some(task => productTranslationSourceHash(task.source, task.field) !== task.sourceHash)
      || batch.reduce((size, task) => size + translationSourceText(task.source, task.field).length, 0) > productTranslationPolicy().maxSourceChars) return null;
    return translationBatch(batch);
  });
}

export type ProductTranslationResult = { ok: true; text: string; model: string } | { ok: false; error: string; model: string };

export type ProductTranslationWriteExpectation = Readonly<{ kind: "product_translation_write" }>;
type TranslationRole = ProductTranslationDispatchBinding["role"];
type DemandSnapshot = { productId: number; locale: ProductTranslationLocale; field: ProductTranslationField; raw: Record<string, unknown> };
const productWrites = new WeakMap<ProductTranslationWriteExpectation, {
  job: JobLease; role: TranslationRole; model: string; rows: DemandSnapshot[]; members: readonly ProductTranslationMember[]; used: boolean;
}>();
class ProductTranslationChanged extends Error { constructor() { super("product_translation_input_changed"); } }
const taskSchema = z.object({ source: z.object({ id: z.number().int().positive().safe(), name: z.string(), tagline: z.string(),
  description: z.string().optional() }).strict(), locale: z.enum(["en", "zh-Hans", "zh-Hant"]), field: z.enum(["tagline", "description"]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), attempts: z.number().int().min(0), eligible: z.boolean() }).strict();
function translationBatch(value: readonly ProductTranslationTask[]): ProductTranslationTask[] {
  // attempts < maxAttempts 와 원문 글자 합 상한은 이 틱의 translation.product(관리자 실시간 한도)로 본다
  const policy = productTranslationPolicy();
  const tasks = z.array(taskSchema).min(1).max(policy.batchMax).parse(structuredClone(value));
  if (new Set(tasks.map(task => `${task.source.id}:${task.locale}:${task.field}`)).size !== tasks.length
    || tasks.some(task => task.attempts >= policy.maxAttempts)
    || tasks.reduce((count, task) => count + translationSourceText(task.source, task.field).length, 0) > policy.maxSourceChars
    || tasks.some(task => !translationSourceText(task.source, task.field).trim()
      || productTranslationSourceHash(task.source, task.field) !== task.sourceHash)) throw new Error("invalid_product_translation_batch");
  return tasks;
}
const demandOrder = (a: Pick<DemandSnapshot, "productId" | "locale" | "field">, b: Pick<DemandSnapshot, "productId" | "locale" | "field">) =>
  a.productId - b.productId || (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0);
async function lockTranslationRole(tx: ProductTranslationTransaction, lease: RoleLease): Promise<TranslationRole> {
  const [row] = await tx.execute<{ raw: Record<string, unknown> }>(sql`SELECT to_jsonb(r) AS raw FROM role_leases r WHERE role=${lease.role} FOR SHARE`);
  const raw = row?.raw;
  if (!raw || raw.owner_instance_id !== lease.instanceId || raw.owner_boot_id !== lease.bootId || raw.owner_release !== lease.release
    || raw.epoch !== lease.epoch || !["primary", "standby"].includes(String(raw.owner_kind))) throw new RoleLeaseLostError();
  const role = productTranslationDispatchBindingSchema.shape.role.parse({ role: lease.role, instanceId: lease.instanceId,
    bootId: lease.bootId, release: lease.release, kind: raw.owner_kind, epoch: lease.epoch,
    batch: lease.batchVersion === 1 ? { mode: "versioned", host: lease.host, batchEpoch: lease.batchEpoch } : { mode: "legacy" } });
  await translationRoleWall(tx, role);
  return role;
}
async function translationRoleWall(tx: ProductTranslationTransaction, role: TranslationRole): Promise<void> {
  const [row] = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM role_leases WHERE role=${role.role}
    AND owner_instance_id=${role.instanceId} AND owner_boot_id=${role.bootId} AND owner_release=${role.release}
    AND owner_kind=${role.kind} AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS live`);
  if (!row?.live) throw new RoleLeaseLostError();
}
async function finalTranslationWall(tx: ProductTranslationTransaction, role: TranslationRole, job: JobLease,
  dispatch?: ProductTranslationModelDispatch): Promise<void> {
  const request = dispatch ? sql`EXISTS (SELECT 1 FROM model_capacity_requests
    WHERE request_id=${dispatch.requestId}::uuid AND token=${dispatch.token}::uuid AND state='dispatched'
      AND owner_instance_id=${dispatch.owner.instanceId} AND owner_boot_id=${dispatch.owner.bootId}::uuid
      AND epoch=${dispatch.epoch} AND revision=${dispatch.revision} AND policy_hash=${dispatch.policyHash}
      AND dispatch_binding_hash=${dispatch.bindingHash} AND dispatch_binding=${JSON.stringify(dispatch.binding)}::text::jsonb
      AND reserved_until>clock_timestamp())` : sql`true`;
  const [wall] = await tx.execute<{ role_live: boolean; job_live: boolean; live: boolean }>(sql`SELECT
    EXISTS (SELECT 1 FROM role_leases WHERE role=${role.role} AND owner_instance_id=${role.instanceId}
      AND owner_boot_id=${role.bootId} AND owner_release=${role.release} AND owner_kind=${role.kind}
      AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS role_live,
    EXISTS (SELECT 1 FROM jobs WHERE name=${job.name} AND lease_token=${job.token}
      AND locked_at>=clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond') AS job_live,
    ${request} AS live`);
  if (!wall?.role_live) throw new RoleLeaseLostError();
  if (!wall.job_live) throw new JobLeaseLostError();
  if (!wall.live) throw new Error("product_translation_model_reservation_lost");
}
async function lockTranslationProducts(tx: ProductTranslationTransaction, ids: readonly number[]) {
  const rows = new Map<number, ProductTranslationSource & { slug: string; eligible: boolean }>();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const [hint] = await tx.execute<{ id: number; slug: string }>(sql`SELECT id,slug FROM products WHERE id=${id}`);
    if (!hint || !await lockProductGeneration(tx, id, hint.slug)) throw new ProductTranslationChanged();
    // This separate statement sees holds committed while the product lock waited.
    const [source] = await tx.execute<ProductTranslationSource & { slug: string; eligible: boolean }>(sql`
      SELECT id,slug,name,tagline,description,(${eligible}) AS eligible FROM products WHERE id=${id}`);
    if (!source) throw new ProductTranslationChanged();
    rows.set(id, source);
  }
  return rows;
}
async function lockedTranslationDemands(tx: ProductTranslationTransaction, targets: readonly Pick<DemandSnapshot, "productId" | "locale" | "field">[]) {
  const rows: (DemandSnapshot & { due: boolean })[] = [];
  for (const target of [...targets].sort(demandOrder)) {
    const [row] = await tx.execute<{ raw: Record<string, unknown>; due: boolean }>(sql`SELECT to_jsonb(t) AS raw,
      (status IN ('pending','failed') AND attempts<${dispatchableAttempts()} AND (retry_at IS NULL OR retry_at<=clock_timestamp())) AS due
      FROM product_translations t WHERE product_id=${target.productId} AND locale=${target.locale} AND field=${target.field} FOR UPDATE`);
    if (!row) throw new ProductTranslationChanged();
    rows.push({ ...target, raw: row.raw, due: row.due });
  }
  return rows;
}
type TranslationPreparationOptions = { call: PreparedProductTranslationGatewayCall; roleLease: RoleLease;
  callBudget?: { deadlineAt: number; minimumRemainingMs: number };
  reserved?: { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity;
    members: readonly ProductTranslationMember[]; role: TranslationRole } };
export type ProductTranslationPreparation = { kind: "disabled" } | { kind: "skipped" }
  | { kind: "ready"; members: readonly ProductTranslationMember[]; role: TranslationRole }
  | { kind: "ready"; dispatch: ProductTranslationModelDispatch; expectation: ProductTranslationWriteExpectation };

/** The private ledger prefix and all domain authority remain in one short TX. */
export async function prepareProductTranslationDispatch(value: readonly ProductTranslationTask[], job: JobLease,
  valueOptions: TranslationPreparationOptions): Promise<ProductTranslationPreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const tasks = translationBatch(value), lease = structuredClone(job), roleLease = structuredClone(valueOptions.roleLease);
  const reserved = valueOptions.reserved && structuredClone(valueOptions.reserved), call = valueOptions.call;
  const callBudget = valueOptions.callBudget && structuredClone(valueOptions.callBudget);
  if (lease.name !== PRODUCT_TRANSLATION_JOB) throw new Error("translation_job_lease_required");
  let writer: Parameters<typeof productWrites.set>[1] | undefined;
  try {
    const prepared = await onPrimary(() => db.transaction(async tx => {
      const lock = reserved ? await lockProductTranslationModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
      const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && control.mode === "disabled") return { kind: "disabled" } as const;
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
      if (call.model !== scopedModel("product-translate", PRODUCT_TRANSLATE_MODEL) || !control.policy?.routes.some(route => route.routeId === PRODUCT_TRANSLATION_JOB
        && route.provider === "abcllm" && route.model === call.model)) throw new ModelCapacityDeferredError("unmapped");
      if (!roleLease || !["text", "translation"].includes(roleLease.role)) throw new ModelCapacityDeferredError("owner_unavailable");
      await assertJobBatchAdmission(tx, PRODUCT_TRANSLATION_JOB, roleLease);
      const role = await lockTranslationRole(tx, roleLease);
      const sources = await lockTranslationProducts(tx, tasks.map(task => task.source.id));
      const rows = await lockedTranslationDemands(tx, tasks.map(task => ({ productId: task.source.id, locale: task.locale, field: task.field })));
      const members = productTranslationInputSchema.shape.members.parse(tasks.map(task => {
        const source = sources.get(task.source.id)!, row = rows.find(row => row.productId === task.source.id && row.locale === task.locale && row.field === task.field)!;
        if (!source.eligible || productTranslationSourceHash(source, task.field) !== task.sourceHash || !row.due
          || row.raw.source_hash !== task.sourceHash || row.raw.attempts !== task.attempts) throw new ProductTranslationChanged();
        return { productId: source.id, slug: source.slug, locale: task.locale, field: task.field, sourceHash: task.sourceHash,
          demand: { rowIdentityHash: reviewHash(row.raw), attempts: task.attempts } };
      }));
      await assertJobLeaseAtWallTime(tx, lease, "update"); await translationRoleWall(tx, role);
      if (!reserved) return { kind: "ready", members, role } as const;
      if (!isDeepStrictEqual(role, reserved.role) || !isDeepStrictEqual(members, reserved.members)) throw new ProductTranslationChanged();
      const binding = productTranslationDispatchBindingSchema.parse({ kind: "product_translation_gateway", version: 1,
        members, model: call.model, logicalWorkKey: productTranslationLogicalWorkKey(members),
        inputHash: productTranslationInputHash({ members, model: call.model }), provider: "abcllm", routeId: PRODUCT_TRANSLATION_JOB,
        wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
        chargedTokens: call.totalTokenBound, job: lease, role });
      // Check after all potentially waiting domain/owner locks, before recording
      // any physical dispatch. A refusal leaves the reservation cancellable.
      if (callBudget && (!Number.isFinite(callBudget.deadlineAt) || !Number.isFinite(callBudget.minimumRemainingMs)
        || callBudget.minimumRemainingMs < 1 || callBudget.deadlineAt - Date.now() < callBudget.minimumRemainingMs))
        throw new ModelCapacityDeferredError("capacity");
      const dispatch = await finishProductTranslationModelCapacityDispatch(tx, lock!, binding);
      // Event INSERT may have waited. All three held owners must still be live at this wall.
      await translationRoleWall(tx, role); await assertJobLeaseAtWallTime(tx, lease, "update");
      await finalTranslationWall(tx, role, lease, dispatch);
      writer = { job: lease, role, model: call.model, rows, members, used: false };
      return { kind: "ready", dispatch } as const;
    }));
    if (prepared.kind === "ready" && "dispatch" in prepared) {
      const expectation = Object.freeze({ kind: "product_translation_write" as const });
      productWrites.set(expectation, writer!); // commit ACK precedes issuance
      return { ...prepared, expectation };
    }
    return prepared;
  } catch (error) {
    if (error instanceof ProductTranslationChanged) return { kind: "skipped" };
    if (error instanceof Error && error.message === "product_translation_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

/** Product lock + source/version CAS + final job lease check prevent stale saves and lost-owner commits. */
export async function recordProductTranslations(
  entries: readonly { task: ProductTranslationTask; result: ProductTranslationResult }[], lease: JobLease,
  expectation?: ProductTranslationWriteExpectation,
): Promise<number> {
  if (lease.name !== PRODUCT_TRANSLATION_JOB) throw new Error("translation_job_lease_required");
  if (expectation !== undefined) return writeReservedProductTranslations(entries, lease, expectation);
  return onPrimary(() => db.transaction(async (tx) => {
    let stored = 0;
    for (const { task, result } of [...entries].sort((a, b) => a.task.source.id - b.task.source.id)) {
      const [source] = await tx.select({ ...sourceColumns, eligible: sql<boolean>`(${eligible})` })
        .from(products).where(eq(products.id, task.source.id)).for("share");
      if (!source) continue;
      stored += await updateProductTranslation(tx, task, result, source);
    }
    await assertJobLease(tx, lease);
    return stored;
  }));
}


/** Shared legacy value policy; the positive path only adds the original raw-row CAS. */
async function updateProductTranslation(tx: ProductTranslationTransaction, task: ProductTranslationTask, result: ProductTranslationResult,
  source: ProductTranslationSource & { eligible: boolean }, raw?: Record<string, unknown>): Promise<number> {
  const current = source.eligible && productTranslationSourceHash(source, task.field) === task.sourceHash;
  const { maxAttempts } = productTranslationPolicy();
  const error = current ? (result.ok ? null : result.error.slice(0, 60)) : source.eligible ? "stale_source" : "ineligible";
  const updated = await tx.update(t).set({
    text: current && result.ok ? result.text : null,
    status: current && result.ok ? "ready" : "failed", model: result.model.slice(0, 160), errorCode: error,
    attempts: current && (result.ok || result.error !== "source_too_long") ? task.attempts + 1 : maxAttempts,
    retryAt: current && !result.ok && result.error !== "source_too_long" && task.attempts + 1 < maxAttempts
      ? sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${task.attempts}))` : null,
    updatedAt: sql`now()`,
  }).where(and(eq(t.productId, task.source.id), eq(t.locale, task.locale), eq(t.field, task.field),
    eq(t.sourceHash, task.sourceHash), eq(t.attempts, task.attempts), inArray(t.status, ["pending", "failed"]),
      raw ? sql`to_jsonb(${t}) = ${JSON.stringify(raw)}::text::jsonb` : undefined))
    .returning({ id: t.productId });
  return updated.length;
}

async function writeReservedProductTranslations(value: readonly { task: ProductTranslationTask; result: ProductTranslationResult }[],
  job: JobLease, expectation: ProductTranslationWriteExpectation): Promise<number> {
  const proof = productWrites.get(expectation), entries = structuredClone(value), lease = structuredClone(job);
  if (!proof || proof.used || !isDeepStrictEqual(lease, proof.job) || entries.length !== proof.members.length
    || new Set(entries.map(({ task }) => `${task.source.id}:${task.locale}:${task.field}`)).size !== entries.length
    || entries.some(({ task, result }) => !proof.members.some(member => member.productId === task.source.id
      && member.locale === task.locale && member.field === task.field && member.sourceHash === task.sourceHash && member.demand.attempts === task.attempts)
      || result.model !== proof.model || result.ok && typeof result.text !== "string" || !result.ok && typeof result.error !== "string"))
    throw new Error("invalid_product_translation_write_expectation");
  proof.used = true;
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SELECT role FROM role_leases WHERE role=${proof.role.role} FOR SHARE`);
      await translationRoleWall(tx, proof.role);
      const sources = await lockTranslationProducts(tx, proof.members.map(member => member.productId));
      if (proof.members.some(member => sources.get(member.productId)?.slug !== member.slug)) throw new ProductTranslationChanged();
      const rows = await lockedTranslationDemands(tx, proof.members);
      if (!isDeepStrictEqual(rows.map(({ productId, locale, field, raw }) => ({ productId, locale, field, raw })),
        proof.rows.map(({ productId, locale, field, raw }) => ({ productId, locale, field, raw })))) throw new ProductTranslationChanged();
      await assertJobLeaseAtWallTime(tx, lease, "update");
      let stored = 0;
      for (const { task, result } of [...entries].sort((a, b) => demandOrder({ productId: a.task.source.id, locale: a.task.locale, field: a.task.field },
        { productId: b.task.source.id, locale: b.task.locale, field: b.task.field }))) {
        const row = rows.find(row => row.productId === task.source.id && row.locale === task.locale && row.field === task.field)!;
        const count = await updateProductTranslation(tx, task, result, sources.get(task.source.id)!, row.raw);
        if (count !== 1) throw new ProductTranslationChanged();
        stored += count;
      }
      await assertJobLeaseAtWallTime(tx, lease, "update"); await finalTranslationWall(tx, proof.role, lease);
      return stored;
    }));
  } catch (error) {
    if (error instanceof ProductTranslationChanged) return 0;
    throw error;
  }
}
