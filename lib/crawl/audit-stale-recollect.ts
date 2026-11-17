import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, productAuditRecollects, type ProductAuditRecollectState } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { requestJob, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { reviewHash, type ReviewInput } from "./agent-review-contract";
import { hasLiveFetchItem } from "./fetch-ownership";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { auditSourceHash, loadAuditInput } from "./product-audit";
import { EMPTY_DETAIL, GONE_DETAIL, lockFrontierIdentity, SKIP_EMPTY_REPOSITORY, SKIP_NOT_FOUND } from "./repository";
import type { CrawlSettings } from "./settings-schema";
import { AUDIT_RECOLLECT_REFRESH_AGE_MS } from "./audit-stale-recollect-demand";

export { AUDIT_RECOLLECT_REFRESH_AGE_MS, auditRecollectScanDemand } from "./audit-stale-recollect-demand";

/**
 * 입력 기한이 지난 감사 거절의 원본 다시 받기(2026-11-17, 0188 product_audit_recollects).
 *
 * 두 번째 의견(audit-second-opinion-auto.ts)은 입력 유효 기한(validUntil = min(원본 수집, 스캔 완료) + 24시간)이 지난 대상을 묻지 못한다 —
 * 호출 직전 증명(local-model-domain.ts)이 늘 거절한다. 예전에는 그런 항목을 한 시간 쉬었다가(INPUT_STALE_RETRY_MS) 다시 골랐지만, 원본을 다시
 * 받는 곳이 없어 영원히 같은 자리에서 끝났다 — 2026-11-17 운영: 11/01 grok 감사(캠페인 6)의 열린 거절 538건 모두 원본이 8/29~9/19 에,
 * 스캔이 9/26~10/14 에 끝나(공개 제품의 배경 스캔 주기 90일) 두 번째 의견이 매 틱 10건을 골라 전부 input_stale 로 끝났다(asked 0).
 *
 * 이제 두 번째 의견이 기한 지난 감사 거절을 만나면, 틱마다 recollectPerTick 건까지 이 모듈로 원본을 다시 받게 한다 — 새 수집 길을 만들지 않고
 * 1차 심사의 원본 재수집(requeueStaleReviewSources)과 같은 길을 쓴다:
 *  - 원본: crawl_frontier 행을 pending 으로 되돌리고 crawl-fetch 를 깨운다(살아 있는 수집 claim 은 건드리지 않는다). 수집이 원본을 덮어쓴다(saveFetchedDocument).
 *  - 스캔: 스캔 줄 채우기(agent claims fillAgentScanQueue)가 이 표의 waiting 항목 저장소를 1차 심사 몫(review) 우선순위로 올린다(auditRecollectScanDemand).
 * 그 뒤 매 틱 settleAuditRecollects 가 waiting 줄을 보고:
 *  - 입력이 다시 새로워졌으면 done — 근거(감사 입력의 product 칸)마다의 짧은 해시를 견줘 바뀐 칸(changed_fields)·근거가 바뀌었는지(source_changed)를 남긴다.
 *    두 번째 의견은 다음 틱부터 그 항목을 보통처럼 묻는다(새 입력으로).
 *  - 수집이 요청 뒤에 실패로 끝났으면(저장소 404·빈 저장소·이름 바뀜·재시도 소진) failed — 사유를 남기고 사람 몫으로 둔다. 다시 고르지 않는다.
 *  - AUDIT_RECOLLECT_WAIT_MS 안에 새로워지지 않으면 failed(recollect_timeout).
 *  - 그 사이 사람이 정했거나 제품이 내려갔으면 dropped.
 * waiting·failed·dropped 항목은 두 번째 의견이 고르지 않는다(auditRecollectBlocksSql).
 */

/** 동시에 다시 받는 중(waiting)인 항목의 상한 — 수집·스캔 줄에 한꺼번에 몰리지 않게 */
export const AUDIT_RECOLLECT_MAX_WAITING = 20;
/** 다시 받기를 기다리는 최대 시간 — 넘으면 실패(recollect_timeout)로 사람 몫이다. 스캔 줄이 붐벼도 하루면 돈다 */
export const AUDIT_RECOLLECT_WAIT_MS = 48 * 3600_000;
/**
 * 다시 받은 원본의 README 를 기다리는 최대 시간(요청부터). 수집(saveFetchedDocument)은 README 를 받지 않고 옛 README 를 판 없음(null)으로 옮겨 두고,
 * 공개 제품의 README 는 기존 잡 product-readme-refresh(5분마다 2건)가 다시 받는다. 그동안은 끝남으로 적지 않는다 — README 변화도 근거 변화로 남기려고.
 * 넘기면 옮겨 둔 README 로 묻고 readme_refreshed=false 로 남긴다(README 받기 실패도 같다)
 */
export const AUDIT_RECOLLECT_README_WAIT_MS = 12 * 3600_000;
/** 한 항목의 다시 받기 요청 상한 — done 뒤 두 번째 의견이 묻기 전에 또 기한이 지나는 일이 되풀이되면 사람 몫으로 넘긴다 */
export const AUDIT_RECOLLECT_MAX_REQUESTS = 3;
/** 한 틱에 마무리를 보는 waiting 줄 수 */
const SETTLE_BATCH = 40;
/** 수집 신호 — 1차 심사의 원본 재수집과 같다(발견 수로 세지 않는다) */
const REFRESH_SIGNAL = "review-source-refresh";

export type AuditRecollectFailure = "no_source" | "repo_deleted" | "repo_empty" | "repo_renamed" | "source_refresh_failed"
  | "recollect_timeout" | "recollect_repeated" | "input_error";

/** 실패 사유의 사람용 글 — 감사 화면·작업 기록이 그대로 보인다 */
export const AUDIT_RECOLLECT_FAILURE_LABELS: Readonly<Record<AuditRecollectFailure, string>> = {
  no_source: "수집 원본(후보·문서)이 없어 다시 받을 수 없습니다.",
  repo_deleted: GONE_DETAIL,
  repo_empty: EMPTY_DETAIL,
  repo_renamed: "저장소 이름이 바뀌어(다른 이름의 같은 저장소가 이미 있음) 이 원본을 다시 받지 못했습니다.",
  source_refresh_failed: "GitHub 원본 재수집이 재시도를 다 쓰고 실패했습니다.",
  recollect_timeout: "정한 시간 안에 원본·스캔이 새로워지지 않았습니다.",
  recollect_repeated: "다시 받은 뒤에도 두 번째 의견을 묻기 전에 입력 기한이 거듭 지났습니다.",
  input_error: "다시 받은 원본으로 심사 입력을 만들지 못했습니다.",
};

/** 실패 사유의 짧은 이름 — 감사 화면의 상태 줄 */
export const AUDIT_RECOLLECT_FAILURE_SHORT: Readonly<Record<AuditRecollectFailure, string>> = {
  no_source: "원본 없음", repo_deleted: "저장소 없음(404)", repo_empty: "빈 저장소", repo_renamed: "이름 바뀜", source_refresh_failed: "수집 실패",
  recollect_timeout: "시간 넘김", recollect_repeated: "기한 거듭 지남", input_error: "입력 오류",
};

/** 근거(감사 입력의 product 칸)마다 짧은 해시 — 어떤 칸이 바뀌었는지만 가른다(내용은 남기지 않는다) */
export type RecollectDigest = Record<string, string>;
const DIGEST_FIELDS = ["name", "description", "pageText", "readme", "url", "accessMode", "repositoryUrl", "topics", "language",
  "linksOwnGithub", "packageProof"] as const;

export function recollectDigest(product: ReviewInput["snapshot"]["product"]): RecollectDigest {
  const record = product as unknown as Record<string, unknown>;
  return Object.fromEntries(DIGEST_FIELDS.map((field) => [field, reviewHash(record[field] ?? null).slice(0, 16)]));
}

/** 바뀐 칸 — 한쪽에만 있는 칸도 바뀐 것이다 */
export function recollectChangedFields(before: RecollectDigest | null | undefined, after: RecollectDigest): string[] {
  if (!before) return [];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => before[field] !== after[field]).sort();
}

