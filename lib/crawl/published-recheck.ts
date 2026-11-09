import { and, asc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, productAuditCampaigns, productAuditItems, productRecheckBaselines, products,
  type CrawlCandidate, type CrawlDocument, type ProductAuditCampaign, type ProductRecheckBaseline, type ProductRecheckBaselineSource } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { jobKnob, type RuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { cliContractRouteId } from "@/lib/llm/cli-serving-contract";
import { servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { aiTaskModelsReadState } from "@/lib/llm/ai-task-models-snapshot";
import { taskModels } from "@/lib/llm/ai-task-resolver";
import { AUDIT_DIRECT_ROUTE, aiTask } from "@/lib/llm/ai-tasks";
import { verifiedLocalModelContract } from "@/lib/llm/local-model-capacity";
import { cliEngineRevision, isCliEngineConnection } from "@/lib/llm/cli-engine-config";
import { cliHostTargetFromConnection } from "@/lib/operations/cli-host-target";
import { buildReviewProduct, MAX_REVIEW_ATTEMPTS, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewSnapshot } from "./agent-review-contract";
import { reviewCandidatePredicate } from "./agent-review-repository";
import { ROLLING_AUDIT_STATUS } from "./audit-stream";
import { auditSettings } from "./product-audit";
import { compareRecheckContent, packageProofKnownSince, recheckContent, recheckContentHash, type RecheckChangeSummary,
  type RecheckContent } from "./published-recheck-change";
import type { CrawlSettings } from "./settings-schema";

/**
 * 공개분 변경 재판정(2026-11-09 운영자 결정) — 이미 공개된 제품의 수집 내용이 모델이 마지막으로 본 것과 뜻있게 달라지면 다시 묻는다.
 * 모델은 재판정 자신의 설정 — 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(product-audit) 순위다. 1차 순위와 나뉜다.
 *
 * 1. 기준: 모델이 마지막으로 본 제품 내용 — 1차 심사의 마지막 성공 승인(crawl_review_attempts.snapshot 의 product), 이 재판정가 다시 본 뒤에는
 *    그 답이 본 내용(product_recheck_baselines, published-recheck-baseline.ts). 모델이 본 적 없는 공개 제품은 처음 본 지금 내용을 기준으로 삼는다(seeded).
 * 2. 지금 내용: 이미 받아 둔 원본(crawl_documents·후보)만으로 1차와 같은 함수(buildReviewProduct)로 만든다. GitHub·사이트를 새로 부르지 않는다.
 * 3. 견주기: published-recheck-change.ts 의 아홉 칸 규칙(글은 낱말 유사도). 뜻있게 바뀌었으면 감사 표의 늘 열린 줄(status 'rolling')에 항목을 올린다.
 * 4. 묻기: 감사 잡(product-audit)의 재판정 갈래(jobs/product-audit.ts askRecheckStream)가 발행분 감사 · 변경 재판정 순위(recheckReviewerPlan)로 묻는다 —
 *    답을 적는 길은 감사와 같다(recordAuditResult: 확신 높은 거절은 감사 보류, 사람은 /admin/audit 에서 내리기·유지). 아무것도 저절로 내리지 않는다.
 *
 * 이 모듈의 잡(published-recheck)은 1~3 만 한다 — 모델을 부르지 않는다. 공개 제품을 id 순서로 한 바퀴씩 돌며(틱마다 scanBatch 건) 마지막으로 견준 해시와
 * 같으면 본문을 읽지 않고 넘어간다. 하루 올리는 수는 실시간 한도(jobs.published-recheck)가 정한다.
 */
export const RECHECK_JOB = "published-recheck";
export const RECHECK_ACTOR = "system:published-recheck";
/** 재판정 줄 행의 provider·model 칸 — 줄에는 굳힌 심사자가 없다(발행분 감사 · 변경 재판정 순위가 묻는 때마다 고른다) */
export const RECHECK_REVIEWER_LABEL = "product-audit-ranks";

export type RecheckLimits = Readonly<{ scanBatch: number; dailyCap: number; askBatch: number; minSimilarity: number; yieldHours: number }>;

/** 실시간 한도(관리자 /admin/models/limits 의 잡별 묶음 — published-recheck 줄). minSimilarity 는 0~1 로 바꿔 돌려준다 */
export function recheckLimits(settings: RuntimeSettings = runtimeSettings()): RecheckLimits {
  return {
    scanBatch: jobKnob(settings, RECHECK_JOB, "scanBatch"), dailyCap: jobKnob(settings, RECHECK_JOB, "dailyCap"),
    askBatch: jobKnob(settings, RECHECK_JOB, "askBatch"), minSimilarity: jobKnob(settings, RECHECK_JOB, "minSimilarity") / 100,
    yieldHours: jobKnob(settings, RECHECK_JOB, "yieldHours"),
  };
}

// ─────────────────────────── 줄 ───────────────────────────

export async function rollingStream(): Promise<ProductAuditCampaign | null> {
  const [row] = await db.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.status, ROLLING_AUDIT_STATUS)).limit(1);
  return row ?? null;
}

