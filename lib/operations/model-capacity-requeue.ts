import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlReviewAttempts, modelCapacityRequests, products, productSearchProfiles,
  productTranslations, secondReviews, textTranslations, type CrawlCandidate } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { requestJob } from "@/lib/jobs/control";
import { HELD_QWEN_PROVIDER } from "@/lib/crawl/held-qwen-retry-policy";
import { closeModelCapacityUnknownReview } from "@/lib/llm/capacity-repository";

/**
 * '확인 못함(종료 미확정)' 행의 작업을 다시 대기열에 넣는다(2026-11-07 사용자 요청).
 *
 * 원칙:
 * - 장부 행은 물리 종료를 꾸며내지 않는다. 작업을 다시 큐에 넣은 뒤, 운영자 검토 근거(0151)로만 withdrawn 닫는다.
 * - 라우트별로 실제 작업 큐를 되돌린다. 지원하지 않는 라우트는 닫지 않고 그대로 남겨 사람이 보게 한다.
 * - 같은 호출을 두 번 넣어도 안전하도록 재시도 시각·시도 횟수만 되돌린다. 결과·원본·사람 결정은 건드리지 않는다.
 */
export type RequeueGroupResult = {
  routeId: string;
  requests: number;
  requeued: number;
  /** 할 일이 이미 끝났거나 다른 대기열이 맡은 행 — 다시 넣지 않고 닫는다(검색 키워드 검수) */
  done: number;
  skipped: number;
  closed: number;
  error: string | null;
};
export type RequeueUnknownResult = { groups: RequeueGroupResult[]; closed: number };

type UnknownRow = Pick<typeof modelCapacityRequests.$inferSelect,
  "requestId" | "routeId" | "workKey" | "logicalWorkKey" | "logicalMemberKeys" | "dispatchedAt">;

const asArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const parseMembers = (values: readonly string[], prefix: string) => values
  .filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