export type RecollectFrontierView = { state: string; lastError: string | null; aliasOf: string | null; updatedAfterRequest: boolean } | null;

export type RecollectVerdict =
  | { kind: "waiting" }
  | { kind: "done" }
  | { kind: "dropped" }
  | { kind: "failed"; code: AuditRecollectFailure; detail: string };

/** 수집이 요청 뒤에 실패로 끝났나 — 끝났으면 그 사유(handOffFailedSourceRefreshes 와 같은 가름) */
export function recollectFrontierFailure(frontier: RecollectFrontierView): { code: AuditRecollectFailure; detail: string } | null {
  if (!frontier) return null;
  if (frontier.aliasOf) return { code: "repo_renamed", detail: `${AUDIT_RECOLLECT_FAILURE_LABELS.repo_renamed} (${frontier.aliasOf.slice(0, 200)})` };
  if (!frontier.updatedAfterRequest) return null;
  if (frontier.state === "failed") {
    return { code: "source_refresh_failed", detail: `GitHub 원본 재수집 실패: ${(frontier.lastError ?? "원인 미상").slice(0, 300)}` };
  }
  if (frontier.state === "skipped" && frontier.lastError === SKIP_NOT_FOUND) return { code: "repo_deleted", detail: GONE_DETAIL };
  if (frontier.state === "skipped" && frontier.lastError === SKIP_EMPTY_REPOSITORY) return { code: "repo_empty", detail: EMPTY_DETAIL };
  return null;
}

