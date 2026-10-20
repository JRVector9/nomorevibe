import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { crawlDocuments, products } from "@/lib/db/schema";
import { notifications, productMakerMembers } from "@/lib/db/me-schema";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { githubRequest } from "@/lib/crawl/github";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { isGithubNumericId, isGithubRepositoryName } from "@/lib/github/repositories";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { enqueueNotificationEmails } from "@/lib/me/email-outbox";
import { logger } from "@/lib/observability/logger";
import { createMemo } from "@/lib/cache/memo";
import { rateLimit } from "@/lib/rate-limit";

/**
 * 운영자 확인(마이페이지 MY5 = 로그인 설계 L5 = 피드백 PR8) — GitHub 로그인 숫자 id 가 저장소 주인 숫자 id 와 같으면 주인이다.
 * 이름(login)은 바뀌므로 찾기에만 쓰고, 확인은 늘 숫자 id 로 한다. 저장소 정보는 수집기 자격으로 읽는다(사용자 토큰은 쓰지 않는다).
 * 워커(재확인 잡·발행)도 이 파일을 부르므로 server-only 를 붙이지 않는다.
 */

/** 확인한 뒤 다시 확인할 때까지 */
export const MAKER_RECHECK_DAYS = 30;
/** 한 번에 확인하는 제품 수 */
export const CLAIM_BATCH_LIMIT = 20;
const PUBLIC_STATUSES = ["seeded", "verified"] as const;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** 운영자 확인이 GitHub 을 실제로 부르는 한도 — 수집기와 같은 자격을 쓰므로 전체 시간당 300번, 계정마다 40번 */
export const CLAIM_LOOKUPS_PER_HOUR = 300;
export const CLAIM_LOOKUPS_PER_USER_HOUR = 40;

export type MakerErrorCode = "github_login_required" | "invalid_request" | "invalid_repo_url" | "repo_not_listed"
  | "target_not_found" | "not_a_member" | "reply_invalid" | "intro_invalid" | "product_not_found" | "rate_limited";
export class MakerError extends Error {
  constructor(readonly code: MakerErrorCode, readonly status: number) {
    super(code);
    this.name = "MakerError";
  }
}

export type RepoRef = { owner: string; repo: string; fullName: string; url: string };

/**
 * 저장소 주소 → owner/repo(소문자). github.com 저장소만 받는다 — 붙여 넣은 브라우저 주소의 /tree/… 와 ?·# 는 떼고,
 * "github.com/owner/repo" 와 "owner/repo" 도 받는다. 계정 정보·포트·다른 호스트·잘못된 이름은 null
 */