/** 줄 행이 없으면 만든다(하나뿐 — product_audit_one_rolling_idx). DR writer fence → 작업 lease 의 한 커밋이다 */
export async function ensureRollingStream(lease: JobLease): Promise<ProductAuditCampaign> {
  const existing = await rollingStream();
  if (existing) return existing;
  await withJobLeaseWrite(lease, async (tx) => {
    await tx.insert(productAuditCampaigns).values({
      startedBy: RECHECK_ACTOR, reason: "공개분 변경 재판정 — 내용이 바뀐 공개 제품을 「발행분 감사 · 변경 재판정」 순위 모델로 다시 봅니다(늘 열린 줄)",
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: RECHECK_REVIEWER_LABEL, model: RECHECK_REVIEWER_LABEL,
      status: ROLLING_AUDIT_STATUS,
    }).onConflictDoNothing();
    await assertJobLeaseAtWallTime(tx, lease);
  });
  const created = await rollingStream();
  if (!created) throw new Error("published_recheck_stream_missing");
  return created;
}

// ─────────────────────────── 기준 ───────────────────────────

type Baseline = { content: RecheckContent; hash: string; summary: RecheckChangeSummary["baseline"] };
type ApprovalRow = { candidateId: number; attemptId: number; product: ReviewSnapshot["product"] | null; promptVersion: string; completedAt: string | null };

/** 후보마다 1차 심사의 마지막 성공 승인(자동 심사) — 그 입력의 product 부분만 읽는다(crawl_review_approval_idx) */
async function latestApprovals(candidateIds: readonly number[]): Promise<Map<number, ApprovalRow>> {
  const found = new Map<number, ApprovalRow>();
  if (!candidateIds.length) return found;
  const rows = await db.execute<{ candidate_id: number; id: number; product: ReviewSnapshot["product"] | null; prompt_version: string; completed_at: string | null }>(sql`
    select distinct on (a.candidate_id) a.candidate_id, a.id, a.snapshot->'product' as product, a.prompt_version, a.completed_at::text as completed_at
      from ${crawlReviewAttempts} a
     where a.candidate_id in (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})
       and a.kind = 'automatic' and a.state = 'succeeded' and a.outcome->>'decision' = 'approve'
     order by a.candidate_id, a.completed_at desc nulls last, a.id desc`);
  for (const row of rows) found.set(row.candidate_id, { candidateId: row.candidate_id, attemptId: row.id, product: row.product,
    promptVersion: row.prompt_version, completedAt: row.completed_at });
  return found;
}

/** 기준이 가리키는 1차 승인들의 product 부분 */
async function attemptProducts(attemptIds: readonly number[]): Promise<Map<number, ApprovalRow>> {
  const found = new Map<number, ApprovalRow>();
  if (!attemptIds.length) return found;
  const rows = await db.execute<{ candidate_id: number; id: number; product: ReviewSnapshot["product"] | null; prompt_version: string; completed_at: string | null }>(sql`
    select a.candidate_id, a.id, a.snapshot->'product' as product, a.prompt_version, a.completed_at::text as completed_at
      from ${crawlReviewAttempts} a where a.id in (${sql.join(attemptIds.map((id) => sql`${id}`), sql`, `)})`);
  for (const row of rows) found.set(row.id, { candidateId: row.candidate_id, attemptId: row.id, product: row.product,
    promptVersion: row.prompt_version, completedAt: row.completed_at });
  return found;
}

const approvalBaseline = (approval: ApprovalRow): Baseline | null => {
  if (!approval.product || typeof approval.product !== "object") return null;
  const content = recheckContent(approval.product, { packageProofKnown: packageProofKnownSince(approval.promptVersion) });
  return { content, hash: recheckContentHash(content),
    summary: { source: "first_review", attemptId: approval.attemptId, itemId: null, judgedAt: approval.completedAt } };
};

// ─────────────────────────── 쓸기 ───────────────────────────

export type RecheckCursor = { afterId: number };
export type RecheckScanResult = {
  scanned: number; unchanged: number; minor: number; enrolled: number; seeded: number; skippedOpen: number; failed: number;
  /** 하루 상한에 닿아 멈췄다 — 커서는 올리지 못한 제품 앞에 머문다 */
  capped: boolean; afterId: number; finishedPass: boolean;
};