const candidateIdFromWorkKey = (key: string | null, prefix: string): number | null => {
  if (!key?.startsWith(prefix)) return null;
  const id = Number(key.slice(prefix.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const timestampSql = sql`clock_timestamp()`;
const prioritizeSql: SQL = sql`least(${crawlCandidates.updatedAt}, clock_timestamp() - interval '1 hour')`;

/** 발행 분류: 분류 대기 표시(category_decisions.retry_at)를 지금으로 풀고 발행 잡을 요청한다. */
async function requeuePublicationClassify(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const candidateIds = [...new Set(rows.flatMap(row => parseMembers(asArray(row.logicalMemberKeys), "classify:"))
    .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!candidateIds.length) return { requeued: 0, skipped: rows.length };
  const candidates = await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo }).from(crawlCandidates)
    .where(inArray(crawlCandidates.id, candidateIds));
  const repos = [...new Set(candidates.map(candidate => candidate.repo))];
  if (!repos.length) return { requeued: 0, skipped: rows.length };
  await tx.update(categoryDecisions).set({ retryAt: timestampSql, updatedAt: timestampSql })
    .where(and(inArray(categoryDecisions.repo, repos), isNull(categoryDecisions.category)));
  // 분류 대기 표시가 없는 후보도 발행 잡의 현재 조건(승인·분류 없음)에 다시 들어온다.
  await tx.update(crawlCandidates).set({ updatedAt: prioritizeSql })
    .where(inArray(crawlCandidates.id, candidateIds));
  await requestJob("crawl-publish", tx);
  return { requeued: rows.length, skipped: 0 };
}

/** AI1 1차 검수: 실패 대기를 풀고, 장애로 소진된 후보는 원래 보류 사유로 되돌린다. */
async function requeueFirstReview(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const ids = [...new Set(rows.map(row => candidateIdFromWorkKey(row.logicalWorkKey, "ai1:")).filter((id): id is number => id !== null))];
  if (!ids.length) return { requeued: 0, skipped: rows.length };
  const candidates = await tx.select().from(crawlCandidates).where(inArray(crawlCandidates.id, ids)).for("update");
  let requeued = 0, skipped = 0;
  for (const candidate of candidates) {
    if (candidate.decidedBy !== "auto" || !["approved", "needs_review"].includes(candidate.state)) { skipped++; continue; }
    const signals = candidate.signals as { firstReviewExhausted?: { previousReason?: unknown } } | null;
    const previous = signals?.firstReviewExhausted?.previousReason;
    if (candidate.state === "needs_review" && candidate.reason === "ai_review_exhausted") {
      const retriable = previous === "passed" || previous === "ambiguous" || previous === "ai_evidence_pending"
        || previous === "ai_evidence_insufficient" || previous === "ai_evidence_not_found"
        || previous === "repository_relationship_conflict" || previous === "source_changed";
      if (!retriable) { skipped++; continue; }
      await tx.update(crawlCandidates).set({
        state: previous === "passed" ? "approved" : "needs_review",
        reason: previous as CrawlCandidate["reason"],
        signals: sql`(${crawlCandidates.signals} - 'firstReviewExhausted' - 'stoppedAt')
          || jsonb_build_object('firstReviewRequeuedAt', clock_timestamp())`,
        updatedAt: prioritizeSql,
      }).where(eq(crawlCandidates.id, candidate.id));
    } else {
      await tx.update(crawlCandidates).set({ updatedAt: prioritizeSql }).where(eq(crawlCandidates.id, candidate.id));
    }
    await tx.update(crawlReviewAttempts).set({ retryAfter: timestampSql })
      .where(and(eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.state, "failed")));
    requeued++;
  }
  if (requeued) await requestJob("crawl-agent-review", tx);
  return { requeued, skipped };
}

/** 보류 Qwen 재심사: 실패/대기 시각만 풀고, 같은 입력의 실패 3회 상한은 운영자 재요청으로 넘긴다. */
async function requeueHeldQwen(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const ids = [...new Set(rows.map(row => {
    const key = row.logicalWorkKey ?? "";
    const match = /^direct:candidate:([1-9][0-9]*):held_qwen$/.exec(key);
    return match ? Number(match[1]) : null;
  }).filter((id): id is number => id !== null))];
  if (!ids.length) return { requeued: 0, skipped: rows.length };
  await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "operator_requeue",
    completedAt: timestampSql, retryAfter: null })
    .where(and(inArray(crawlReviewAttempts.candidateId, ids), eq(crawlReviewAttempts.provider, HELD_QWEN_PROVIDER),
      eq(crawlReviewAttempts.state, "failed")));
  await tx.update(crawlCandidates).set({ updatedAt: prioritizeSql }).where(inArray(crawlCandidates.id, ids));
  await requestJob("held-qwen-retry", tx);
  return { requeued: rows.length, skipped: 0 };
}