export function parseRepoUrl(input: unknown): RepoRef | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > 300 || /[\s\\\x00-\x1f]/.test(value)) return null;
  if (/^(?:www\.)?github\.com\//i.test(value)) value = `https://${value}`;
  let parts: string[];
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (host !== "github.com" && host !== "www.github.com")
      || url.username || url.password || url.port) return null;
    parts = url.pathname.split("/").filter(Boolean);
  } else {
    // owner/repo 줄임 — 그 뒤에 아무것도 붙지 않은 것만
    parts = value.split("/");
    if (parts.length !== 2) return null;
  }
  if (parts.length < 2) return null;
  const owner = parts[0].toLowerCase();
  const repo = parts[1].replace(/\.git$/i, "").toLowerCase();
  if (!isGithubRepositoryName(owner, repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
}

/** GitHub 이 저장소에 대해 답한 주인 사실 — repoId 는 저장소 숫자 id(답에 있을 때) */
export type RepoOwnerFact = { ownerId: number; ownerType: string; private: boolean; repoId?: number };
export type ClaimRejection = "org_repo_not_supported_yet" | "owner_mismatch" | "repo_not_found" | "repo_not_public";
export type OwnershipDecision = { ok: true; githubUserId: number } | { ok: false; reason: ClaimRejection };

/**
 * 주인 판정(순수) — 개인 계정 저장소이고 주인 숫자 id 가 내 GitHub 숫자 id 중 하나와 같을 때만 주인이다.
 * 이름이 바뀐 계정도 숫자 id 는 그대로라 통과하고, 옮겨 간 저장소는 주인 id 가 달라 거절된다. 조직 저장소는 아직 받지 않는다.
 * 수집할 때 본 저장소 숫자 id(knownRepoId)가 있으면 같은 저장소여야 한다 — 옛 이름을 차지해 같은 주소에 새로 만든 저장소는 다른 저장소다
 */
export function decideOwnership(githubUserIds: readonly number[], fact: RepoOwnerFact | null, knownRepoId: number | null = null): OwnershipDecision {
  if (!fact) return { ok: false, reason: "repo_not_found" };
  if (fact.private) return { ok: false, reason: "repo_not_public" };
  if (knownRepoId !== null && fact.repoId !== undefined && fact.repoId !== knownRepoId) return { ok: false, reason: "owner_mismatch" };
  if (fact.ownerType === "Organization") return { ok: false, reason: "org_repo_not_supported_yet" };
  if (fact.ownerType !== "User" || !isGithubNumericId(fact.ownerId)) return { ok: false, reason: "owner_mismatch" };
  const match = githubUserIds.find((id) => isGithubNumericId(id) && id === fact.ownerId);
  return match === undefined ? { ok: false, reason: "owner_mismatch" } : { ok: true, githubUserId: match };
}

export type RepoLookup = { kind: "found"; fact: RepoOwnerFact } | { kind: "missing" } | { kind: "unavailable" };

/**
 * GET /repos/{owner}/{repo} 한 번 — 이름이 바뀌었거나 옮겨 간 저장소는 GitHub 이 /repositories/{id} 로 넘겨 주고
 * 수집기 요청이 API 안에서만 따라간다(lib/crawl/github.ts). 404·410·451 은 없음, 한도·인증·5xx 는 나중에 다시
 */
export async function lookupRepositoryOwner(ref: RepoRef, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<RepoLookup> {
  const result = await githubRequest<Record<string, unknown>>(`/repos/${ref.owner}/${ref.repo}`, {},
    { deadlineAt: options.deadlineAt ?? Date.now() + 10_000, signal: options.signal });
  if (!result.ok) {
    if (result.error.kind === "not_found") return { kind: "missing" };
    if (result.error.kind === "http" && (result.error.status === 410 || result.error.status === 451)) return { kind: "missing" };
    return { kind: "unavailable" };
  }
  if (result.status !== 200 || !result.value || typeof result.value !== "object") return { kind: "unavailable" };
  const owner = result.value.owner && typeof result.value.owner === "object" ? result.value.owner as Record<string, unknown> : null;
  if (!owner || !isGithubNumericId(owner.id) || typeof owner.type !== "string" || typeof result.value.private !== "boolean") return { kind: "unavailable" };
  return { kind: "found", fact: { ownerId: owner.id, ownerType: owner.type, private: result.value.private,
    ...(isGithubNumericId(result.value.id) ? { repoId: result.value.id } : {}) } };
}

/** 수집할 때 본 저장소 숫자 id(crawl_documents.repo_meta.id, 같은 이름의 가장 최근 원본). 수집하지 않은 저장소면 null */
export async function knownRepositoryId(ref: RepoRef): Promise<number | null> {
  const [row] = await db.select({ id: sql<string | null>`${crawlDocuments.repoMeta}->>'id'` }).from(crawlDocuments)
    .where(sql`lower(${crawlDocuments.repo}) = ${ref.fullName}`)
    .orderBy(desc(crawlDocuments.fetchedAt), desc(crawlDocuments.id)).limit(1);
  const id = Number(row?.id);
  return isGithubNumericId(id) ? id : null;
}

/**
 * 운영자 확인의 GitHub 답 — 저장소마다 있음·없음을 10분 들고 있어 같은 저장소를 여러 번 눌러도 한 번만 묻는다.
 * 답하지 못한 것(unavailable)과 한도에 걸린 것은 담지 않는다. 재확인 잡은 늘 새로 묻는다
 */
const claimAnswers = createMemo<RepoLookup>({ ttlMs: 10 * 60_000, max: 2_000 });
class ClaimLookupSkipped extends Error {}

async function claimLookup(userId: number, ref: RepoRef, lookup: Lookup, options: { deadlineAt: number; signal?: AbortSignal }): Promise<RepoLookup> {
  return claimAnswers.get(ref.fullName, async () => {
    // 실제로 부를 때만 센다 — 계정 한도를 먼저 봐서 한 계정이 전체 한도를 다 쓰지 못하게
    if (!(await rateLimit(`maker:claims:github:user:${userId}`, CLAIM_LOOKUPS_PER_USER_HOUR, HOUR_MS))
      || !(await rateLimit("maker:claims:github", CLAIM_LOOKUPS_PER_HOUR, HOUR_MS))) {
      logger.warn("maker.claim_lookup_limited", { userId });
      throw new ClaimLookupSkipped();
    }
    const answer = await lookup(ref, options);
    if (answer.kind === "unavailable") throw new ClaimLookupSkipped();
    return answer;
  }).catch((error: unknown) => {
    if (error instanceof ClaimLookupSkipped) return { kind: "unavailable" } as const;
    throw error;
  });
}

export type Lookup = typeof lookupRepositoryOwner;

/** 이 계정의 GitHub 숫자 id — public_identities(provider='github', subject = 숫자 id) */
export async function githubUserIdsOf(userId: number): Promise<number[]> {
  const rows = await onPrimary(() => db.select({ subject: publicIdentities.subject }).from(publicIdentities)
    .where(and(eq(publicIdentities.userId, userId), eq(publicIdentities.provider, "github"))).orderBy(asc(publicIdentities.id)));
  return rows.map((row) => Number(row.subject)).filter((id) => /^[1-9]\d*$/.test(String(id)) && isGithubNumericId(id));
}

export type ClaimResult = "verified" | "already_verified" | ClaimRejection | "not_found" | "no_github_repo" | "github_unavailable";
export type ClaimItem = { productId: number; slug: string | null; name: string | null; repo: string | null; result: ClaimResult };
export type ClaimInput = { productIds: number[] } | { repoUrl: string };
type ClaimProduct = { id: number; slug: string; name: string; status: string; repoUrl: string | null };

/** 요청 본문 → 확인할 것. productIds 는 1~20개 양의 정수(겹치면 하나로), repoUrl 은 저장소 주소 하나 */
export function parseClaimInput(value: unknown): ClaimInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MakerError("invalid_request", 400);
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "productIds" && Array.isArray(body.productIds)) {
    const ids = body.productIds;
    if (ids.length < 1 || ids.length > CLAIM_BATCH_LIMIT || !ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0 && (id as number) <= 2_147_483_647)) {
      throw new MakerError("invalid_request", 400);
    }
    return { productIds: [...new Set(ids as number[])] };
  }
  if (keys.length === 1 && keys[0] === "repoUrl" && typeof body.repoUrl === "string") return { repoUrl: body.repoUrl };
  throw new MakerError("invalid_request", 400);
}