/** 그 제품을 지금 다시 올리지 않는 까닭 — 이미 사람을 기다리거나(보류·열린 재판정 답) 아직 물을 재판정 항목이 있다 */
async function blockedProducts(executor: typeof db | ProductTransaction, rollingId: number, productIds: readonly number[]): Promise<Set<number>> {
  if (!productIds.length) return new Set();
  const rows = await executor.execute<{ id: number }>(sql`
    select p.id from ${products} p where p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
      and (p.audit_hold_at is not null or exists (select 1 from ${productAuditItems} i where i.product_id = p.id and i.campaign_id = ${rollingId}
        and i.human_decision is null and i.hold_released_at is null
        and ((i.ai_decision is null and i.attempts < ${MAX_REVIEW_ATTEMPTS} and i.error_code is distinct from 'no_source')
          or i.ai_decision in ('reject', 'needs_review'))))`);
  return new Set(rows.map((row) => row.id));
}

/** 지난 24시간 재판정 줄에 올린 수 — 시각은 DB 시계로 잰다(시간대 없는 칸) */
export async function enrolledLastDay(rollingId: number): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(productAuditItems)
    .where(and(eq(productAuditItems.campaignId, rollingId), sql`${productAuditItems.enrolledAt} > now() - interval '24 hours'`));
  return row?.count ?? 0;
}

type ScanRow = { productId: number; slug: string; candidate: CrawlCandidate; document: CrawlDocument; baseline: ProductRecheckBaseline | null };

/**
 * 이 틱에 볼 공개 제품 — 수집 원본이 있는 것만, id 순서. 후보가 여럿이면(별칭) 가장 작은 id 의 후보(감사 입력 loadAuditInput 과 같다).
 * fetched 는 별칭으로 겹친 줄까지 센 읽은 줄 수다 — 한 바퀴가 끝났는지 가른다
 */
async function scanRows(afterId: number, limit: number): Promise<{ rows: ScanRow[]; fetched: number }> {
  const rows = await db.select({ productId: products.id, slug: products.slug, candidate: crawlCandidates, document: crawlDocuments,
    baseline: productRecheckBaselines }).from(products)
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .leftJoin(productRecheckBaselines, eq(productRecheckBaselines.productId, products.id))
    .where(and(inArray(products.status, ["seeded", "verified"]), gt(products.id, afterId)))
    .orderBy(asc(products.id), asc(crawlCandidates.id)).limit(limit);
  const seen = new Set<number>();
  return { rows: rows.filter((row) => !seen.has(row.productId) && Boolean(seen.add(row.productId))), fetched: rows.length };
}

type BaselineInsert = { source: ProductRecheckBaselineSource; attemptId: number | null; itemId: number | null; content: Record<string, unknown> | null;
  contentHash: string; checkedHash?: string | null; judgedAt: SQL | null };
/**
 * 기준 쓰기 하나. insert: 새 기준(이미 있으면 둔다 — 다른 쓰기가 먼저 적었다). replace: 가리키던 1차 승인이 사라진 기준을 지금 내용으로 바꾼다
 * (그 기준이 그대로일 때만). check: 마지막으로 견준 해시만 옮긴다(기준이 그대로일 때만)
 */
type BaselineWrite = { productId: number; insert?: BaselineInsert; replace?: { fromHash: string; to: BaselineInsert };
  check?: { contentHash: string; checkedHash: string } };

/**
 * 한 틱 — 공개 제품 scanBatch 건을 기준과 견주고, 뜻있게 바뀐 것을 재판정 줄에 올린다. 모델을 부르지 않는다.
 * 기준 쓰기(새 기준·마지막으로 견준 해시)는 틱 끝에 한 커밋으로 모은다(DR writer fence → 작업 lease). 올리기는 한 건마다 한 커밋이다.
 * 하루 상한에 닿으면 그 제품 앞에서 멈춘다 — 커서가 넘어가지 않아 다음 날 이어서 올린다(바뀐 것을 건너뛰지 않는다).
 */
