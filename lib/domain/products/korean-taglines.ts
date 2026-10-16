import { currentReplayDb } from "@/lib/db/replay-scope";
import { JobLeaseLostError, STALE_LOCK_MS } from "@/lib/jobs/lease";
import { RoleLeaseLostError, type RoleLease } from "@/lib/jobs/role-leader";
import { assertJobBatchAdmission } from "@/lib/jobs/batch-repository";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { TRANSLATE_MODEL, productTaglineKoSourceHash } from "@/lib/crawl/translate";
import type { PreparedProductTaglineKoGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { displayProjectName } from "./display-name";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { productTaglineKoInputSchema, productTaglineKoDispatchBindingSchema, productTaglineKoInputHash,
  productTaglineKoLogicalWorkKey, type ProductTaglineKoMember, type ProductTaglineKoDispatchBinding,
  type ModelCapacityReservation, type ModelCapacityRequestIdentity, type ProductTaglineKoModelDispatch } from "@/lib/llm/capacity";
import { lockModelCapacityCallerControl, lockProductTaglineKoModelCapacityDispatch,
  finishProductTaglineKoModelCapacityDispatch } from "@/lib/llm/capacity-repository";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { productKoreanTaglines, products, type ProductStatus } from "@/lib/db/schema";
import { assertJobLease, assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { slugArrayPredicate } from "@/lib/domain/ranking/refresh";
import { leadClause, NEEDS_KOREAN } from "./korean-tagline";
import { getPopularGroups } from "./popular";
import { listProductSlugs } from "./repository";

/**
 * 한국어 한 줄 소개의 대기열과 저장. 옮기는 일(게이트웨이)은 lib/crawl/translate.ts, 검사는 korean-tagline.ts 에 있다.
 */

const PUBLIC: ProductStatus[] = ["seeded", "verified"];
/** 검사에서 이만큼 버리면 손을 뗀다 — 원문이 보인다. 게이트웨이 실패는 세지 않고 하루 간격까지 늘려 가며 계속 본다 */
export const MAX_REJECTIONS = 4;
/** Same source preparation used by the original job and the locked native path. */
const SHORTEN_AFTER = new Set(["rejected:too_long", "rejected:empty"]);
export function koreanTaglineSource(task: KoreanTaglineTask): string {
  return task.lastError && SHORTEN_AFTER.has(task.lastError) ? leadClause(task.tagline) : task.tagline;
}

/**
 * 홈에 보이는 제품은 손을 뗀 뒤에도 이만큼 더 본다 — 다시 볼 때는 앞 문장만 보내므로(잡의 taglineSource) 같은 입력의 되풀이가 아니다.
 * 지금 뜨는 상위의 ShellRS·lemo-opuscar 가 '너무 긺'으로 네 번 버려져 원문으로 남았다(2026-10-11).
 */
export const HOME_EXTRA_REJECTIONS = 2;
/** 등재 뒤 이 기간은 '새 제품'으로 맨 앞에 선다 */
const NEW_DAYS = 3;
/** 홈 목록 하나에서 앞쪽 몇 개를 '홈에 보이는 제품'으로 칠지 — 첫 화면과 '더 보기' 한두 번 */
const HOME_DEPTH = 40;

const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;
const k = productKoreanTaglines;

export type KoreanTaglineTask = {
  productId: number; name: string; tagline: string; repoUrl: string | null;
  /** 같은 소개로 시도한 횟수(소개가 바뀌었으면 0) */
  attempts: number;
  /** 같은 소개의 마지막 실패 코드(소개가 바뀌었거나 실패가 없으면 null) */
  lastError?: string | null;
};

/**
 * 홈에 보이는 제품 — 급상승('추천'·띠), 최신, 인기 구간의 앞쪽. 홈과 같은 목록 조회(listProductSlugs·getPopularGroups)를 쓴다.
 * 잡이 틱마다 한 번 읽는다.
 */
export async function homeListSlugs(depth = HOME_DEPTH): Promise<string[]> {
  const base = { statuses: PUBLIC, excludeDown: true, limit: depth };
  const lists = await Promise.all([
    listProductSlugs({ ...base, sort: "rising", rising: true }),
    listProductSlugs({ ...base, sort: "recent", repoChecked: true }),
    getPopularGroups().then((groups) => groups.flatMap((group) => group.items.map((item) => item.slug))),
  ]);
  return [...new Set(lists.flat())];
}

/**
 * 옮길 공개 제품 — 아직 안 옮겼거나, 소개가 바뀌었거나, 실패를 다시 볼 때가 된 것. 이미 한국어인 소개(isKoreanLine)는 빼고.
 *
 * 차례(2026-10-09 운영자 결정 D3): 새로 올라온 제품(NEW_DAYS 안, 최신순) → 홈에 보이는 제품 → 나머지는 스타 많은 순.
 * 실패는 retry_at 이 지나야 다시 서므로 한 건이 앞을 막지 않는다. 검사에서 MAX_REJECTIONS 번 버린 것은 손을 떼지만,
 * 홈에 보이는 제품은 HOME_EXTRA_REJECTIONS 번 더 본다 — 첫 화면에 원문이 남는 것이 가장 눈에 띈다.
 */
export async function pendingKoreanTaglines(limit: number, homeSlugs: readonly string[]): Promise<KoreanTaglineTask[]> {
  const home = slugArrayPredicate(products.slug, [...homeSlugs]);
  const tier = sql`case when ${listedAt} > now() - make_interval(days => ${NEW_DAYS}::int) then 0
    when ${home} then 1 else 2 end`;
  const same = sql`${k.sourceTagline} = ${products.tagline}`;
  const rows = await db.select({
    productId: products.id, name: products.name, tagline: products.tagline, repoUrl: products.repoUrl,
    attempts: sql<number>`case when ${same} then ${k.attempts} else 0 end`,
    lastError: sql<string | null>`case when ${same} then ${k.errorCode} end`,
  }).from(products)
    .leftJoin(k, eq(k.productId, products.id))
    .where(and(
      inArray(products.status, PUBLIC),
      NEEDS_KOREAN,
      sql`(${k.productId} is null or ${k.sourceTagline} <> ${products.tagline}
        or (${k.errorCode} is not null and (${k.qualityRejections} < ${MAX_REJECTIONS}
              or (${home} and ${k.qualityRejections} < ${MAX_REJECTIONS + HOME_EXTRA_REJECTIONS}))
            and (${k.retryAt} is null or ${k.retryAt} <= now())))`,
    ))
    .orderBy(tier, sql`case when ${listedAt} > now() - make_interval(days => ${NEW_DAYS}::int) then ${listedAt} end desc nulls last`,
      sql`${products.stars} desc nulls last`, desc(products.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }));
}

export type KoreanTaglineResult =
  | { kind: "success"; line: string; model: string }
  /** error: 게이트웨이 실패 코드 또는 'rejected:<검사 사유>' */
  | { kind: "failure"; error: string; model: string };

/**
 * 결과를 남긴다 — 한 묶음을 한 트랜잭션에. 그사이 소개가 바뀌었거나 내려간 제품은 건너뛴다(다음 틱이 지금 소개로 다시 옮긴다).
 * 실패는 5분·10분·20분… 뒤에 다시(최대 하루). 지금 소개에서 옮긴 한국어가 이미 있으면 실패로 덮지 않는다.
 * 리스 확인은 맨 마지막이다 — 잃었으면 적은 것 전부가 되돌려진다. 적은 수를 돌려준다.
 */
export async function recordKoreanTaglines(entries: { task: KoreanTaglineTask; result: KoreanTaglineResult }[], lease: JobLease,
  expectation?: KoreanTaglineWriteExpectation): Promise<number> {
  if (expectation !== undefined) return writeReservedKoreanTaglines(entries, lease, expectation);
  return db.transaction(async (tx) => {
    for (const id of [...new Set(entries.map(({ task }) => task.productId))].sort((a, b) => a - b))
      await tx.execute(sql`SELECT id FROM products WHERE id=${id} FOR SHARE`);
    let stored = 0;
    for (const { task, result } of entries) {
      const [product] = await tx.select({ tagline: products.tagline, status: products.status })
        .from(products).where(eq(products.id, task.productId)).for("share");
      if (!product || product.tagline !== task.tagline || !PUBLIC.includes(product.status)) continue;
      const same = sql`${k.sourceTagline} = excluded.source_tagline`;
      const attempts = sql`case when ${same} then ${k.attempts} + 1 else 1 end`;
      const qualityDelta = result.kind === "failure" && result.error.startsWith("rejected:") ? 1 : 0;
      const qualityRejections = sql`case when ${same} then ${k.qualityRejections} + ${qualityDelta} else ${qualityDelta} end`;
      const values = { productId: task.productId, sourceTagline: task.tagline, model: result.model, attempts: 1, qualityRejections: qualityDelta };
      if (result.kind === "success") {
        await tx.insert(k).values({ ...values, taglineKo: result.line, errorCode: null, retryAt: null })
          .onConflictDoUpdate({ target: k.productId, set: { sourceTagline: task.tagline, taglineKo: result.line, model: result.model,
            attempts, qualityRejections, errorCode: null, retryAt: null, updatedAt: sql`now()` } });
      } else {
        const code = result.error.slice(0, 60);
        await tx.insert(k).values({ ...values, taglineKo: null, errorCode: code, retryAt: sql`now() + interval '5 minutes'` })
          .onConflictDoUpdate({ target: k.productId,
            set: { sourceTagline: task.tagline, taglineKo: null, model: result.model, attempts, qualityRejections, errorCode: code, updatedAt: sql`now()`,
              retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, case when ${same} then ${k.attempts} else 0 end))` },
            setWhere: sql`not (${same} and ${k.errorCode} is null)` });
      }
      stored++;
    }
    await assertJobLease(tx, lease);
    return stored;
  });
}

export type KoreanTaglineProgress = {
  /** 옮길 공개 제품(이미 한국어인 소개는 빠진다) */
  eligible: number;
  /** 지금 소개에서 옮긴 한국어가 있는 것 */
  done: number;
  /** 아직 한 번도 안 옮겼거나 소개가 바뀐 것 */
  waiting: number;
  /** 게이트웨이 실패로 다시 기다리는 것 */
  failed: number;
  /** 검사에서 MAX_REJECTIONS 번 버려 손을 뗀 것 — 원문이 보인다 */
  gaveUp: number;
  /** 지금 소개의 마지막 시도가 검사에서 버려진 것, 사유별(rejected: 를 뗀 사유) */
  rejected: { reason: string; count: number }[];
  /** 지난 한 시간에 옮긴 것 */
  lastHour: number;
};

/** 운영센터·관리자가 볼 진행과 품질 수치 — 채운 수와 함께 버린 수를 사유별로 본다 */
export async function koreanTaglineProgress(): Promise<KoreanTaglineProgress> {
  const current = sql`${k.sourceTagline} = ${products.tagline}`;
  const [totals] = await db.select({
    eligible: sql<number>`count(*)::int`,
    done: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} is null))::int`,
    waiting: sql<number>`(count(*) filter (where ${k.productId} is null or not ${current}))::int`,
    failed: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} not like 'rejected:%' and ${k.qualityRejections} < ${MAX_REJECTIONS}))::int`,
    gaveUp: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} is not null and ${k.qualityRejections} >= ${MAX_REJECTIONS}))::int`,
    lastHour: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} is null and ${k.updatedAt} > now() - interval '1 hour'))::int`,
  }).from(products).leftJoin(k, eq(k.productId, products.id)).where(and(inArray(products.status, PUBLIC), NEEDS_KOREAN));
  const rejected = await db.select({ code: k.errorCode, count: sql<number>`count(*)::int` })
    .from(products).innerJoin(k, eq(k.productId, products.id))
    .where(and(inArray(products.status, PUBLIC), NEEDS_KOREAN, sql`${current} and ${k.errorCode} like 'rejected:%'`))
    .groupBy(k.errorCode).orderBy(sql`count(*) desc`);
  return {
    eligible: Number(totals?.eligible ?? 0), done: Number(totals?.done ?? 0), waiting: Number(totals?.waiting ?? 0),
    failed: Number(totals?.failed ?? 0), gaveUp: Number(totals?.gaveUp ?? 0), lastHour: Number(totals?.lastHour ?? 0),
    rejected: rejected.map((row) => ({ reason: (row.code ?? "").replace(/^rejected:/, ""), count: Number(row.count) })),
  };
}

/** 표본 검수용 — 옮긴 것 중 무작위로. 원문과 나란히 사람이 읽고 맞게 옮겼는지 본다(운영자 결정 D3) */
export async function koreanTaglineSample(limit = 20): Promise<{ slug: string; name: string; tagline: string; taglineKo: string; model: string }[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, tagline: products.tagline, taglineKo: k.taglineKo, model: k.model })
    .from(products).innerJoin(k, eq(k.productId, products.id))
    .where(and(inArray(products.status, PUBLIC), sql`${k.sourceTagline} = ${products.tagline} and ${k.errorCode} is null and ${k.taglineKo} is not null`))
    .orderBy(sql`random()`).limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({ ...row, taglineKo: row.taglineKo ?? "" }));
}

export type KoreanTaglineWriteExpectation = Readonly<{ kind: "korean_tagline_write" }>;
type KoreanTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type KoreanRole = ProductTaglineKoDispatchBinding["role"];
type KoreanSource = { id: number; slug: string; name: string; repoUrl: string | null; tagline: string; status: string; needs: boolean };
type KoreanCache = { productId: number; raw: Record<string, unknown> | null; due: boolean };
const koreanWrites = new WeakMap<KoreanTaglineWriteExpectation, {
  job: JobLease; role: KoreanRole; model: string; tasks: KoreanTaglineTask[]; rows: KoreanCache[]; members: readonly ProductTaglineKoMember[]; used: boolean;
}>();
class KoreanTaglineChanged extends Error { constructor() { super("korean_tagline_input_changed"); } }
const koreanTaskSchema = z.object({ productId: z.number().int().positive().safe(), name: z.string(), tagline: z.string(),
  repoUrl: z.string().nullable(), attempts: z.number().int().nonnegative().safe(), lastError: z.string().nullable().optional() }).strict();
function koreanBatch(value: readonly KoreanTaglineTask[]): KoreanTaglineTask[] {
  const tasks = z.array(koreanTaskSchema).min(1).max(8).parse(structuredClone(value));
  if (new Set(tasks.map(task => task.productId)).size !== tasks.length) throw new Error("invalid_korean_tagline_batch");
  return tasks;
}
function sourceIdentity(source: KoreanSource): string {
  return reviewHash({ productId: source.id, slug: source.slug, name: source.name, repoUrl: source.repoUrl, tagline: source.tagline, status: source.status });
}
async function koreanRoleWall(tx: KoreanTransaction, role: KoreanRole): Promise<void> {
  const [row] = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM role_leases WHERE role=${role.role}
    AND owner_instance_id=${role.instanceId} AND owner_boot_id=${role.bootId} AND owner_release=${role.release}
    AND owner_kind=${role.kind} AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS live`);
  if (!row?.live) throw new RoleLeaseLostError();
}
async function lockKoreanRole(tx: KoreanTransaction, lease: RoleLease): Promise<KoreanRole> {
  const [row] = await tx.execute<{ raw: Record<string, unknown> }>(sql`SELECT to_jsonb(r) AS raw FROM role_leases r WHERE role=${lease.role} FOR SHARE`);
  const raw = row?.raw;
  if (!raw || raw.owner_instance_id !== lease.instanceId || raw.owner_boot_id !== lease.bootId || raw.owner_release !== lease.release
    || raw.epoch !== lease.epoch || !["primary", "standby"].includes(String(raw.owner_kind))) throw new RoleLeaseLostError();
  const role = productTaglineKoDispatchBindingSchema.shape.role.parse({ role: lease.role, instanceId: lease.instanceId,
    bootId: lease.bootId, release: lease.release, kind: raw.owner_kind, epoch: lease.epoch,
    batch: lease.batchVersion === 1 ? { mode: "versioned", host: lease.host, batchEpoch: lease.batchEpoch } : { mode: "legacy" } });
  await koreanRoleWall(tx, role);
  return role;
}
async function finalKoreanWall(tx: KoreanTransaction, role: KoreanRole, job: JobLease, dispatch?: ProductTaglineKoModelDispatch): Promise<void> {
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
  if (!wall.live) throw new Error("product_tagline_ko_model_reservation_lost");
}
async function lockKoreanSources(tx: KoreanTransaction, ids: readonly number[]): Promise<Map<number, KoreanSource>> {
  const rows = new Map<number, KoreanSource>();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const [source] = await tx.execute<KoreanSource>(sql`SELECT id,slug,name,repo_url AS "repoUrl",tagline,status,
      (${NEEDS_KOREAN}) AS needs FROM products WHERE id=${id} FOR UPDATE`);
    if (!source) throw new KoreanTaglineChanged();
    rows.set(id, source);
  }
  return rows;
}
async function lockKoreanCaches(tx: KoreanTransaction, ids: readonly number[]): Promise<KoreanCache[]> {
  const rows: KoreanCache[] = [];
  for (const productId of [...new Set(ids)].sort((a, b) => a - b)) {
    const [row] = await tx.execute<{ raw: Record<string, unknown>; due: boolean }>(sql`SELECT to_jsonb(k) AS raw,
      (retry_at IS NULL OR retry_at<=clock_timestamp()) AS due FROM product_korean_taglines k WHERE product_id=${productId} FOR UPDATE`);
    rows.push({ productId, raw: row?.raw ?? null, due: row?.due ?? true });
  }
  return rows;
}
function koreanMember(source: KoreanSource, row: KoreanCache, task: KoreanTaglineTask, home: readonly string[]): ProductTaglineKoMember {
  const raw = row.raw, same = raw?.source_tagline === source.tagline;
  if (!PUBLIC.includes(source.status as ProductStatus) || !source.needs || source.name !== task.name || source.repoUrl !== task.repoUrl
    || source.tagline !== task.tagline || task.attempts !== (same ? raw!.attempts : 0)
    || (task.lastError ?? null) !== (same ? raw!.error_code : null)
    || same && (raw!.error_code === null || !row.due || !(Number(raw!.quality_rejections) < MAX_REJECTIONS
      || home.includes(source.slug) && Number(raw!.quality_rejections) < MAX_REJECTIONS + HOME_EXTRA_REJECTIONS))) throw new KoreanTaglineChanged();
  return { productId: source.id, slug: source.slug, sourceIdentityHash: sourceIdentity(source),
    sourceHash: productTaglineKoSourceHash({ name: displayProjectName(source.name, source.repoUrl), tagline: koreanTaglineSource(task) }),
    cache: raw ? { kind: "present", rowIdentityHash: reviewHash(raw), attempts: Number(raw.attempts), qualityRejections: Number(raw.quality_rejections) } : { kind: "absent" } };
}
type KoreanPreparationOptions = { call: PreparedProductTaglineKoGatewayCall; roleLease: RoleLease;
  reserved?: { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; members: readonly ProductTaglineKoMember[]; role: KoreanRole } };