/** 확인 결과를 남긴다 — 같은 제품·계정이면 다시 살려 쓴다(멱등). 주인 없는 수집 제품이면 claimed_at 도 적는다 */
async function recordOwnerMembership(product: ClaimProduct, userId: number, githubUserId: number): Promise<boolean> {
  return onPrimary(() => db.transaction(async (tx) => {
    // 제품 쓰기와 같은 잠금 차례(repository.update · markVerified)
    await lockPipelineInputStages(tx);
    if (!(await lockProductGeneration(tx, product.id, product.slug))) return false;
    const [current] = await tx.select({ status: products.status, repoUrl: products.repoUrl })
      .from(products).where(eq(products.id, product.id));
    // GitHub 을 읽는 사이 저장소 주소가 바뀌었거나 내려갔으면 그 확인은 이 행의 것이 아니다
    if (!current || !(PUBLIC_STATUSES as readonly string[]).includes(current.status) || current.repoUrl !== product.repoUrl) return false;
    const recheckAt = sql`now() + ${MAKER_RECHECK_DAYS} * interval '1 day'`;
    await tx.insert(productMakerMembers).values({ productId: product.id, userId, role: "owner", githubUserId, method: "github_repo_owner", recheckAt })
      .onConflictDoUpdate({ target: [productMakerMembers.productId, productMakerMembers.userId], set: {
        role: "owner", githubUserId, method: "github_repo_owner", verifiedAt: sql`now()`, recheckAt, revokedAt: null, revokedReason: null,
      } });
    // products.claimed_at·builder 는 건드리지 않는다 — 그 칸은 도메인 검증(verify.ts)이 수정 키를 주는 근거라,
    // 여기서 채우면 진짜 도메인 주인의 클레임을 막고 자격이 풀려도 되돌릴 수 없다. 운영자 여부는 product_maker_members 로만 본다
    return true;
  }));
}