export async function scanPublishedChanges(ctx: Pick<JobContext<unknown>, "hasBudget" | "signal">, input: {
  settings: CrawlSettings; limits: RecheckLimits; rolling: ProductAuditCampaign; afterId: number; lease: JobLease; now?: Date;
}): Promise<RecheckScanResult> {
  const { limits, rolling, lease } = input;
  const result: RecheckScanResult = { scanned: 0, unchanged: 0, minor: 0, enrolled: 0, seeded: 0, skippedOpen: 0, failed: 0, capped: false,
    afterId: input.afterId, finishedPass: false };
  const { rows, fetched } = await scanRows(input.afterId, limits.scanBatch);
  const settings = auditSettings(input.settings);
  const at = input.now ?? new Date();
  // 지금 내용과 그 해시 — 1차와 같은 함수로(입력을 만들 수 없는 원본은 이 바퀴에서 건너뛴다)
  const current = new Map<number, { content: RecheckContent; hash: string } | null>();
  for (const row of rows) {
    try {
      const content = recheckContent(buildReviewProduct(row.candidate, row.document, settings, at), { packageProofKnown: true });
      current.set(row.productId, { content, hash: recheckContentHash(content) });
    } catch { current.set(row.productId, null); }
  }
  // 마지막으로 견준 뒤 바뀐 것만 기준을 읽는다
  const stale = rows.filter((row) => { const now = current.get(row.productId); return now && row.baseline?.checkedHash !== now.hash; });
  const [approvals, attempts, blocked] = await Promise.all([
    latestApprovals(stale.filter((row) => !row.baseline).map((row) => row.candidate.id)),
    attemptProducts(stale.flatMap((row) => row.baseline?.source === "first_review" && row.baseline.attemptId ? [row.baseline.attemptId] : [])),
    blockedProducts(db, rolling.id, stale.map((row) => row.productId)),
  ]);
  let enrolledDay = await enrolledLastDay(rolling.id);
  const writes: BaselineWrite[] = [];
  for (const row of rows) {
    if (!ctx.hasBudget() || ctx.signal?.aborted) break;
    const now = current.get(row.productId);
    if (!now) { result.failed += 1; result.afterId = row.productId; continue; }
    result.scanned += 1;
    if (row.baseline?.checkedHash === now.hash) { result.unchanged += 1; result.afterId = row.productId; continue; }
    // 기준 — 이미 있으면 그것(1차 승인은 가리키는 행을 읽는다), 없으면 1차의 마지막 승인, 그것도 없으면 지금 내용으로 시작한다
    let baseline: Baseline | null = null;
    let insert: BaselineInsert | undefined;
    if (row.baseline?.source === "first_review") {
      const approval = row.baseline.attemptId ? attempts.get(row.baseline.attemptId) : undefined;
      baseline = approval ? approvalBaseline(approval) : null;
    } else if (row.baseline?.content) {
      baseline = { content: row.baseline.content as RecheckContent, hash: row.baseline.contentHash,
        summary: { source: row.baseline.source, attemptId: null, itemId: row.baseline.itemId, judgedAt: row.baseline.judgedAt?.toISOString() ?? null } };
    } else if (!row.baseline) {
      const approval = approvals.get(row.candidate.id);
      baseline = approval ? approvalBaseline(approval) : null;
      if (approval && baseline) insert = { source: "first_review", attemptId: approval.attemptId, itemId: null, content: null, contentHash: baseline.hash,
        judgedAt: approval.completedAt ? sql`${approval.completedAt}::timestamp` : null };
    }
    result.afterId = row.productId;
    if (!baseline) {
      // 모델이 본 적 없는 제품(또는 가리키던 1차 승인이 지워짐) — 지금 내용이 기준이다. 다음 변경부터 잡는다
      result.seeded += 1;
      const seeded: BaselineInsert = { source: "seeded", attemptId: null, itemId: null, content: now.content as Record<string, unknown>,
        contentHash: now.hash, checkedHash: now.hash, judgedAt: null };
      writes.push(row.baseline ? { productId: row.productId, replace: { fromHash: row.baseline.contentHash, to: seeded } } : { productId: row.productId, insert: seeded });
      continue;
    }
    const comparison = baseline.hash === now.hash ? null : compareRecheckContent(baseline.content, now.content, { minSimilarity: limits.minSimilarity });
    const checked: Omit<BaselineWrite, "productId"> = insert ? { insert: { ...insert, checkedHash: now.hash } }
      : { check: { contentHash: baseline.hash, checkedHash: now.hash } };
    if (!comparison?.changed || blocked.has(row.productId)) {
      if (!comparison) result.unchanged += 1;
      else if (!comparison.changed) result.minor += 1;
      else result.skippedOpen += 1;
      writes.push({ productId: row.productId, ...checked });
      continue;
    }
    if (enrolledDay >= limits.dailyCap) {
      result.capped = true;
      result.afterId = rows[rows.indexOf(row) - 1]?.productId ?? input.afterId;
      // 기준만은 적어 둔다(다시 찾지 않게) — 견준 해시는 비워 두어 상한이 풀리면 다시 견준다
      if (insert) writes.push({ productId: row.productId, insert: { ...insert, checkedHash: null } });
      break;
    }
    const summary: RecheckChangeSummary = { version: 1, fields: comparison.fields, minSimilarity: limits.minSimilarity, baseline: baseline.summary };
    const enrolled = await enrollRecheck({ rolling, productId: row.productId, slug: row.slug, summary, lease, baseline: checked });
    if (enrolled) { result.enrolled += 1; enrolledDay += 1; } else result.skippedOpen += 1;
  }
  await writeBaselines(writes, lease);
  result.finishedPass = !result.capped && fetched < limits.scanBatch && ctx.hasBudget() && !ctx.signal?.aborted
    && result.afterId === (rows.at(-1)?.productId ?? input.afterId);
  return result;
}