/** AI2 2차 검수: 실패한 표를 다시 pending 으로 돌린다. 이미 사람/완료로 닫힌 표는 건드리지 않는다. */
async function requeueSecondReview(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const ids = [...new Set(rows.map(row => {
    const parts = (row.logicalWorkKey ?? "").split(":");
    if (parts.length !== 3 || parts[0] !== "ai2") return null;
    const id = Number(parts[2]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }).filter((id): id is number => id !== null))];
  if (!ids.length) return { requeued: 0, skipped: rows.length };
  const updated = await tx.update(secondReviews).set({ status: "pending", failureCount: 0, errorCode: null,
    errorDetail: null, reviewedAt: null, resolvedAt: null, resolution: null, resolvedBy: null })
    .where(and(inArray(secondReviews.id, ids), inArray(secondReviews.status, ["failed", "pending"])))
    .returning({ id: secondReviews.id });
  if (updated.length) await requestJob("second-review", tx);
  return { requeued: updated.length, skipped: rows.length - updated.length };
}

/** 검색 프로필: 재생성 필요 표시와 재시도 시각을 되돌린다. */
async function requeueSearchProfile(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const ids = [...new Set(rows.map(row => {
    const match = /^text:profile:([1-9][0-9]*)$/.exec(row.logicalWorkKey ?? "");
    return match ? Number(match[1]) : null;
  }).filter((id): id is number => id !== null))];
  if (!ids.length) return { requeued: 0, skipped: rows.length };
  await tx.update(productSearchProfiles).set({ needsRefresh: true, attempts: 0, errorCode: null,
    retryAt: timestampSql, updatedAt: timestampSql }).where(inArray(productSearchProfiles.productId, ids));
  await requestJob("product-search-profile", tx);
  return { requeued: rows.length, skipped: 0 };
}

/** 제품 번역: 해당 필드를 pending 으로 되돌려 다시 번역하게 한다. */
async function requeueProductTranslation(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const members = rows.flatMap(row => parseMembers(asArray(row.logicalMemberKeys), "product-translate:"));
  if (!members.length) return { requeued: 0, skipped: rows.length };
  let requeued = 0;
  for (const member of new Set(members)) {
    const parts = member.split(":");
    const productId = Number(parts[0]), locale = parts[1], field = parts[2];
    if (!Number.isSafeInteger(productId) || !locale || !field) continue;
    const updated = await tx.update(productTranslations).set({ status: "pending", text: null, attempts: 0,
      errorCode: null, retryAt: timestampSql, updatedAt: timestampSql })
      .where(and(eq(productTranslations.productId, productId), eq(productTranslations.locale, locale as never),
        eq(productTranslations.field, field as never), inArray(productTranslations.status, ["pending", "failed"])))
      .returning({ productId: productTranslations.productId });
    if (updated.length) requeued++;
  }
  if (requeued) await requestJob("product-translate", tx);
  return { requeued, skipped: rows.length - requeued };
}

/** 사유 번역: 같은 원문 해시의 실패 행을 다시 시도하게 한다. */
async function requeueReasonTranslation(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const hashes = [...new Set(rows.flatMap(row => parseMembers(asArray(row.logicalMemberKeys), "ko:")))];
  if (!hashes.length) return { requeued: 0, skipped: rows.length };
  const updated = await tx.update(textTranslations).set({ status: "failed", attempts: 0, errorCode: null,
    retryAt: timestampSql, updatedAt: timestampSql })
    .where(and(inArray(textTranslations.sourceHash, hashes), eq(textTranslations.targetLang, "ko"),
      sql`${textTranslations.status} <> 'done'`)).returning({ sourceHash: textTranslations.sourceHash });
  if (updated.length) await requestJob("reason-translate", tx);
  return { requeued: updated.length ? rows.length : 0, skipped: updated.length ? 0 : rows.length };
}

/**
 * 검색 키워드 검수(2026-11-08 사용자 요청). 아직 검수하지 않은 제품은 시도 횟수·재시도 시각을 되돌려 대기열 맨 앞에 세운다
 * (pendingVerifications 가 「실패 원인은 있는데 재시도 시각이 없는」 운영자 재요청을 먼저 읽는다).
 * 실패 원인(verify_error)은 남겨 다음 시도가 나눠 검수(chunked)를 고르게 한다 — reconcileSearchProfileBatch 의 검수 복구와 같은 방식이다.
 * source_revision 을 올려 그 제품의 옛 실행이 다시 쓰지 못하게 하고, updated_at 은 건드리지 않는다(30일 재생성 주기의 기준).
 * 이미 검수가 끝났거나, 키워드를 다시 짓는 중이거나(새 키워드는 다시 검수된다), 키워드가 없는 제품은 할 일이 남지 않았으므로 넣지 않고 닫는다(done).
 * 공개 상태가 아닌 제품은 넣지도 닫지도 않는다(skipped).
 */
async function requeueSearchVerify(tx: ProductTransaction, rows: readonly UnknownRow[]) {
  const productOf = (row: UnknownRow) => {
    const [member] = parseMembers(asArray(row.logicalMemberKeys), "search-verify:"), id = Number(member);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const ids = [...new Set(rows.map(productOf).filter((id): id is number => id !== null))];
  if (!ids.length) return { requeued: 0, done: 0, skipped: rows.length };
  const profiles = await tx.select().from(productSearchProfiles).where(inArray(productSearchProfiles.productId, ids)).for("update");
  const listed = new Set((await tx.select({ id: products.id }).from(products)
    .where(and(inArray(products.id, ids), inArray(products.status, ["seeded", "verified"])))).map(product => product.id));
  const outcome = new Map<number, "requeued" | "done">();
  for (const profile of profiles) {
    if (!listed.has(profile.productId)) continue;
    const settled = profile.verifiedAt !== null || profile.needsRefresh || profile.errorCode !== null
      || profile.keywordsEn.length + profile.keywordsKo.length === 0;
    outcome.set(profile.productId, settled ? "done" : "requeued");
  }
  const pending = ids.filter(id => outcome.get(id) === "requeued");
  if (pending.length) {
    await tx.update(productSearchProfiles).set({ verifyAttempts: 0, verifyRetryAt: null,
      sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1` })
      .where(inArray(productSearchProfiles.productId, pending));
    await requestJob("product-search-verify", tx);
  }
  let requeued = 0, done = 0;
  for (const row of rows) {
    const id = productOf(row), result = id === null ? undefined : outcome.get(id);
    if (result === "requeued") requeued++; else if (result === "done") done++;
  }
  return { requeued, done, skipped: rows.length - requeued - done };
}

type RequeueHandler = (tx: ProductTransaction, rows: readonly UnknownRow[]) => Promise<{ requeued: number; skipped: number; done?: number }>;
const HANDLERS: Readonly<Record<string, RequeueHandler>> = {
  "crawl-publish-classify": requeuePublicationClassify,
  "crawl-agent-review": requeueFirstReview,
  "local-held-qwen": requeueHeldQwen,
  "second-review": requeueSecondReview,
  "product-search-profile": requeueSearchProfile,
  "product-search-verify": requeueSearchVerify,
  "product-translate": requeueProductTranslation,
  "reason-translate": requeueReasonTranslation,
};

/** 지원 라우트인가 — UI가 버튼을 보일지 정할 때 쓴다. */
export const canRequeueUnknownRoute = (routeId: string) => Boolean(HANDLERS[routeId]);

/**
 * `routeId`가 없으면 지원하는 모든 라우트를 한 번에 처리한다. 요청 행은 최대 500개까지 읽는다.
 * 작업 재큐 성공 뒤에만 그 라우트의 장부 행을 운영자 검토(withdrawn)로 닫는다.
 */
export async function requeueModelCapacityUnknowns(input: {
  routeId?: string; operator: string; note: string; limit?: number;
}): Promise<RequeueUnknownResult> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 500));
  const rows = await db.select({ requestId: modelCapacityRequests.requestId, routeId: modelCapacityRequests.routeId,
    workKey: modelCapacityRequests.workKey, logicalWorkKey: modelCapacityRequests.logicalWorkKey,
    logicalMemberKeys: modelCapacityRequests.logicalMemberKeys, dispatchedAt: modelCapacityRequests.dispatchedAt })
    .from(modelCapacityRequests)
    .where(and(eq(modelCapacityRequests.state, "indeterminate"),
      input.routeId ? eq(modelCapacityRequests.routeId, input.routeId) : undefined))
    .orderBy(asc(modelCapacityRequests.dispatchedAt), asc(modelCapacityRequests.queueOrdinal)).limit(limit);
  const grouped = new Map<string, UnknownRow[]>();
  for (const row of rows) grouped.set(row.routeId, [...(grouped.get(row.routeId) ?? []), row]);
  const groups: RequeueGroupResult[] = [];
  for (const [routeId, group] of grouped) {
    const handler = HANDLERS[routeId];
    if (!handler) {
      groups.push({ routeId, requests: group.length, requeued: 0, done: 0, skipped: group.length, closed: 0, error: "unsupported_route" });
      continue;
    }
    let result: Awaited<ReturnType<RequeueHandler>>;
    try {
      result = await db.transaction(tx => handler(tx, group));
    } catch (error) {
      groups.push({ routeId, requests: group.length, requeued: 0, done: 0, skipped: 0, closed: 0,
        error: error instanceof Error ? error.message.slice(0, 120) : "requeue_failed" });
      continue;
    }
    let closed = 0;
    const done = result.done ?? 0;
    if (result.requeued > 0 || done > 0) {
      for (const row of group) {
        const closedResult = await closeModelCapacityUnknownReview({ requestId: row.requestId, operator: input.operator,
          note: `${input.note} · ${routeId}` }).catch(() => null);
        if (closedResult?.kind === "reviewed") closed++;
      }
    }
    groups.push({ routeId, requests: group.length, requeued: result.requeued, done, skipped: result.skipped, closed, error: null });
  }
  return { groups, closed: groups.reduce((sum, group) => sum + group.closed, 0) };
}
