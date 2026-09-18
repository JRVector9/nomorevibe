import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products, productAuditAttempts, productAuditCampaigns, productAuditItems,
  type ProductAuditCampaign } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { banProduct } from "@/lib/domain/products/manage";
import { uniqueViolation } from "@/lib/domain/products/repository";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { getSettings } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import { firstReviewer } from "./agent-review";
import { loadReviewInput } from "./agent-review-repository";
import { createReviewInput, MAX_REVIEW_ATTEMPTS, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash,
  type ReviewInput, type ReviewOutcome } from "./agent-review-contract";

/**
 * 발행분 감사 — 올리고, 묻고, 적고, 사람이 정한다.
 *
 * 여기서 쓰는 표는 product_audit_* 셋뿐이다. 사람이 "내리기"를 누를 때만 banProduct 를 부른다.
 * 모델의 답으로는 아무것도 바뀌지 않는다 — 스키마 주석(lib/db/product-audit-schema.ts)에 까닭이 있다.
 */

/** 공개 목록에 떠 있는 상태 — 감사 대상이자 "아직 내릴 수 있는" 상태 */
const LISTED = ["seeded", "verified"] as const;
const listed = inArray(products.status, [...LISTED]);

/**
 * 유지 판정이 다음 감사에서 제품을 빼 주는 기간.
 *
 * 사람이 페이지를 열어 보고 "둔다"고 정한 것을 감사 때마다 다시 보게 하면 그 판단이 버려진다.
 * 그렇다고 영원히 빼면 그 사이 주인이 떠나 빈 페이지가 된 것을 놓친다. 페이지가 바뀌면 기간과
 * 상관없이 다시 넣으므로(sourceHash), 이 기한은 "바뀐 줄 모르고 망가진 것"을 건지는 그물이다.
 */
export const KEEP_DAYS = 90;

/**
 * 모델이 본 페이지 내용의 해시. 사람이 유지로 둔 그 페이지가 지금도 그대로인지 가른다.
 *
 * 심사 입력의 product 부분(이름·소개·본문·주소·토픽·README)만 본다. 스타·푸시 시각·규칙 판정·
 * 프롬프트 버전은 뺀다 — 그것들이 바뀌어도 사람이 본 페이지는 그대로다.
 */
export function auditSourceHash(input: Pick<ReviewInput, "snapshot">): string {
  return reviewHash(input.snapshot.product);
}

/**
 * 감사가 모델에게 보여 줄 입력의 기준. 발행 문과 두 가지만 다르다.
 *
 * 1. 푸시 나이를 끈다. 이 규칙은 거부 사유가 "unreachable"이라, 입력의 rules 에 그대로 실리면
 *    모델에게 "닿지 않는다"로 읽힌다. 실측(2026-09-10): 이 규칙에 걸린 공개분 31건을 전부 열어
 *    봤더니 31건 모두 HTTP 200이었다 — 발행분 재검수(recheck.ts)가 같은 이유로 끈다.
 * 2. 개발 근거 강제(enforceEligibility)를 끈다. 감사가 묻는 것은 "지금 열어서 쓸 수 있나"이고,
 *    개발 근거는 따로 거는 문이다. 켜 둔 채 물으면 프롬프트가 "근거가 없으면 승인하지 말라"고
 *    하는데, 공개분 대부분은 스캔이 24시간을 넘겨 근거가 pending 이다 — 멀쩡한 제품도 전부
 *    승인 밖으로 밀려 목록이 거짓 후보로 덮인다.
 */
export function auditSettings(settings: CrawlSettings): CrawlSettings {
  return {
    ...settings,
    judge: { ...settings.judge, maxPushAgeDays: Number.MAX_SAFE_INTEGER },
    agentEvidence: { ...settings.agentEvidence, enforceEligibility: false },
  };
}

// ─────────────────────────── 올리기 ───────────────────────────

export type StartAuditResult =
  | { ok: true; campaignId: number; enrolled: number; keptSkipped: number }
  | { ok: false; error: string };