/**
 * waiting 줄 하나의 마무리 — 차례: 열린 거절이 아님(dropped) → 원본 없음 → 입력이 새로워짐(done — 다만 README 를 다시 받는 중이면
 * AUDIT_RECOLLECT_README_WAIT_MS 까지 기다림) → 수집 실패 → 시간 넘김 → 기다림. 입력이 새로워졌으면 수집 행이 그 뒤에 무엇이 되었든 끝남이다(묻을 수 있다).
 */
export function settleRecollectVerdict(input: { open: boolean; sourceFound: boolean; inputFresh: boolean; inputError?: boolean;
  frontier: RecollectFrontierView; waitedMs: number; refetched: boolean; readmePending?: boolean }): RecollectVerdict {
  if (!input.open) return { kind: "dropped" };
  if (!input.sourceFound) return { kind: "failed", code: "no_source", detail: AUDIT_RECOLLECT_FAILURE_LABELS.no_source };
  if (input.inputError) return { kind: "failed", code: "input_error", detail: AUDIT_RECOLLECT_FAILURE_LABELS.input_error };
  if (input.inputFresh) return input.readmePending && input.waitedMs <= AUDIT_RECOLLECT_README_WAIT_MS ? { kind: "waiting" } : { kind: "done" };
  const failure = recollectFrontierFailure(input.frontier);
  if (failure) return { kind: "failed", ...failure };
  if (input.waitedMs > AUDIT_RECOLLECT_WAIT_MS) {
    return { kind: "failed", code: "recollect_timeout", detail: `${AUDIT_RECOLLECT_FAILURE_LABELS.recollect_timeout} ${input.refetched
      ? "원본은 다시 받았지만 저장소 스캔이 24시간 안의 것이 되지 않았습니다." : "원본을 다시 받지 못했습니다."}` };
  }
  return { kind: "waiting" };
}

/** 두 번째 의견이 고르지 않는 항목 — 다시 받는 중·실패(사람 몫)·열린 거절 아님. done 이면 보통처럼 고른다. 별칭 i 는 product_audit_items */
export function auditRecollectBlocksSql(item: SQL = sql`i.id`): SQL {
  return sql`not exists (select 1 from ${productAuditRecollects} recollect where recollect.item_id = ${item} and recollect.state <> 'done')`;
}

export type AuditRecollectTarget = { itemId: number; productId: number; slug: string };
export type AuditRecollectRequest = { result: "requested" } | { result: "failed"; code: AuditRecollectFailure } | { result: "skipped"; reason: string };

/**
 * 한 항목의 원본을 다시 받게 한다 — 1차 심사의 원본 재수집(requeueStaleReviewSources)과 같은 잠금 순서·같은 조건:
 * DR writer fence → stage → 수집 프론티어 이름 잠금 → 프론티어 행 → 수집 항목 → (잡 깨우기) → 이 표 → 작업 lease.
 *  - 프론티어가 기다리거나 받는 중이면 되돌리지 않는다(그대로 기다린다). 살아 있는 수집 claim 도 건드리지 않는다.
 *  - 원본이 23시간 안의 것이면 다시 받지 않는다 — 스캔만 오래됐다(스캔 수요가 맡는다).
 *  - 이전 다시 받기가 이미 실패로 끝났으면(원본 뒤의 404·빈 저장소·이름 바뀜·재시도 소진) GitHub 를 다시 부르지 않고 바로 실패(사람 몫)로 적는다.
 * stale 은 이 틱이 만든 입력(기한 지난 것)이고 그 product 칸의 해시를 '전' 근거로 남긴다.
 */