async function applyBaselineWrites(tx: ProductTransaction, writes: readonly BaselineWrite[]): Promise<void> {
  const inserts = writes.flatMap((write) => write.insert ? [{ productId: write.productId, ...write.insert }] : []);
  for (let index = 0; index < inserts.length; index += 500) {
    await tx.insert(productRecheckBaselines).values(inserts.slice(index, index + 500)).onConflictDoNothing();
  }
  for (const write of writes) {
    if (!write.replace) continue;
    await tx.update(productRecheckBaselines).set({ ...write.replace.to, checkedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(productRecheckBaselines.productId, write.productId), eq(productRecheckBaselines.contentHash, write.replace.fromHash)));
  }
  const checks = writes.flatMap((write) => write.check ? [{ productId: write.productId, ...write.check }] : []);
  for (let index = 0; index < checks.length; index += 500) {
    const values = sql.join(checks.slice(index, index + 500).map((check) =>
      sql`(${check.productId}::int, ${check.contentHash}::text, ${check.checkedHash}::text)`), sql`, `);
    await tx.execute(sql`update ${productRecheckBaselines} b set checked_hash = v.checked, checked_at = now()
      from (values ${values}) as v(product_id, content_hash, checked) where b.product_id = v.product_id and b.content_hash = v.content_hash`);
  }
}

/** 기준 쓰기 한 커밋(DR writer fence → 기준 → 작업 lease) */
async function writeBaselines(writes: readonly BaselineWrite[], lease: JobLease): Promise<void> {
  if (!writes.length) return;
  await withJobLeaseWrite(lease, async (tx) => {
    await applyBaselineWrites(tx, writes);
    await assertJobLeaseAtWallTime(tx, lease);
  });
}

/**
 * 한 제품을 재판정 줄에 올린다 — 한 커밋(DR writer fence → 항목 → 기준 → 작업 lease). 그 사이 보류됐거나 열린 재판정 항목이 생겼으면 올리지 않는다.
 * round 는 그 제품의 이 줄 항목 수 + 1 이다((campaign_id, product_id, round) 유일 색인).
 */
async function enrollRecheck(input: { rolling: ProductAuditCampaign; productId: number; slug: string; summary: RecheckChangeSummary; lease: JobLease;
  baseline: Omit<BaselineWrite, "productId"> }): Promise<boolean> {
  return withJobLeaseWrite(input.lease, async (tx) => {
    if ((await blockedProducts(tx, input.rolling.id, [input.productId])).size) return false;
    const [last] = await tx.select({ round: sql<number>`coalesce(max(${productAuditItems.round}), 0)::int` }).from(productAuditItems)
      .where(and(eq(productAuditItems.campaignId, input.rolling.id), eq(productAuditItems.productId, input.productId)));
    await tx.insert(productAuditItems).values({ campaignId: input.rolling.id, productId: input.productId, slug: input.slug.slice(0, 80),
      round: (last?.round ?? 0) + 1, enrolledAt: sql`now()`, changeSummary: input.summary as unknown as Record<string, unknown> });
    await applyBaselineWrites(tx, [{ productId: input.productId, ...input.baseline }]);
    await assertJobLeaseAtWallTime(tx, input.lease);
    return true;
  });
}

// ─────────────────────────── 묻기의 재료(감사 잡이 쓴다) ───────────────────────────

/** 재판정을 부르는 작업 — 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(product-audit). 사람이 연 감사도 이 순위로 시작한다(product-audit.ts startProductAudit) */
export const RECHECK_TASK = "product-audit";
/** 그 작업의 화면 이름(「발행분 감사 · 변경 재판정」) */
export const RECHECK_TASK_LABEL = aiTask(RECHECK_TASK)?.label ?? RECHECK_TASK;
/**
 * 재판정을 부르는 제공자 — 감사 경로(product-audit)의 장부 binding(product_audit_cli)이 받는 CLI 둘(OpenCode 원격 호스트·Claude 이 워커)과,
 * API 연결(local-direct — 감사 직접 경로 local-audit, binding direct:audit:<항목>:audit, 잡 audit-qwen, 2026-11-09). Codex·Grok 은 장부 규칙(CHECK 가지)·binding 이
 * 없어 받지 않는다(lib/llm/ai-tasks.ts 의 product-audit 과 같다). CLI 순위는 감사 잡이, API 순위는 Qwen 직접 감사 잡이 묻는다(published-recheck-lanes.ts)
 */
export type RecheckProvider = "opencode-cli" | "claude-cli" | "local-direct";
export type RecheckReviewer = Readonly<{ rank: number; provider: RecheckProvider; model: string; connectionId: string; connectionLabel: string;
  reasoningEffort?: string;
  /** API 순위만: 연결 주소(`origin/v1`). 키는 싣지 않는다 — 부를 때 recheckDirectEndpoint 가 순위 스냅숏에서 읽는다 */
  baseUrl?: string }>;