/**
 * 감사를 연다 — 관리자 화면의 "재감사 시작"과 scripts/start-product-audit.ts 가 같이 쓴다.
 *
 * 공개된 제품을 전부 올리되, 살아 있는 유지 판정이 있는 것은 뺀다(reauditKept 가 아니면).
 * 주인이 있는 제품(클레임·검증)도 올린다 — 주인이 있다고 제품이라는 보장은 없다. 다만 잡이
 * 주인 없는 것부터 묻고 화면도 그 뒤에 보인다.
 */
export async function startProductAudit(input: {
  startedBy: string; reason: string; reauditKept: boolean;
}): Promise<StartAuditResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, error: "왜 다시 보는지 적어주세요. 감사 기록에 남습니다." };
  const settings = await getSettings();
  const reviewer = firstReviewer(settings);
  if (!reviewer) return { ok: false, error: "1차 심사자를 설정해야 감사를 시작할 수 있습니다." };
  try {
    return await db.transaction(async (tx) => {
      const [campaign] = await tx.insert(productAuditCampaigns).values({
        startedBy: input.startedBy.slice(0, 120), reason: reason.slice(0, 500),
        promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
        provider: reviewer.provider, model: reviewer.model, reauditKept: input.reauditKept,
      }).returning({ id: productAuditCampaigns.id });
      const all = await tx.select({ id: products.id, slug: products.slug }).from(products)
        .where(listed).orderBy(asc(products.id));
      const kept = input.reauditKept ? new Set<number>() : await liveKeptProducts(tx, settings);
      const rows = all.filter((product) => !kept.has(product.id))
        .map((product) => ({ campaignId: campaign.id, productId: product.id, slug: product.slug }));
      // 한 문장에 넣는 값 수에는 상한이 있다(65,535). 1,000행씩이면 3열 × 1,000 = 3,000개다
      for (let index = 0; index < rows.length; index += 1_000) {
        await tx.insert(productAuditItems).values(rows.slice(index, index + 1_000));
      }
      return { ok: true as const, campaignId: campaign.id, enrolled: rows.length, keptSkipped: all.length - rows.length };
    });
  } catch (error) {
    if (uniqueViolation(error) === "product_audit_one_running_idx") {
      return { ok: false, error: "이미 진행 중인 감사가 있습니다. 끝나거나 중단한 뒤에 시작하세요." };
    }
    throw error;
  }
}

/**
 * 살아 있는 유지 판정 — 기한 안이고, 사람이 유지로 둔 그 페이지가 지금도 그대로인 것.
 *
 * 지금의 해시는 수집 원본(후보·문서)만으로 다시 만든다. product 부분은 스캔·근거와 무관하므로
 * 스캔을 읽지 않아도 잡이 물을 때 만든 해시와 같은 값이 나온다.
 */
async function liveKeptProducts(tx: ProductTransaction, settings: CrawlSettings): Promise<Set<number>> {
  const rows = await tx.select({
    productId: productAuditItems.productId, sourceHash: productAuditItems.sourceHash,
    candidate: crawlCandidates, document: crawlDocuments,
  }).from(productAuditItems)
    .innerJoin(products, eq(products.id, productAuditItems.productId))
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(productAuditItems.humanDecision, "kept"), sql`${productAuditItems.keepUntil} > now()`, listed));
  const kept = new Set<number>();
  for (const row of rows) {
    const current = createReviewInput(row.candidate, row.document, auditSettings(settings), { scan: null, observations: [] });
    if (row.sourceHash === auditSourceHash(current)) kept.add(row.productId);
  }
  return kept;
}

/** 멈춘다. 아무것도 내리지 않고, 지금까지 찾은 것은 목록에 남는다 */
export async function cancelProductAudit(): Promise<boolean> {
  const rows = await db.update(productAuditCampaigns).set({ status: "cancelled", finishedAt: sql`now()` })
    .where(eq(productAuditCampaigns.status, "running")).returning({ id: productAuditCampaigns.id });
  return rows.length > 0;
}

// ─────────────────────────── 묻기 (잡) ───────────────────────────

export async function runningAuditCampaign(): Promise<ProductAuditCampaign | null> {
  const [campaign] = await db.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.status, "running")).limit(1);
  return campaign ?? null;
}