export async function requestAuditRecollect(lease: JobLease, target: AuditRecollectTarget, stale: ReviewInput | null): Promise<AuditRecollectRequest> {
  return withJobLeaseWrite(lease, async (tx) => {
    await lockPipelineInputStages(tx);
    const [candidate] = await tx.select({ repo: crawlCandidates.repo }).from(crawlCandidates)
      .where(eq(crawlCandidates.publishedSlug, target.slug)).orderBy(asc(crawlCandidates.id)).limit(1);
    const [existing] = await tx.select().from(productAuditRecollects).where(eq(productAuditRecollects.itemId, target.itemId)).for("update");
    const fail = async (code: AuditRecollectFailure, detail: string, repo: string): Promise<AuditRecollectRequest> => {
      await upsert(tx, target, repo, stale, { state: "failed", failureCode: code, failureDetail: detail.slice(0, 400) }, existing?.requests ?? 0);
      return { result: "failed", code };
    };
    if (!candidate) return fail("no_source", AUDIT_RECOLLECT_FAILURE_LABELS.no_source, "");
    if (existing && existing.state !== "done") return { result: "skipped", reason: existing.state };
    if (existing && existing.requests >= AUDIT_RECOLLECT_MAX_REQUESTS) {
      return fail("recollect_repeated", AUDIT_RECOLLECT_FAILURE_LABELS.recollect_repeated, candidate.repo);
    }
    const [document] = await tx.select({ fetchedOld: sql<boolean>`${crawlDocuments.fetchedAt} <= clock_timestamp()
        - ${AUDIT_RECOLLECT_REFRESH_AGE_MS} * interval '1 millisecond'` }).from(crawlDocuments)
      .where(eq(crawlDocuments.repo, candidate.repo)).for("share");
    if (!document) return fail("no_source", AUDIT_RECOLLECT_FAILURE_LABELS.no_source, candidate.repo);
    await lockFrontierIdentity(tx, candidate.repo);
    const frontiers = await tx.select({ id: crawlFrontier.id, repo: crawlFrontier.repo, state: crawlFrontier.state, lastError: crawlFrontier.lastError,
      aliasOf: crawlFrontier.aliasOf,
      failedAfterSource: sql<boolean>`${crawlFrontier.updatedAt} > (select d.fetched_at from crawl_documents d where d.repo = ${candidate.repo})` })
      .from(crawlFrontier).where(sql`lower(${crawlFrontier.repo}) = lower(${candidate.repo})`).orderBy(asc(crawlFrontier.id)).for("update");
    // 대소문자만 다른 프론티어 행이 있다 — 1차 원본 재수집처럼 건드리지 않는다(다음에 다시 본다)
    if (frontiers.some((row) => row.repo !== candidate.repo)) return { result: "skipped", reason: "frontier_identity" };
    let [frontier] = frontiers;
    const earlier = frontier ? recollectFrontierFailure({ state: frontier.state, lastError: frontier.lastError, aliasOf: frontier.aliasOf,
      updatedAfterRequest: frontier.failedAfterSource }) : null;
    if (earlier) return fail(earlier.code, earlier.detail, candidate.repo);
    if (document.fetchedOld) {
      const inserted = !frontier;
      if (!frontier) [frontier] = await tx.insert(crawlFrontier).values({ repo: candidate.repo, signal: REFRESH_SIGNAL, priority: 100 })
        .returning({ id: crawlFrontier.id, repo: crawlFrontier.repo, state: crawlFrontier.state, lastError: crawlFrontier.lastError,
          aliasOf: crawlFrontier.aliasOf, failedAfterSource: sql<boolean>`false` });
      const waiting = frontier.state === "pending" || frontier.state === "fetching";
      if (!inserted && !waiting && !await hasLiveFetchItem(tx, frontier.id)) {
        await tx.update(crawlFrontier).set({ state: "pending", attempts: 0, nextAttemptAt: sql`clock_timestamp()`, lastError: null,
          updatedAt: sql`clock_timestamp()` }).where(eq(crawlFrontier.id, frontier.id));
      }
      await requestJob("crawl-fetch", tx);
    }
    await upsert(tx, target, candidate.repo, stale, { state: "waiting", failureCode: null, failureDetail: null }, (existing?.requests ?? 0) + 1);
    return { result: "requested" };
  });
}