export type RecheckRankStatus = "ok" | "no_task_models" | "task_models_unreadable";
export type RecheckReviewerPlan = Readonly<{ status: RecheckRankStatus; reviewers: readonly RecheckReviewer[];
  /** 순위에 있지만 재판정이 부르지 않는 것과 까닭(운영자 문장) */
  skipped: readonly { rank: number; label: string; model: string; reason: string }[] }>;

/**
 * 재판정의 심사자 — 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(작업 product-audit, 칸 1)의 1·2·3순위를 차례로(2026-11-09 운영자 결정: 1차 순위와
 * 완전히 나눈다 — 1차 순위를 바꿔도 재판정은 따라가지 않는다). 사람이 연 감사를 시작할 때와 같은 해석이다(product-audit.ts startProductAudit):
 * 켜진 순위·켜진 연결이고 OpenCode CLI 연결(그 호스트 주소·키를 열 수 있어야 한다)·Claude CLI 연결 또는 API 연결(주소가 있고 저장한 키를 열 수 있어야 한다)이어야
 * 한다. 모델은 순위의 모델, 추론 강도는 순위의 옵션이다(OpenCode 만).
 * CLI 는 감사 경로(product_audit_cli)로 간다 — 그 순위를 저장하면 만들어지는 감사 경로 CLI 계약·정책 route 로 열린다. API 는 감사 직접 경로(local-audit)로 간다 —
 * 그 순위를 저장하면 만들어지는(이미 있으면 그대로 쓰는) 로컬 계약·정책 route 로 열린다. 둘 다 새 장부 binding·CHECK 가지를 만들지 않는다.
 * 순위가 없거나 표를 못 읽었으면 status 로 말하고 부르지 않는다 — 코드 기본값·1차 순위·옛 설정으로 대신 부르지 않는다.
 */
export function recheckReviewerPlan(): RecheckReviewerPlan {
  const read = aiTaskModelsReadState();
  const ranks = taskModels(RECHECK_TASK, 1);
  const reviewers: RecheckReviewer[] = [];
  const skipped: { rank: number; label: string; model: string; reason: string }[] = [];
  for (const rank of ranks) {
    const base = { rank: rank.rank, label: rank.connection.label, model: rank.model };
    const effort = typeof rank.options.reasoningEffort === "string" ? rank.options.reasoningEffort : undefined;
    const claude = rank.connection.kind === "cli" && rank.connection.cliTool === "claude";
    const api = rank.connection.kind === "api";
    const reason = !rank.enabled ? "순위 꺼짐" : !rank.connection.enabled ? "연결 꺼짐"
      : api ? !rank.connection.baseUrl ? "연결 주소가 없습니다" : rank.connection.keyUnreadable ? "연결에 저장한 키를 열 수 없습니다(암호 상자 키 확인)" : null
      : !claude && !isCliEngineConnection(rank.connection) ? "감사 경로는 OpenCode·Claude CLI·API 연결만 받습니다" : null;
    if (reason) { skipped.push({ ...base, reason }); continue; }
    if (api) {
      reviewers.push(Object.freeze({ rank: rank.rank, provider: "local-direct" as const, model: rank.model, connectionId: rank.connection.id,
        connectionLabel: rank.connection.label, baseUrl: rank.connection.baseUrl! }));
      continue;
    }
    if (claude) {
      reviewers.push(Object.freeze({ rank: rank.rank, provider: "claude-cli" as const, model: rank.model, connectionId: rank.connection.id,
        connectionLabel: rank.connection.label }));
      continue;
    }
    try {
      cliHostTargetFromConnection(rank.connection);
      cliEngineRevision({ connectionId: rank.connection.id, ...(effort ? { reasoningEffort: effort } : {}) });
    } catch {
      skipped.push({ ...base, reason: "연결의 호스트 주소·키를 열 수 없거나 추론 강도가 맞지 않습니다" });
      continue;
    }
    reviewers.push(Object.freeze({ rank: rank.rank, provider: "opencode-cli" as const, model: rank.model, connectionId: rank.connection.id,
      connectionLabel: rank.connection.label, ...(effort ? { reasoningEffort: effort } : {}) }));
  }
  const status: RecheckRankStatus = ranks.length ? "ok" : read.loaded ? "no_task_models" : "task_models_unreadable";
  return Object.freeze({ status, reviewers: Object.freeze(reviewers), skipped: Object.freeze(skipped) });
}