/**
 * 운영자 확인 — 제품마다 GitHub 에 주인을 물어 결과를 하나씩 돌려준다. 이미 확인한 제품은 GitHub 을 다시 부르지 않는다(멱등).
 * 로그인·CSRF·한도는 라우트가 본다. GitHub 로그인 신원이 없으면 403
 */
export async function claimProducts(userId: number, input: ClaimInput, options: { lookup?: Lookup; deadlineAt?: number; signal?: AbortSignal } = {}): Promise<ClaimItem[]> {
  const githubIds = await githubUserIdsOf(userId);
  if (githubIds.length === 0) throw new MakerError("github_login_required", 403);
  const lookup = options.lookup ?? lookupRepositoryOwner;
  const deadlineAt = options.deadlineAt ?? Date.now() + 25_000;
  const columns = { id: products.id, slug: products.slug, name: products.name, status: products.status, repoUrl: products.repoUrl };

  let targets: { id: number; product: ClaimProduct | null }[];
  if ("repoUrl" in input) {
    const ref = parseRepoUrl(input.repoUrl);
    if (!ref) throw new MakerError("invalid_repo_url", 400);
    const found = await onPrimary(() => db.select(columns).from(products).where(and(
      inArray(products.status, [...PUBLIC_STATUSES]),
      or(
        sql`regexp_replace(regexp_replace(lower(rtrim(${products.repoUrl}, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '') = ${ref.url}`,
        // 부분 색인(products_renamed_to_idx)을 타도록 — 두 갈래가 모두 색인을 타야 OR 이 제품 전부를 훑지 않는다
        sql`(${products.repoRenamedTo} is not null and lower(${products.repoRenamedTo}) = ${ref.fullName})`,
      ),
    )).orderBy(asc(products.id)).limit(CLAIM_BATCH_LIMIT));
    if (found.length === 0) throw new MakerError("repo_not_listed", 404);
    targets = found.map((product) => ({ id: product.id, product }));
  } else {
    const found = await onPrimary(() => db.select(columns).from(products).where(inArray(products.id, input.productIds)));
    const byId = new Map(found.map((product) => [product.id, product]));
    targets = input.productIds.map((id) => ({ id, product: byId.get(id) ?? null }));
  }

  const ids = targets.flatMap((target) => target.product ? [target.product.id] : []);
  const active = new Set(ids.length === 0 ? [] : (await onPrimary(() => db.select({ productId: productMakerMembers.productId }).from(productMakerMembers)
    .where(and(eq(productMakerMembers.userId, userId), inArray(productMakerMembers.productId, ids), isNull(productMakerMembers.revokedAt))))).map((row) => row.productId));

  const results: ClaimItem[] = [];
  for (const { id, product } of targets) {
    const item = (result: ClaimResult, repo: string | null = null): ClaimItem => ({ productId: id, slug: product?.slug ?? null, name: product?.name ?? null, repo, result });
    // 공개 목록에 없는 제품은 있는지조차 말하지 않는다
    if (!product || !(PUBLIC_STATUSES as readonly string[]).includes(product.status)) { results.push({ productId: id, slug: null, name: null, repo: null, result: "not_found" }); continue; }
    const ref = parseRepoUrl(product.repoUrl);
    if (!ref) { results.push(item("no_github_repo")); continue; }
    if (active.has(product.id)) { results.push(item("already_verified", ref.fullName)); continue; }
    if (options.signal?.aborted || Date.now() >= deadlineAt - 1_000) { results.push(item("github_unavailable", ref.fullName)); continue; }
    const answer = await claimLookup(userId, ref, lookup, { deadlineAt: Math.min(deadlineAt, Date.now() + 10_000), signal: options.signal });
    if (answer.kind === "unavailable") { results.push(item("github_unavailable", ref.fullName)); continue; }
    const decision = decideOwnership(githubIds, answer.kind === "found" ? answer.fact : null, await knownRepositoryId(ref));
    if (!decision.ok) { results.push(item(decision.reason, ref.fullName)); continue; }
    const recorded = await recordOwnerMembership(product, userId, decision.githubUserId);
    if (recorded) logger.info("maker.claimed", { productId: product.id, userId, method: "github_repo_owner" });
    results.push(item(recorded ? "verified" : "not_found", ref.fullName));
  }
  return results;
}