/**
 * 아직 물을 것. 원본이 없어 물을 수 없는 것(no_source)과 시도를 다 쓴 것은 뺀다.
 * 그 사이 내려간 제품도 뺀다 — 이미 목록에 없는 것을 물을 까닭이 없다.
 */
const unanswered: SQL = and(isNull(productAuditItems.aiDecision), lt(productAuditItems.attempts, MAX_REVIEW_ATTEMPTS),
  sql`${productAuditItems.errorCode} is distinct from 'no_source'`)!;
/** 주인이 있는 것(클레임·검증)은 뒤로 — 주인 없는 수집분에서 걸릴 것이 훨씬 많다 */
const owned = sql<boolean>`(${products.claimedAt} is not null or ${products.status} = 'verified')`;

export async function pendingAuditItems(campaignId: number, limit: number) {
  return db.select({ id: productAuditItems.id, slug: products.slug }).from(productAuditItems)
    .innerJoin(products, eq(products.id, productAuditItems.productId))
    .where(and(eq(productAuditItems.campaignId, campaignId), unanswered, listed,
      sql`(${productAuditItems.retryAt} is null or ${productAuditItems.retryAt} <= now())`))
    .orderBy(owned, asc(productAuditItems.id))
    .limit(limit);
}

/** 발행 문과 같은 입력(createReviewInput)을 만든다. 수집 원본이 없으면 null — 메이커가 직접 등록한 것 */
export async function loadAuditInput(slug: string, settings: CrawlSettings): Promise<ReviewInput | null> {
  const [row] = await db.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(eq(crawlCandidates.publishedSlug, slug)).limit(1);
  return row ? loadReviewInput(row.candidate, row.document, auditSettings(settings)) : null;
}

export async function markAuditNoSource(itemId: number, lease: JobLease): Promise<void> {
  await db.transaction(async (tx) => {
    await assertJobLease(tx, lease);
    await tx.update(productAuditItems).set({ errorCode: "no_source" })
      .where(and(eq(productAuditItems.id, itemId), isNull(productAuditItems.aiDecision)));
  });
}

export type AuditCall = { itemId: number; startedAt: Date; provider: string; model: string; input: ReviewInput };

/**
 * 한 번의 호출을 적는다. 호출 기록은 늘 남기고, 항목은 답을 받았을 때만 채운다.
 *
 * counted: 이 항목의 시도로 셀지. 심사자 자체가 없는 실패(키 없음·모델 없음)는 항목 탓이 아니라
 * 세지 않는다 — 세면 키 하나 빠진 동안 10,751건이 시도를 다 써 버린다.
 * 물러나기는 1차 심사 잡과 같다: 1분에서 시작해 두 배씩, 30분까지.
 */
export async function recordAuditResult(call: AuditCall & (
  { ok: true; outcome: ReviewOutcome } | { ok: false; error: string; counted: boolean }
), lease: JobLease): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx.select().from(productAuditItems).where(eq(productAuditItems.id, call.itemId)).for("update");
    await assertJobLease(tx, lease);
    if (!item || item.aiDecision) return;
    await tx.insert(productAuditAttempts).values({
      itemId: item.id, startedAt: call.startedAt, provider: call.provider.slice(0, 80), model: call.model.slice(0, 160),
      inputHash: call.input.inputHash, source: call.input.source,
      outcome: call.ok ? call.outcome : null, errorCode: call.ok ? null : call.error.slice(0, 120),
    });
    if (call.ok) {
      await tx.update(productAuditItems).set({
        aiDecision: call.outcome.decision, aiReason: call.outcome.reason, aiConfidence: call.outcome.confidence ?? null,
        aiCategory: call.outcome.category ?? null, sourceHash: auditSourceHash(call.input), reviewedAt: sql`now()`,
        attempts: item.attempts + 1, errorCode: null, retryAt: null,
      }).where(eq(productAuditItems.id, item.id));
    } else if (call.counted) {
      const backoffMs = Math.min(30 * 60_000, 60_000 * 2 ** item.attempts);
      await tx.update(productAuditItems).set({
        attempts: item.attempts + 1, errorCode: call.error.slice(0, 120),
        retryAt: sql`now() + ${backoffMs} * interval '1 millisecond'`,
      }).where(eq(productAuditItems.id, item.id));
    }
  });
}