/** 순위가 없거나 부를 순위가 없을 때의 운영자 문장 — 화면·로그가 같은 말을 쓴다 */
export function recheckReviewerPlanText(plan: RecheckReviewerPlan): string | null {
  if (plan.status === "task_models_unreadable") return "작업 ↔ 모델 표를 아직 읽지 못했습니다 — 묻지 않고 올리기만 합니다";
  if (plan.status === "no_task_models") return `「${RECHECK_TASK_LABEL}」 순위 없음 — 작업 ↔ 모델에서 1순위를 저장할 때까지 묻지 않고 올리기만 합니다`;
  if (!plan.reviewers.length) return `「${RECHECK_TASK_LABEL}」 순위를 모두 부를 수 없습니다 — 묻지 않고 올리기만 합니다`;
  return null;
}

/**
 * 그 심사자가 감사 경로(product-audit)에서 열릴 계약이 있는가 — 화면의 안내다(워커는 부를 때 장부·계약·호스트 버전을 다시 본다).
 * 그 모델의 감사 경로 CLI 계약 행(cli:opencode-cli:product-audit)은 「발행분 감사 · 변경 재판정」 순위를 저장하면 그 연결의 CLI 버전으로 만들어진다
 */
export function recheckRouteNote(reviewer: Pick<RecheckReviewer, "provider" | "model" | "baseUrl">): { ready: boolean; text: string } {
  if (reviewer.provider === "local-direct") {
    // API 순위 — 감사 직접 경로(local-audit)의 로컬 계약(관리 표, 없으면 이 프로세스 env). 정책 route·장비 물리 상한은 워커가 부를 때 본다
    const ready = Boolean(reviewer.baseUrl && verifiedLocalModelContract(`${reviewer.baseUrl}/chat/completions`, reviewer.model));
    return ready ? { ready, text: `감사 직접 경로(${AUDIT_DIRECT_ROUTE}) 로컬 계약 있음` }
      : { ready, text: `감사 직접 경로(${AUDIT_DIRECT_ROUTE}) 로컬 계약 없음 — 「${RECHECK_TASK_LABEL}」 순위를 다시 저장하면 만들어집니다` };
  }
  const routeId = cliContractRouteId(reviewer.provider, "product-audit");
  const ready = servingContractSnapshot().rows.some((row) => row.routeId === routeId && row.model === reviewer.model);
  return ready ? { ready, text: "감사 경로 CLI 계약 있음" }
    : { ready, text: `감사 경로(product-audit) CLI 계약 없음 — 「${RECHECK_TASK_LABEL}」 순위를 다시 저장하면 만들어집니다` };
}

/**
 * API 순위를 부를 주소·키 — 순위 스냅숏(30초)의 그 순위·연결에서 읽는다(키는 메모리 안에서만). 순위가 그 사이 바뀌었거나 키를 열 수 없으면 null
 */
export function recheckDirectEndpoint(reviewer: Pick<RecheckReviewer, "rank" | "connectionId" | "model">): { baseUrl: string; apiKey: string | null } | null {
  const rank = taskModels(RECHECK_TASK, 1).find((row) => row.rank === reviewer.rank && row.connection.id === reviewer.connectionId && row.model === reviewer.model);
  if (!rank || !rank.enabled || !rank.connection.enabled || rank.connection.kind !== "api" || !rank.connection.baseUrl || rank.connection.keyUnreadable) return null;
  return { baseUrl: rank.connection.baseUrl, apiKey: rank.connection.apiKey };
}

/**
 * 이 틱은 1차 심사 때문에 재판정을 쉬는가 — 쉬면 가장 오래 기다린 항목의 시간(없으면 null)을, 묻으면 false. 두 묻기 줄(감사 잡의 CLI·Qwen 직접 감사 잡의 API)이 같은 규칙이다:
 * 1차 심사 대기에 후보가 있으면 물러나되, 가장 오래 기다린 재판정 항목이 yieldHours 를 넘으면 함께 묻는다(0 이면 물러나지 않는다)
 */
export async function recheckYields(settings: CrawlSettings, rollingId: number, yieldHours: number): Promise<{ waitedHours: number | null } | false> {
  if (yieldHours <= 0 || !await firstReviewHasWork(settings)) return false;
  const waited = await oldestPendingRecheckHours(rollingId);
  return waited === null || waited < yieldHours ? { waitedHours: waited === null ? null : Math.round(waited * 10) / 10 } : false;
}

/** 1차 심사 대기에 지금 묻을 후보가 있는가(줄 맨 앞 하나만 본다) — 재판정는 1차가 일할 때 물러난다 */
export async function firstReviewHasWork(settings: CrawlSettings): Promise<boolean> {
  if (!settings.enabled || settings.reviewMode === "off") return false;
  const [row] = await db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(reviewCandidatePredicate(settings, { readyOnly: true })).limit(1);
  return Boolean(row);
}