/** 재확인 잡 한 틱의 결과 */
export type RecheckSummary = { checked: number; kept: number; revoked: number; deferred: number };

/**
 * 운영자 확인 다시 보기 — 재확인 날짜가 지난 github_repo_owner 행을 오래된 것부터 본다. 주인이 같으면 30일 뒤로 미루고,
 * 저장소가 없어졌거나 옮겨 갔거나(주인 id 가 다름) 조직으로 넘어갔거나 GitHub 로그인 신원이 사라졌으면 풀어 둔다(revoked_*).
 * GitHub 이 답하지 못하면 6시간 뒤에 다시 — 세 번 이어지면 이번 틱을 접는다(한도·자격 없음)
 */
export async function recheckMakerMemberships(options: {
  lease?: JobLease; deadlineAt: number; signal?: AbortSignal; hasBudget?: () => boolean; limit?: number; lookup?: Lookup;
}): Promise<RecheckSummary> {
  const lookup = options.lookup ?? lookupRepositoryOwner;
  const due = await onPrimary(() => db.select({
    productId: productMakerMembers.productId, userId: productMakerMembers.userId, githubUserId: productMakerMembers.githubUserId,
    // 시각은 글자로 읽어 그대로 비교한다 — JS Date 는 마이크로초를 버려 같은 값을 다르게 본다
    recheckAt: sql<string | null>`${productMakerMembers.recheckAt}::text`, repoUrl: products.repoUrl, identityId: publicIdentities.id,
  }).from(productMakerMembers)
    .innerJoin(products, eq(products.id, productMakerMembers.productId))
    .leftJoin(publicIdentities, and(eq(publicIdentities.userId, productMakerMembers.userId), eq(publicIdentities.provider, "github"),
      eq(publicIdentities.subject, sql`${productMakerMembers.githubUserId}::text`)))
    .where(and(isNull(productMakerMembers.revokedAt), eq(productMakerMembers.method, "github_repo_owner"),
      or(isNull(productMakerMembers.recheckAt), lte(productMakerMembers.recheckAt, sql`now()`))))
    .orderBy(sql`${productMakerMembers.recheckAt} asc nulls first`, asc(productMakerMembers.productId))
    .limit(options.limit ?? 20));

  const summary: RecheckSummary = { checked: 0, kept: 0, revoked: 0, deferred: 0 };
  let unavailableInRow = 0;
  for (const row of due) {
    if (options.signal?.aborted || (options.hasBudget && !options.hasBudget()) || Date.now() >= options.deadlineAt - 2_000) break;
    const ref = parseRepoUrl(row.repoUrl);
    let outcome: { keep: true } | { keep: false; reason: string } | null;
    if (row.githubUserId === null || row.identityId === null) outcome = { keep: false, reason: "identity_removed" };
    else if (!ref) outcome = { keep: false, reason: "repo_changed" };
    else {
      const answer = await lookup(ref, { deadlineAt: Math.min(options.deadlineAt, Date.now() + 10_000), signal: options.signal });
      if (answer.kind === "unavailable") outcome = null;
      else {
        const decision = decideOwnership([row.githubUserId], answer.kind === "found" ? answer.fact : null, await knownRepositoryId(ref));
        outcome = decision.ok ? { keep: true } : { keep: false, reason: decision.reason };
      }
    }
    // 읽은 뒤 다시 확인(claim)됐거나 이미 풀렸으면 건드리지 않는다
    const same = and(eq(productMakerMembers.productId, row.productId), eq(productMakerMembers.userId, row.userId), isNull(productMakerMembers.revokedAt),
      row.recheckAt === null ? isNull(productMakerMembers.recheckAt) : sql`${productMakerMembers.recheckAt} = ${row.recheckAt}::timestamptz`);
    summary.checked += 1;
    if (outcome === null) {
      summary.deferred += 1;
      await withJobLeaseWrite(options.lease, (tx) => tx.update(productMakerMembers).set({ recheckAt: sql`now() + interval '6 hours'` }).where(same));
      if (++unavailableInRow >= 3) break;
      continue;
    }
    unavailableInRow = 0;
    if (outcome.keep) {
      summary.kept += 1;
      await withJobLeaseWrite(options.lease, (tx) => tx.update(productMakerMembers)
        .set({ recheckAt: sql`now() + ${MAKER_RECHECK_DAYS} * interval '1 day'` }).where(same));
    } else {
      summary.revoked += 1;
      await withJobLeaseWrite(options.lease, (tx) => tx.update(productMakerMembers)
        .set({ revokedAt: sql`now()`, revokedReason: outcome.reason.slice(0, 40) }).where(same));
      logger.info("maker.revoked", { productId: row.productId, userId: row.userId, reason: outcome.reason });
    }
  }
  return summary;
}