/** 물을 것이 하나도 남지 않았으면 닫는다. 물러나기 중인 것이 있으면 아직 열어 둔다 */
export async function finishAuditCampaign(campaignId: number): Promise<boolean> {
  const rows = await db.update(productAuditCampaigns).set({ status: "done", finishedAt: sql`now()` })
    .where(and(eq(productAuditCampaigns.id, campaignId), eq(productAuditCampaigns.status, "running"),
      sql`not exists (${db.select({ id: productAuditItems.id }).from(productAuditItems)
        .innerJoin(products, eq(products.id, productAuditItems.productId))
        .where(and(eq(productAuditItems.campaignId, campaignId), unanswered, listed))})`))
    .returning({ id: productAuditCampaigns.id });
  return rows.length > 0;
}

// ─────────────────────────── 화면 ───────────────────────────

export type AuditCounts = {
  total: number; reviewed: number; reject: number; needsReview: number;
  /** 사람이 아직 손대지 않았고 제품이 아직 떠 있는 것 — 목록에 보이는 수 */
  openReject: number; openNeedsReview: number;
  removed: number; kept: number;
  /** 원본이 없거나 시도를 다 써서 답을 못 받은 것 */
  failed: number;
  /** 묻기 전에 목록에서 내려가 건너뛴 것 — 이것까지 더해야 끝난 감사의 수가 맞는다 */
  skipped: number;
};
export type AuditOverview = {
  campaign: ProductAuditCampaign | null;
  counts: AuditCounts;
  /** 진행 중인데 잡이 묻지 않고 있는 까닭. 없으면 null */
  paused: string | null;
};

export async function productAuditOverview(): Promise<AuditOverview> {
  const [campaign] = await db.select().from(productAuditCampaigns).orderBy(desc(productAuditCampaigns.id)).limit(1);
  const empty: AuditCounts = { total: 0, reviewed: 0, reject: 0, needsReview: 0, openReject: 0, openNeedsReview: 0, removed: 0, kept: 0, failed: 0, skipped: 0 };
  if (!campaign) return { campaign: null, counts: empty, paused: null };
  const open = sql`${productAuditItems.humanDecision} is null and ${products.status} in ('seeded', 'verified')`;
  const failed = sql`${productAuditItems.aiDecision} is null
    and (${productAuditItems.errorCode} is not distinct from 'no_source' or ${productAuditItems.attempts} >= ${MAX_REVIEW_ATTEMPTS})`;
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
    reviewed: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} is not null)::int`,
    reject: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'reject')::int`,
    needsReview: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'needs_review')::int`,
    openReject: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'reject' and ${open})::int`,
    openNeedsReview: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'needs_review' and ${open})::int`,
    removed: sql<number>`count(*) filter (where ${productAuditItems.humanDecision} = 'removed')::int`,
    kept: sql<number>`count(*) filter (where ${productAuditItems.humanDecision} = 'kept')::int`,
    failed: sql<number>`count(*) filter (where ${failed})::int`,
    skipped: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} is null and not (${failed})
      and (${products.status} is null or ${products.status} not in ('seeded', 'verified')))::int`,
  }).from(productAuditItems).leftJoin(products, eq(products.id, productAuditItems.productId))
    .where(eq(productAuditItems.campaignId, campaign.id));
  let paused: string | null = null;
  if (campaign.status === "running") {
    const settings = await getSettings();
    if (!settings.enabled) paused = "크롤 설정의 수집 스위치가 꺼져 있어 멈춰 있습니다. 켜면 이어서 봅니다.";
    else if (campaign.promptVersion !== REVIEW_PROMPT_VERSION || campaign.rulesVersion !== REVIEW_RULES_VERSION) {
      paused = `시작한 뒤 심사 글이 바뀌었습니다(글 ${campaign.promptVersion}·규칙 ${campaign.rulesVersion} → `
        + `글 ${REVIEW_PROMPT_VERSION}·규칙 ${REVIEW_RULES_VERSION}). `
        + "두 글의 판단을 한 목록에 섞지 않도록 멈췄습니다. 이 감사를 중단하고 새로 시작하세요.";
    }
  }
  return { campaign, counts: counts ?? empty, paused };
}