async function upsert(tx: ProductTransaction, target: AuditRecollectTarget, repo: string, stale: ReviewInput | null,
  next: { state: ProductAuditRecollectState; failureCode: AuditRecollectFailure | null; failureDetail: string | null }, requests: number): Promise<void> {
  const values = {
    productId: target.productId, repo: repo.slice(0, 200), state: next.state, requests: Math.max(requests, 0),
    requestedAt: sql`clock_timestamp()`,
    beforeFetchedAt: stale ? new Date(stale.source.documentFetchedAt) : null,
    beforeScanCompletedAt: stale?.source.scanCompletedAt ? new Date(stale.source.scanCompletedAt) : null,
    beforeDigest: stale ? recollectDigest(stale.snapshot.product) : null,
    afterFetchedAt: null, afterDigest: null, changedFields: null, sourceChanged: null, readmeRefreshed: null,
    failureCode: next.failureCode, failureDetail: next.failureDetail,
    settledAt: next.state === "waiting" ? null : sql`clock_timestamp()`,
  };
  await tx.insert(productAuditRecollects).values({ itemId: target.itemId, ...values })
    .onConflictDoUpdate({ target: productAuditRecollects.itemId, set: values });
}

export type AuditRecollectSettled = { done: number; changed: number; failed: number; dropped: number; waiting: number };

type WaitingRow = {
  item_id: number; product_id: number; slug: string | null; repo: string; open: boolean; source_hash: string | null;
  before_digest: RecollectDigest | null; waited_ms: number; refetched: boolean | null; readme_pending: boolean | null; readme_current: boolean | null;
  frontier_state: string | null; frontier_error: string | null; frontier_alias: string | null; frontier_after: boolean | null;
};

/**
 * waiting 줄의 마무리(위 settleRecollectVerdict). 모델을 부르지 않는다. 입력은 두 번째 의견과 같은 loadAuditInput 으로 만들고, 새로워졌는지는
 * 같은 여유(freshMarginMs — INPUT_FRESH_MARGIN_MS)로 잰다. 쓰기는 한 커밋(DR writer fence → 이 표 → 작업 lease)이고 그 사이 다른 상태가 된 줄은 건드리지 않는다.
 * 돌려주는 waiting 은 마무리 뒤에도 다시 받는 중인 수다(새 요청의 상한 AUDIT_RECOLLECT_MAX_WAITING 을 잰다).
 */