/**
 * 새 등재 알림(new_listing_mine) — 수집기가 올린 제품의 저장소 주인이 GitHub 로 로그인한 계정이면 알림함에 한 줄.
 * 발행할 때 이미 가진 저장소 원본(repo_meta)의 owner.id 만 본다(GitHub 을 다시 부르지 않는다). 제품마다 한 번(dedupe).
 * lib/me/notify.ts 는 server-only 라 워커가 부를 수 없어 같은 insert 를 여기서 한다. 넣었으면 true
 */
export async function notifyNewListingMine(input: { slug: string; repoMeta: Record<string, unknown> | null | undefined }, lease?: JobLease): Promise<boolean> {
  const owner = input.repoMeta?.owner && typeof input.repoMeta.owner === "object" ? input.repoMeta.owner as Record<string, unknown> : null;
  if (!owner || owner.type !== "User" || !isGithubNumericId(owner.id)) return false;
  const fullName = typeof input.repoMeta?.full_name === "string" && input.repoMeta.full_name.length <= 140 ? input.repoMeta.full_name : null;
  const [row] = await onPrimary(() => db.select({ productId: products.id, name: products.name, userId: publicIdentities.userId }).from(products)
    .innerJoin(publicIdentities, and(eq(publicIdentities.provider, "github"), eq(publicIdentities.subject, String(owner.id))))
    .innerJoin(publicUsers, and(eq(publicUsers.id, publicIdentities.userId), isNull(publicUsers.deletedAt)))
    .where(and(eq(products.slug, input.slug), inArray(products.status, [...PUBLIC_STATUSES]))).limit(1));
  if (!row) return false;
  const inserted = await withJobLeaseWrite(lease, async (tx) => {
    const rows = await tx.insert(notifications).values({
      userId: row.userId, kind: "new_listing_mine", productId: row.productId,
      payload: { name: row.name, ...(fullName ? { repo: fullName } : {}) }, dedupeKey: `new_listing_mine:${row.productId}`,
    }).onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
      .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind, productId: notifications.productId, dedupeKey: notifications.dedupeKey });
    // «즉시» 메일은 같은 lease 쓰기 안에서 줄 세운다(던지지 않는다)
    await enqueueNotificationEmails(rows, tx);
    return rows;
  });
  return inserted.length > 0;
}

/** 다음 재확인 날짜 계산(화면용) — 날짜가 없으면 확인 시각 + 30일 */
export function nextRecheckDate(verifiedAt: Date, recheckAt: Date | null): Date {
  return recheckAt ?? new Date(verifiedAt.getTime() + MAKER_RECHECK_DAYS * DAY_MS);
}