export type AuditFindingRow = {
  id: number; slug: string; name: string; url: string; category: string;
  reason: string | null; confidence: number | null; reviewedAt: Date | null; owned: boolean;
};

/** 사람이 볼 것 — 아직 아무도 손대지 않았고 제품이 아직 떠 있는 것. 주인 없는 것 먼저, 확신 높은 순 */
export async function listAuditFindings(campaignId: number, decision: "reject" | "needs_review",
  { limit, offset }: { limit: number; offset: number }): Promise<AuditFindingRow[]> {
  return db.select({
    id: productAuditItems.id, slug: products.slug, name: products.name, url: products.url, category: products.category,
    reason: productAuditItems.aiReason, confidence: productAuditItems.aiConfidence, reviewedAt: productAuditItems.reviewedAt,
    owned,
  }).from(productAuditItems).innerJoin(products, eq(products.id, productAuditItems.productId))
    .where(and(eq(productAuditItems.campaignId, campaignId), eq(productAuditItems.aiDecision, decision),
      isNull(productAuditItems.humanDecision), listed))
    .orderBy(owned, sql`${productAuditItems.aiConfidence} desc nulls last`, asc(productAuditItems.id))
    .limit(limit).offset(offset);
}

// ─────────────────────────── 사람의 결정 ───────────────────────────

export type AuditDecisionResult = { ok: true } | { ok: false; error: string };
const STALE = "이미 처리됐거나 화면이 오래됐습니다. 새로고침해주세요.";

/**
 * 한 제품을 내린다 — 차단(행은 남아 같은 URL의 재수집·재등록을 막고, 제품 화면에서 되돌릴 수 있다).
 *
 * 폼이 싣고 온 slug 가 이 항목의 제품과 지금도 같은지 먼저 본다. 다르면 아무것도 하지 않는다.
 * 차단을 먼저 하고 기록을 나중에 한다 — 거꾸로면 기록만 남고 제품은 떠 있는 상태가 생길 수 있다.
 */
export async function removeAuditedProduct(input: { itemId: number; slug: string; by: string }): Promise<AuditDecisionResult> {
  const [row] = await db.select({ humanDecision: productAuditItems.humanDecision, slug: products.slug })
    .from(productAuditItems).innerJoin(products, eq(products.id, productAuditItems.productId))
    .where(eq(productAuditItems.id, input.itemId));
  if (!row || row.slug !== input.slug || row.humanDecision) return { ok: false, error: STALE };
  const banned = await banProduct(input.slug);
  if (!banned.ok) return { ok: false, error: "제품을 찾지 못했습니다." };
  await db.update(productAuditItems).set({ humanDecision: "removed", humanBy: input.by.slice(0, 120), humanAt: sql`now()` })
    .where(and(eq(productAuditItems.id, input.itemId), isNull(productAuditItems.humanDecision)));
  return { ok: true };
}

/** 그대로 둔다. KEEP_DAYS 동안, 페이지가 그대로인 한 다음 감사에서 빠진다 */
export async function keepAuditedProduct(input: { itemId: number; slug: string; by: string; note: string }): Promise<AuditDecisionResult> {
  const rows = await db.update(productAuditItems).set({
    humanDecision: "kept", humanBy: input.by.slice(0, 120), humanAt: sql`now()`,
    humanNote: input.note.trim().slice(0, 500) || null,
    keepUntil: sql`now() + ${KEEP_DAYS} * interval '1 day'`,
  }).where(and(eq(productAuditItems.id, input.itemId), isNull(productAuditItems.humanDecision),
    sql`exists (select 1 from ${products} where ${products.id} = ${productAuditItems.productId} and ${products.slug} = ${input.slug})`))
    .returning({ id: productAuditItems.id });
  return rows.length ? { ok: true } : { ok: false, error: STALE };
}