export type KoreanTaglinePreparation = { kind: "disabled" } | { kind: "skipped" }
  | { kind: "ready"; members: readonly ProductTaglineKoMember[]; role: KoreanRole }
  | { kind: "ready"; dispatch: ProductTaglineKoModelDispatch; expectation: KoreanTaglineWriteExpectation };

/** Initial read and reserved reentry use the same domain checks; only the fixed ledger lock prefix differs. */
export async function prepareKoreanTaglineDispatch(value: readonly KoreanTaglineTask[], homeSlugs: readonly string[], job: JobLease,
  valueOptions: KoreanPreparationOptions): Promise<KoreanTaglinePreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const tasks = koreanBatch(value), home = z.array(z.string()).parse(structuredClone(homeSlugs));
  const lease = structuredClone(job), roleLease = structuredClone(valueOptions.roleLease);
  const reserved = valueOptions.reserved && structuredClone(valueOptions.reserved), call = valueOptions.call;
  if (lease.name !== "product-tagline-ko") throw new Error("korean_tagline_job_lease_required");
  let writer: Parameters<typeof koreanWrites.set>[1] | undefined;
  try {
    const prepared = await onPrimary(() => db.transaction(async tx => {
      const lock = reserved ? await lockProductTaglineKoModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
      const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && control.mode === "disabled") return { kind: "disabled" } as const;
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
      if (call.model !== TRANSLATE_MODEL || !control.policy?.routes.some(route => route.routeId === "product-tagline-ko"
        && route.provider === "abcllm" && route.model === call.model)) throw new ModelCapacityDeferredError("unmapped");
      if (!roleLease || !["text", "translation"].includes(roleLease.role)) throw new ModelCapacityDeferredError("owner_unavailable");
      await assertJobBatchAdmission(tx, "product-tagline-ko", roleLease);
      const role = await lockKoreanRole(tx, roleLease);
      const sources = await lockKoreanSources(tx, tasks.map(task => task.productId));
      const rows = await lockKoreanCaches(tx, tasks.map(task => task.productId));
      const members = productTaglineKoInputSchema.shape.members.parse(tasks.map(task => koreanMember(sources.get(task.productId)!,
        rows.find(row => row.productId === task.productId)!, task, home)));
      await assertJobLeaseAtWallTime(tx, lease, "update");
      if (!reserved) return { kind: "ready", members, role } as const;
      if (!isDeepStrictEqual(members, reserved.members) || !isDeepStrictEqual(role, reserved.role)) throw new KoreanTaglineChanged();
      const binding = productTaglineKoDispatchBindingSchema.parse({ kind: "product_tagline_ko_gateway", version: 1,
        members, model: call.model, logicalWorkKey: productTaglineKoLogicalWorkKey(members), inputHash: productTaglineKoInputHash({ members, model: call.model }),
        provider: "abcllm", routeId: "product-tagline-ko", wireHash: call.wireHash, servingContractHash: call.servingContractHash,
        totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job: lease, role });
      const dispatch = await finishProductTaglineKoModelCapacityDispatch(tx, lock!, binding);
      await finalKoreanWall(tx, role, lease, dispatch);
      writer = { job: lease, role, model: call.model, tasks, rows, members, used: false };
      return { kind: "ready", dispatch } as const;
    }));
    if (prepared.kind === "ready" && "dispatch" in prepared) {
      const expectation = Object.freeze({ kind: "korean_tagline_write" as const });
      koreanWrites.set(expectation, writer!); // issued only after actual commit acknowledgement
      return { ...prepared, expectation };
    }
    return prepared;
  } catch (error) {
    if (error instanceof KoreanTaglineChanged) return { kind: "skipped" };
    if (error instanceof Error && error.message === "product_tagline_ko_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

async function writeReservedKoreanTaglines(value: readonly { task: KoreanTaglineTask; result: KoreanTaglineResult }[], job: JobLease,
  expectation: KoreanTaglineWriteExpectation): Promise<number> {
  const proof = koreanWrites.get(expectation), entries = structuredClone(value), lease = structuredClone(job);
  if (!proof || proof.used || !isDeepStrictEqual(lease, proof.job) || !isDeepStrictEqual(entries.map(entry => entry.task), proof.tasks)
    || entries.some(({ result }) => result.model !== proof.model || result.kind === "success" && typeof result.line !== "string"
      || result.kind === "failure" && typeof result.error !== "string" || !["success", "failure"].includes(result.kind)))
    throw new Error("invalid_korean_tagline_write_expectation");
  proof.used = true;
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SELECT role FROM role_leases WHERE role=${proof.role.role} FOR SHARE`);
      await koreanRoleWall(tx, proof.role);
      const sources = await lockKoreanSources(tx, proof.members.map(member => member.productId));
      if (proof.members.some(member => sourceIdentity(sources.get(member.productId)!) !== member.sourceIdentityHash)) throw new KoreanTaglineChanged();
      const rows = await lockKoreanCaches(tx, proof.members.map(member => member.productId));
      if (!isDeepStrictEqual(rows.map(({ productId, raw }) => ({ productId, raw })), proof.rows.map(({ productId, raw }) => ({ productId, raw })))) throw new KoreanTaglineChanged();
      await assertJobLeaseAtWallTime(tx, lease, "update");
      for (const { task, result } of [...entries].sort((a, b) => a.task.productId - b.task.productId)) {
        const raw = rows.find(row => row.productId === task.productId)!.raw;
        const same = sql`${k.sourceTagline} = excluded.source_tagline`;
        const attempts = sql`case when ${same} then ${k.attempts} + 1 else 1 end`;
        const qualityDelta = result.kind === "failure" && result.error.startsWith("rejected:") ? 1 : 0;
        const qualityRejections = sql`case when ${same} then ${k.qualityRejections} + ${qualityDelta} else ${qualityDelta} end`;
        const values = { productId: task.productId, sourceTagline: task.tagline, model: result.model, attempts: 1, qualityRejections: qualityDelta };
        const resultValues = result.kind === "success" ? { taglineKo: result.line, errorCode: null, retryAt: null }
          : { taglineKo: null, errorCode: result.error.slice(0, 60), retryAt: sql`now() + interval '5 minutes'` };
        // All products are locked first. A cache absence race must never overwrite its winner.
        const written = raw ? await tx.insert(k).values({ ...values, ...resultValues }).onConflictDoUpdate({ target: k.productId,
          set: { sourceTagline: task.tagline, ...resultValues, model: result.model, attempts, qualityRejections, updatedAt: sql`now()`,
            retryAt: result.kind === "success" ? null : sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, case when ${same} then ${k.attempts} else 0 end))` },
          setWhere: sql`to_jsonb(${k}) = ${JSON.stringify(raw)}::text::jsonb AND ${result.kind === "success" ? sql`true` : sql`not (${same} and ${k.errorCode} is null)`}`,
        }).returning({ id: k.productId }) : await tx.insert(k).values({ ...values, ...resultValues })
          .onConflictDoNothing({ target: k.productId }).returning({ id: k.productId });
        if (written.length !== 1) throw new KoreanTaglineChanged();
      }
      await assertJobLeaseAtWallTime(tx, lease, "update");
      await finalKoreanWall(tx, proof.role, lease);
      return entries.length;
    }));
  } catch (error) {
    if (error instanceof KoreanTaglineChanged) return 0;
    throw error;
  }
}