export async function settleAuditRecollects(lease: JobLease, settings: CrawlSettings, freshMarginMs: number,
  limit = SETTLE_BATCH): Promise<AuditRecollectSettled> {
  const settled: AuditRecollectSettled = { done: 0, changed: 0, failed: 0, dropped: 0, waiting: 0 };
  const rows = await db.execute<WaitingRow>(sql`
    select r.item_id, r.product_id, p.slug, r.repo, r.before_digest, i.source_hash,
      (i.ai_decision = 'reject' and i.human_decision is null and coalesce(p.status in ('seeded', 'verified'), false)) as open,
      (extract(epoch from clock_timestamp() - r.requested_at) * 1000)::float8 as waited_ms,
      (d.fetched_at > r.requested_at) as refetched,
      -- 수집이 옮겨 둔 README(판 없음)를 README 잡이 아직 다시 받지 않았다(실패를 적었으면 기다리지 않는다) — repository.ts pendingPublishedReadmes 와 같은 표시
      coalesce(d.page_meta->'readmeSampleVersion' = 'null'::jsonb and jsonb_typeof(d.page_meta->'readmeSample') = 'string'
        and coalesce(d.page_meta->'readmeRefreshError', 'null'::jsonb) = 'null'::jsonb, false) as readme_pending,
      (jsonb_typeof(d.page_meta->'readmeSampleVersion') = 'string') as readme_current,
      f.state as frontier_state, f.last_error as frontier_error, f.alias_of as frontier_alias, (f.updated_at > r.requested_at) as frontier_after
      from ${productAuditRecollects} r join product_audit_items i on i.id = r.item_id
      left join products p on p.id = r.product_id
      left join crawl_documents d on d.repo = r.repo
      left join crawl_frontier f on f.repo = r.repo
     where r.state = 'waiting' order by r.requested_at, r.item_id limit ${limit}`);
  type Update = { itemId: number; state: ProductAuditRecollectState; afterFetchedAt?: Date | null; afterDigest?: RecollectDigest | null;
    changedFields?: string[] | null; sourceChanged?: boolean | null; readmeRefreshed?: boolean | null; failureCode?: string | null; failureDetail?: string | null };
  const updates: Update[] = [];
  for (const row of rows) {
    let input: ReviewInput | null = null;
    let inputError = false;
    if (row.open && row.slug) {
      try { input = await loadAuditInput(row.slug, settings); } catch { inputError = true; }
    }
    const verdict = settleRecollectVerdict({ open: Boolean(row.open && row.slug), sourceFound: inputError || Boolean(input), inputError,
      inputFresh: Boolean(input && input.validUntil.getTime() - Date.now() >= freshMarginMs),
      frontier: row.frontier_state === null ? null : { state: row.frontier_state, lastError: row.frontier_error, aliasOf: row.frontier_alias,
        updatedAfterRequest: Boolean(row.frontier_after) }, waitedMs: Number(row.waited_ms), refetched: Boolean(row.refetched),
      readmePending: Boolean(row.readme_pending) });
    if (verdict.kind === "waiting") continue;
    if (verdict.kind === "dropped") { updates.push({ itemId: row.item_id, state: "dropped" }); continue; }
    if (verdict.kind === "failed") {
      updates.push({ itemId: row.item_id, state: "failed", failureCode: verdict.code, failureDetail: verdict.detail.slice(0, 400) });
      continue;
    }
    const after = recollectDigest(input!.snapshot.product);
    const changedFields = recollectChangedFields(row.before_digest, after);
    // 감사가 적어 둔 페이지 해시가 있으면 그것으로 가른다(사람이 연 감사). 옮겨 적은 감사(캠페인 6 grok)는 해시가 없어 요청 때의 칸 해시와 견준다
    const sourceChanged = row.source_hash ? auditSourceHash(input!) !== row.source_hash : changedFields.length > 0;
    updates.push({ itemId: row.item_id, state: "done", afterFetchedAt: new Date(input!.source.documentFetchedAt), afterDigest: after,
      changedFields, sourceChanged, readmeRefreshed: Boolean(row.refetched && row.readme_current) });
  }
  await withJobLeaseWrite(lease, async (tx) => {
    for (const update of updates) {
      const { itemId, ...set } = update;
      const [written] = await tx.update(productAuditRecollects).set({ ...set, settledAt: sql`clock_timestamp()` })
        .where(and(eq(productAuditRecollects.itemId, itemId), eq(productAuditRecollects.state, "waiting")))
        .returning({ itemId: productAuditRecollects.itemId });
      if (!written) continue;
      if (update.state === "done") { settled.done += 1; if (update.sourceChanged) settled.changed += 1; }
      else if (update.state === "failed") settled.failed += 1;
      else settled.dropped += 1;
    }
    const [count] = await tx.select({ waiting: sql<number>`count(*)::int` }).from(productAuditRecollects)
      .where(eq(productAuditRecollects.state, "waiting"));
    settled.waiting = count?.waiting ?? 0;
  });
  return settled;
}

export type AuditRecollectStatus = { waiting: number; done: number; changed: number; failed: number;
  /** 실패 사유별 수 — 사람 몫 */
  failures: Record<string, number> };

/** 감사 화면의 다시 받기 상태 — 다시 받는 중·끝남(그중 근거가 바뀐 것)·실패(사람 몫, 사유별) */
export async function auditRecollectStatus(): Promise<AuditRecollectStatus> {
  const rows = await db.execute<{ state: string; failure_code: string | null; changed: boolean | null; count: number }>(sql`
    select state, failure_code, source_changed as changed, count(*)::int as count from ${productAuditRecollects}
     group by state, failure_code, source_changed`);
  const status: AuditRecollectStatus = { waiting: 0, done: 0, changed: 0, failed: 0, failures: {} };
  for (const row of rows) {
    if (row.state === "waiting") status.waiting += row.count;
    else if (row.state === "done") { status.done += row.count; if (row.changed) status.changed += row.count; }
    else if (row.state === "failed") {
      status.failed += row.count;
      const code = row.failure_code ?? "unknown";
      status.failures[code] = (status.failures[code] ?? 0) + row.count;
    }
  }
  return status;
}