/** 가장 오래 기다린 물을 재판정 항목이 올라온 지 몇 시간인가 — 없으면 null */
export async function oldestPendingRecheckHours(rollingId: number): Promise<number | null> {
  const [row] = await db.select({ hours: sql<number | null>`extract(epoch from (now() - min(${productAuditItems.enrolledAt}))) / 3600` })
    .from(productAuditItems).where(and(eq(productAuditItems.campaignId, rollingId), isNull(productAuditItems.aiDecision),
      sql`${productAuditItems.attempts} < ${MAX_REVIEW_ATTEMPTS}`, sql`${productAuditItems.errorCode} is distinct from 'no_source'`));
  return row?.hours === null || row?.hours === undefined ? null : Number(row.hours);
}

// ─────────────────────────── 화면 ───────────────────────────

export type RecheckOverview = {
  stream: ProductAuditCampaign | null;
  limits: RecheckLimits;
  counts: { pending: number; failed: number; enrolledDay: number; answeredDay: number; approvedDay: number; rejectedDay: number;
    needsReviewDay: number; openReject: number; openNeedsReview: number; held: number; total: number };
  baselines: { firstReview: number; recheck: number; seeded: number };
  oldestPendingHours: number | null;
};

export async function recheckOverview(limits: RecheckLimits = recheckLimits()): Promise<RecheckOverview> {
  const stream = await rollingStream();
  const [baselineRows] = await Promise.all([
    db.select({ source: productRecheckBaselines.source, count: sql<number>`count(*)::int` }).from(productRecheckBaselines).groupBy(productRecheckBaselines.source),
  ]);
  const baselines = { firstReview: 0, recheck: 0, seeded: 0 };
  for (const row of baselineRows) {
    if (row.source === "first_review") baselines.firstReview = row.count;
    else if (row.source === "recheck") baselines.recheck = row.count;
    else baselines.seeded = row.count;
  }
  const empty = { pending: 0, failed: 0, enrolledDay: 0, answeredDay: 0, approvedDay: 0, rejectedDay: 0, needsReviewDay: 0, openReject: 0,
    openNeedsReview: 0, held: 0, total: 0 };
  if (!stream) return { stream: null, limits, counts: empty, baselines, oldestPendingHours: null };
  const askable = sql`${productAuditItems.aiDecision} is null and ${productAuditItems.attempts} < ${MAX_REVIEW_ATTEMPTS}
    and ${productAuditItems.errorCode} is distinct from 'no_source'`;
  const day = sql`${productAuditItems.reviewedAt} > now() - interval '24 hours'`;
  const open = sql`${productAuditItems.humanDecision} is null and ${products.status} in ('seeded', 'verified')`;
  const [[counts], oldestPendingHours] = await Promise.all([
    db.select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${askable} and ${products.status} in ('seeded', 'verified'))::int`,
      failed: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} is null and not (${askable}))::int`,
      enrolledDay: sql<number>`count(*) filter (where ${productAuditItems.enrolledAt} > now() - interval '24 hours')::int`,
      answeredDay: sql<number>`count(*) filter (where ${day})::int`,
      approvedDay: sql<number>`count(*) filter (where ${day} and ${productAuditItems.aiDecision} = 'approve')::int`,
      rejectedDay: sql<number>`count(*) filter (where ${day} and ${productAuditItems.aiDecision} = 'reject')::int`,
      needsReviewDay: sql<number>`count(*) filter (where ${day} and ${productAuditItems.aiDecision} = 'needs_review')::int`,
      openReject: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'reject' and ${open})::int`,
      openNeedsReview: sql<number>`count(*) filter (where ${productAuditItems.aiDecision} = 'needs_review' and ${open})::int`,
      held: sql<number>`count(*) filter (where ${products.auditHoldItemId} = ${productAuditItems.id} and ${products.auditHoldAt} is not null)::int`,
    }).from(productAuditItems).leftJoin(products, eq(products.id, productAuditItems.productId)).where(eq(productAuditItems.campaignId, stream.id)),
    oldestPendingRecheckHours(stream.id),
  ]);
  return { stream, limits, counts: counts ?? empty, baselines, oldestPendingHours };
}

/** 재판정 줄에서 사람이 볼 것이 있는 제품 수(보류 제외) — 화면 탭의 숫자 */
export async function recheckOpenCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(productAuditItems)
    .innerJoin(productAuditCampaigns, eq(productAuditCampaigns.id, productAuditItems.campaignId))
    .innerJoin(products, eq(products.id, productAuditItems.productId))
    .where(and(eq(productAuditCampaigns.status, ROLLING_AUDIT_STATUS), inArray(productAuditItems.aiDecision, ["reject", "needs_review"]),
      isNull(productAuditItems.humanDecision), inArray(products.status, ["seeded", "verified"]), isNotNull(productAuditItems.reviewedAt)));
  return row?.count ?? 0;
}
