import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlReviewAttempts, crawlTaglines, modelCapacityRequests, products, productSearchProfiles,
  productTranslations, secondReviews, textTranslations, type CrawlCandidate } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { requestJob } from "@/lib/jobs/control";
import { HELD_QWEN_PROVIDER } from "@/lib/crawl/held-qwen-retry-policy";
import { isReviewCandidate, REVIEW_RETRIABLE_REASONS } from "@/lib/crawl/agent-review-contract";
import { closeModelCapacityUnknownReview } from "@/lib/llm/capacity-repository";
import { requeueReasonText, type RequeueOutcome, type RequeueReason, type RequeueSummary } from "./model-capacity-requeue-text";

/**
 * '확인 못함(종료 미확정)' 행의 작업을 다시 대기열에 넣는다(2026-11-07 사용자 요청, 2026-11-09 행마다 결과·까닭).
 *
 * 원칙:
 * - 장부 행은 물리 종료를 꾸며내지 않는다. 작업을 다시 큐에 넣었거나(requeued) 할 일이 이미 끝났거나 없어진(done) 행만 운영자 검토 근거(0151,
 *   dispatch_reviewed)로 withdrawn 닫고, 메모에 그 까닭을 남긴다.
 * - 라우트별로 실제 작업 큐를 되돌린다. 지원하지 않는 라우트·키를 읽지 못한 행은 닫지 않고(skipped) 까닭과 함께 남겨 사람이 보게 한다.
 * - 같은 호출을 두 번 넣어도 안전하도록 재시도 시각·시도 횟수만 되돌린다. 결과·원본·사람 결정·점유 규칙은 건드리지 않는다.
 * - 판정은 행마다 한다 — 한 묶음에 다시 넣은 행이 있다고 같은 묶음의 다른 행까지 닫지 않는다.
 */
export type RequeueRowResult = Readonly<{ requestId: string; routeId: string; outcome: RequeueOutcome; reason: RequeueReason }>;
export type RequeueGroupResult = {
  routeId: string;
  requests: number;
  requeued: number;
  /** 할 일이 이미 끝났거나 없어진 행 — 다시 넣지 않고 닫는다 */
  done: number;
  skipped: number;
  closed: number;
  /** 남은 행의 까닭 */
  left: { reason: RequeueReason; count: number }[];
  error: string | null;
};
export type RequeueUnknownResult = { groups: RequeueGroupResult[]; closed: number;
  /** 남은 행(닫지 못한 행) — 작업 로그에 남긴다(최대 50) */
  leftRows: { requestId: string; routeId: string; reason: RequeueReason }[] };

type UnknownRow = Pick<typeof modelCapacityRequests.$inferSelect,
  "requestId" | "routeId" | "workKey" | "logicalWorkKey" | "logicalMemberKeys" | "dispatchedAt">;
type Verdict = Readonly<{ outcome: RequeueOutcome; reason: RequeueReason }>;
/** requestId → 결과. 빠진 행은 key_unreadable(남음)로 본다. */
type Verdicts = Map<string, Verdict>;
/** apply=false 면 미리보기다 — 잠그지도 쓰지도 않고 같은 판정만 돌려준다(기록 화면의 행마다 까닭). */
type RequeueHandler = (tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean) => Promise<Verdicts>;

const REQUEUED: Verdict = Object.freeze({ outcome: "requeued", reason: "requeued" });
const done = (reason: RequeueReason): Verdict => ({ outcome: "done", reason });
const skipped = (reason: RequeueReason): Verdict => ({ outcome: "skipped", reason });

const asArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const parseMembers = (values: readonly string[], prefix: string) => values
  .filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
const positiveId = (value: string | undefined): number | null => {
  const id = Number(value);
  return value !== undefined && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(id) ? id : null;
};
const candidateIdFromWorkKey = (key: string | null, prefix: string): number | null =>
  key?.startsWith(prefix) ? positiveId(key.slice(prefix.length)) : null;
const ids = (values: readonly (number | null)[]) => [...new Set(values.filter((id): id is number => id !== null))];
const timestampSql = sql`clock_timestamp()`;
const prioritizeSql: SQL = sql`least(${crawlCandidates.updatedAt}, clock_timestamp() - interval '1 hour')`;
/** 끝난 후보 — 거절됐거나 발행됐다(어느 단계의 모델 호출도 더 필요 없다) */
const candidateFinished = (candidate: Pick<CrawlCandidate, "state" | "publishedSlug">) =>
  candidate.state === "rejected" || candidate.state === "published" || candidate.publishedSlug !== null;

/** 행마다 같은 결과를 매긴다(멤버가 여럿이면 하나라도 다시 넣으면 다시 넣음, 아니면 첫 「끝남」, 그것도 없으면 남음). */
function merge(verdicts: readonly Verdict[]): Verdict {
  return verdicts.find(verdict => verdict.outcome === "requeued") ?? verdicts.find(verdict => verdict.outcome === "done")
    ?? verdicts[0] ?? skipped("key_unreadable");
}

/** 발행 분류: 분류 대기 표시(category_decisions.retry_at)를 지금으로 풀고 발행 잡을 요청한다. 이미 분류됐거나 거절·발행된 후보는 닫기만 한다. */
async function requeuePublicationClassify(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const memberIds = (row: UnknownRow) => ids(parseMembers(asArray(row.logicalMemberKeys), "classify:").map(positiveId));
  const candidateIds = ids(rows.flatMap(memberIds));
  const candidates = candidateIds.length ? await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, state: crawlCandidates.state,
    publishedSlug: crawlCandidates.publishedSlug }).from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds)) : [];
  const repos = [...new Set(candidates.map(candidate => candidate.repo))];
  const decided = new Set(repos.length ? (await tx.select({ repo: categoryDecisions.repo }).from(categoryDecisions)
    .where(and(inArray(categoryDecisions.repo, repos), sql`${categoryDecisions.category} is not null`))).map(row => row.repo) : []);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const memberVerdict = (id: number): Verdict => {
    const candidate = byId.get(id);
    if (!candidate) return done("candidate_gone");
    if (candidateFinished(candidate)) return done("candidate_decided");
    if (decided.has(candidate.repo)) return done("category_done");
    return REQUEUED;
  };
  const verdicts: Verdicts = new Map(rows.map(row => {
    const members = memberIds(row);
    return [row.requestId, members.length ? merge(members.map(memberVerdict)) : skipped("key_unreadable")];
  }));
  const pending = candidateIds.filter(id => memberVerdict(id).outcome === "requeued");
  if (apply && pending.length) {
    const pendingRepos = [...new Set(pending.map(id => byId.get(id)!.repo))];
    await tx.update(categoryDecisions).set({ retryAt: timestampSql, updatedAt: timestampSql })
      .where(and(inArray(categoryDecisions.repo, pendingRepos), isNull(categoryDecisions.category)));
    // 분류 대기 표시가 없는 후보도 발행 잡의 현재 조건(승인·분류 없음)에 다시 들어온다.
    await tx.update(crawlCandidates).set({ updatedAt: prioritizeSql }).where(inArray(crawlCandidates.id, pending));
    await requestJob("crawl-publish", tx);
  }
  return verdicts;
}

/**
 * AI1 1차 검수: 실패 대기를 풀고, 장애로 소진된 후보는 원래 보류 사유로 되돌린다.
 * 1차가 이미 끝났거나 할 일이 없어진 후보는 다시 넣지 않고 닫는다(2026-11-09 — 운영 11-09 의 「건너뜀 4」는 예전 코드가 이런 후보를 넣지도 닫지도 않은 것으로 본다):
 * 사람·DeepSeek·Qwen 이 정한 후보(decided_by 가 auto 아님), 거절·발행된 후보, 원본이 바뀌어 처음부터 다시 판정하는 후보(new),
 * 1차 대상이 아닌 보류 사유(isReviewCandidate 밖 — 2차 갈림 등), 지금 유효한 1차 성공이 이미 있는 후보.
 */
async function requeueFirstReview(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const idOf = (row: UnknownRow) => candidateIdFromWorkKey(row.logicalWorkKey, "ai1:");
  const candidateIds = ids(rows.map(idOf));
  const query = tx.select().from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds.length ? candidateIds : [0]));
  const candidates = apply ? await query.for("update") : await query;
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  // 지금 유효한 1차 자동 성공(규칙 포함) — 그 호출 뒤 다시 시도해 판정이 났다
  const succeeded = new Set(candidateIds.length ? (await tx.select({ candidateId: crawlReviewAttempts.candidateId }).from(crawlReviewAttempts)
    .where(and(inArray(crawlReviewAttempts.candidateId, candidateIds), eq(crawlReviewAttempts.kind, "automatic"),
      eq(crawlReviewAttempts.state, "succeeded"), sql`${crawlReviewAttempts.validUntil} > now()`))).map(row => row.candidateId) : []);
  const candidateVerdict = new Map<number, Verdict>();
  for (const id of candidateIds) {
    const candidate = byId.get(id);
    if (!candidate) { candidateVerdict.set(id, done("candidate_gone")); continue; }
    if (candidateFinished(candidate) || candidate.decidedBy !== "auto") { candidateVerdict.set(id, done("candidate_decided")); continue; }
    if (candidate.state === "new") { candidateVerdict.set(id, done("first_review_reopened")); continue; }
    const signals = candidate.signals as { firstReviewExhausted?: { previousReason?: unknown } } | null;
    const previous = signals?.firstReviewExhausted?.previousReason;
    const exhausted = candidate.state === "needs_review" && candidate.reason === "ai_review_exhausted";
    const retriable = previous === "passed" || REVIEW_RETRIABLE_REASONS.some(reason => reason === previous);
    if (exhausted ? !retriable : !isReviewCandidate(candidate) || succeeded.has(id)) { candidateVerdict.set(id, done("first_review_done")); continue; }
    candidateVerdict.set(id, REQUEUED);
    if (!apply) continue;
    if (exhausted) {
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
  }
  if (apply && [...candidateVerdict.values()].some(verdict => verdict.outcome === "requeued")) await requestJob("crawl-agent-review", tx);
  return new Map(rows.map(row => {
    const id = idOf(row);
    return [row.requestId, id === null ? skipped("key_unreadable") : candidateVerdict.get(id) ?? skipped("key_unreadable")];
  }));
}

/** 보류 Qwen 재심사: 실패/대기 시각만 풀고, 같은 입력의 실패 3회 상한은 운영자 재요청으로 넘긴다. 이미 보류가 아닌 후보는 닫기만 한다. */
async function requeueHeldQwen(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const idOf = (row: UnknownRow) => {
    const match = /^direct:candidate:([1-9][0-9]{0,15}):held_qwen$/.exec(row.logicalWorkKey ?? "");
    return match ? positiveId(match[1]) : null;
  };
  const candidateIds = ids(rows.map(idOf));
  const candidates = candidateIds.length ? await tx.select({ id: crawlCandidates.id, state: crawlCandidates.state, decidedBy: crawlCandidates.decidedBy,
    publishedSlug: crawlCandidates.publishedSlug }).from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds)) : [];
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const verdictOf = (id: number): Verdict => {
    const candidate = byId.get(id);
    if (!candidate) return done("candidate_gone");
    // held-qwen-retry 는 needs_review · decided_by auto · 미발행 후보만 본다 — 그 밖은 판정이 이미 났다
    return candidate.state === "needs_review" && candidate.decidedBy === "auto" && candidate.publishedSlug === null ? REQUEUED : done("candidate_decided");
  };
  const pending = candidateIds.filter(id => verdictOf(id).outcome === "requeued");
  if (apply && pending.length) {
    await tx.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "operator_requeue",
      completedAt: timestampSql, retryAfter: null })
      .where(and(inArray(crawlReviewAttempts.candidateId, pending), eq(crawlReviewAttempts.provider, HELD_QWEN_PROVIDER),
        eq(crawlReviewAttempts.state, "failed")));
    await tx.update(crawlCandidates).set({ updatedAt: prioritizeSql }).where(inArray(crawlCandidates.id, pending));
    await requestJob("held-qwen-retry", tx);
  }
  return new Map(rows.map(row => { const id = idOf(row); return [row.requestId, id === null ? skipped("key_unreadable") : verdictOf(id)]; }));
}

/**
 * AI2 2차 검수: 실패한 표를 다시 pending 으로 돌린다. 이미 사람/완료로 닫힌 표는 건드리지 않고 닫기만 한다.
 * 장부 키의 둘째 수는 표 번호(vote = 원 표 id, second-review-ownership.ts)다 — 대체 표(fallback_for_id = vote)가 이어받은 표는
 * 원 표가 resolved/fallback 으로 닫혀 있으므로 그 사슬에서 아직 끝나지 않은 표를 찾는다.
 */
async function requeueSecondReview(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const keyOf = (row: UnknownRow) => {
    const match = /^ai2:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/.exec(row.logicalWorkKey ?? "");
    const candidateId = match ? positiveId(match[1]) : null, vote = match ? positiveId(match[2]) : null;
    return candidateId !== null && vote !== null ? { candidateId, vote } : null;
  };
  const votes = ids(rows.map(row => keyOf(row)?.vote ?? null));
  const chain = votes.length ? await tx.select({ id: secondReviews.id, candidateId: secondReviews.candidateId, fallbackForId: secondReviews.fallbackForId,
    status: secondReviews.status }).from(secondReviews).where(or(inArray(secondReviews.id, votes), inArray(secondReviews.fallbackForId, votes))) : [];
  const verdictOf = (key: { candidateId: number; vote: number }): { verdict: Verdict; open: number[] } => {
    const members = chain.filter(row => row.candidateId === key.candidateId && (row.id === key.vote || row.fallbackForId === key.vote));
    if (!members.length) return { verdict: done("vote_gone"), open: [] };
    const open = members.filter(row => row.status === "failed" || row.status === "pending").map(row => row.id);
    return open.length ? { verdict: REQUEUED, open } : { verdict: done("vote_done"), open: [] };
  };
  const open = ids(rows.flatMap(row => { const key = keyOf(row); return key ? verdictOf(key).open : []; }));
  if (apply && open.length) {
    const updated = await tx.update(secondReviews).set({ status: "pending", failureCount: 0, errorCode: null,
      errorDetail: null, reviewedAt: null, resolvedAt: null, resolution: null, resolvedBy: null })
      .where(and(inArray(secondReviews.id, open), inArray(secondReviews.status, ["failed", "pending"])))
      .returning({ id: secondReviews.id });
    if (updated.length) await requestJob("second-review", tx);
  }
  return new Map(rows.map(row => { const key = keyOf(row); return [row.requestId, key ? verdictOf(key).verdict : skipped("key_unreadable")]; }));
}

/** 검색 프로필: 재생성 필요 표시와 재시도 시각을 되돌린다. 공개 상태가 아니거나 이미 다시 지은(실패 표시 없이 갱신 대기도 없는) 제품은 닫기만 한다. */
async function requeueSearchProfile(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const idOf = (row: UnknownRow) => { const match = /^text:profile:([1-9][0-9]{0,15})$/.exec(row.logicalWorkKey ?? ""); return match ? positiveId(match[1]) : null; };
  const productIds = ids(rows.map(idOf));
  const listed = new Set(productIds.length ? (await tx.select({ id: products.id }).from(products)
    .where(and(inArray(products.id, productIds), inArray(products.status, ["seeded", "verified"])))).map(product => product.id) : []);
  const profiles = new Map((productIds.length ? await tx.select({ productId: productSearchProfiles.productId, needsRefresh: productSearchProfiles.needsRefresh,
    errorCode: productSearchProfiles.errorCode, generatedAt: productSearchProfiles.generatedAt }).from(productSearchProfiles)
    .where(inArray(productSearchProfiles.productId, productIds)) : []).map(profile => [profile.productId, profile]));
  const verdictOf = (id: number): Verdict => {
    if (!listed.has(id)) return done("product_not_listed");
    const profile = profiles.get(id);
    // 지은 적이 있고 지금 실패 표시·갱신 대기가 없다 — 그 호출 뒤 다시 지었거나 다시 쓸 필요가 없다
    if (profile && !profile.needsRefresh && profile.errorCode === null && profile.generatedAt !== null) return done("profile_done");
    return REQUEUED;
  };
  const pending = productIds.filter(id => verdictOf(id).outcome === "requeued");
  if (apply && pending.length) {
    await tx.update(productSearchProfiles).set({ needsRefresh: true, attempts: 0, errorCode: null,
      retryAt: timestampSql, updatedAt: timestampSql }).where(inArray(productSearchProfiles.productId, pending));
    await requestJob("product-search-profile", tx);
  }
  return new Map(rows.map(row => { const id = idOf(row); return [row.requestId, id === null ? skipped("key_unreadable") : verdictOf(id)]; }));
}

/** 제품 번역: 아직 끝나지 않은(pending·failed) 필드를 pending 으로 되돌려 다시 번역하게 한다. 이미 번역됐거나 대상이 없어진 필드는 닫기만 한다. */
async function requeueProductTranslation(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  type Target = { productId: number; locale: string; field: string; key: string };
  const targetsOf = (row: UnknownRow): Target[] => parseMembers(asArray(row.logicalMemberKeys), "product-translate:").flatMap(member => {
    const [id, locale, field] = member.split(":"), productId = positiveId(id);
    return productId !== null && locale && field ? [{ productId, locale, field, key: `${productId}:${locale}:${field}` }] : [];
  });
  const all = [...new Map(rows.flatMap(targetsOf).map(target => [target.key, target])).values()];
  const productIds = ids(all.map(target => target.productId));
  const current = new Map((productIds.length ? await tx.select({ productId: productTranslations.productId, locale: productTranslations.locale,
    field: productTranslations.field, status: productTranslations.status }).from(productTranslations)
    .where(inArray(productTranslations.productId, productIds)) : []).map(row => [`${row.productId}:${row.locale}:${row.field}`, row.status]));
  const verdictOf = (target: Target): Verdict => {
    const status = current.get(target.key);
    return status === undefined ? done("translation_gone") : status === "ready" || status === "reviewed" ? done("translation_done") : REQUEUED;
  };
  let requeued = 0;
  if (apply) for (const target of all) {
    if (verdictOf(target).outcome !== "requeued") continue;
    const updated = await tx.update(productTranslations).set({ status: "pending", text: null, attempts: 0,
      errorCode: null, retryAt: timestampSql, updatedAt: timestampSql })
      .where(and(eq(productTranslations.productId, target.productId), eq(productTranslations.locale, target.locale as never),
        eq(productTranslations.field, target.field as never), inArray(productTranslations.status, ["pending", "failed"])))
      .returning({ productId: productTranslations.productId });
    requeued += updated.length;
  }
  if (requeued) await requestJob("product-translate", tx);
  return new Map(rows.map(row => { const targets = targetsOf(row); return [row.requestId, targets.length ? merge(targets.map(verdictOf)) : skipped("key_unreadable")]; }));
}

/** 사유 번역: 같은 원문 해시의 끝나지 않은 행을 다시 시도하게 한다. 이미 번역됐거나 원문 행이 없어진 것은 닫기만 한다. */
async function requeueReasonTranslation(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const hashesOf = (row: UnknownRow) => parseMembers(asArray(row.logicalMemberKeys), "ko:").filter(hash => /^[a-f0-9]{64}$/.test(hash));
  const hashes = [...new Set(rows.flatMap(hashesOf))];
  const current = new Map((hashes.length ? await tx.select({ sourceHash: textTranslations.sourceHash, status: textTranslations.status })
    .from(textTranslations).where(and(inArray(textTranslations.sourceHash, hashes), eq(textTranslations.targetLang, "ko"))) : [])
    .map(row => [row.sourceHash, row.status]));
  const verdictOf = (hash: string): Verdict => {
    const status = current.get(hash);
    return status === undefined ? done("translation_gone") : status === "done" ? done("translation_done") : REQUEUED;
  };
  const pending = hashes.filter(hash => verdictOf(hash).outcome === "requeued");
  if (apply && pending.length) {
    const updated = await tx.update(textTranslations).set({ status: "failed", attempts: 0, errorCode: null,
      retryAt: timestampSql, updatedAt: timestampSql })
      .where(and(inArray(textTranslations.sourceHash, pending), eq(textTranslations.targetLang, "ko"),
        sql`${textTranslations.status} <> 'done'`)).returning({ sourceHash: textTranslations.sourceHash });
    if (updated.length) await requestJob("reason-translate", tx);
  }
  return new Map(rows.map(row => { const members = hashesOf(row); return [row.requestId, members.length ? merge(members.map(verdictOf)) : skipped("key_unreadable")]; }));
}

/**
 * 검색 키워드 검수(2026-11-08 사용자 요청). 아직 검수하지 않은 제품은 시도 횟수·재시도 시각을 되돌려 대기열 맨 앞에 세운다
 * (pendingVerifications 가 「실패 원인은 있는데 재시도 시각이 없는」 운영자 재요청을 먼저 읽는다).
 * 실패 원인(verify_error)은 남겨 다음 시도가 나눠 검수(chunked)를 고르게 한다 — reconcileSearchProfileBatch 의 검수 복구와 같은 방식이다.
 * source_revision 을 올려 그 제품의 옛 실행이 다시 쓰지 못하게 하고, updated_at 은 건드리지 않는다(30일 재생성 주기의 기준).
 * 이미 검수가 끝났거나, 키워드를 다시 짓는 중이거나(새 키워드는 다시 검수된다), 키워드·프로필이 없는 제품은 할 일이 남지 않았으므로 넣지 않고 닫는다(done).
 * 공개 상태가 아닌 제품도 닫는다 — 검수 잡은 공개 제품만 보고, 다시 공개되면 검수 안 된 키워드를 잡이 스스로 다시 고른다(장부 행과 무관하다).
 */
async function requeueSearchVerify(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const productOf = (row: UnknownRow) => positiveId(parseMembers(asArray(row.logicalMemberKeys), "search-verify:")[0]);
  const productIds = ids(rows.map(productOf));
  const query = tx.select().from(productSearchProfiles).where(inArray(productSearchProfiles.productId, productIds.length ? productIds : [0]));
  const profiles = new Map((apply ? await query.for("update") : await query).map(profile => [profile.productId, profile]));
  const listed = new Set(productIds.length ? (await tx.select({ id: products.id }).from(products)
    .where(and(inArray(products.id, productIds), inArray(products.status, ["seeded", "verified"])))).map(product => product.id) : []);
  const verdictOf = (id: number): Verdict => {
    if (!listed.has(id)) return done("product_not_listed");
    const profile = profiles.get(id);
    if (!profile) return done("verify_done");
    const settled = profile.verifiedAt !== null || profile.needsRefresh || profile.errorCode !== null
      || profile.keywordsEn.length + profile.keywordsKo.length === 0;
    return settled ? done("verify_done") : REQUEUED;
  };
  const pending = productIds.filter(id => verdictOf(id).outcome === "requeued");
  if (apply && pending.length) {
    await tx.update(productSearchProfiles).set({ verifyAttempts: 0, verifyRetryAt: null,
      sourceRevision: sql`${productSearchProfiles.sourceRevision} + 1` })
      .where(inArray(productSearchProfiles.productId, pending));
    await requestJob("product-search-verify", tx);
  }
  return new Map(rows.map(row => { const id = productOf(row); return [row.requestId, id === null ? skipped("key_unreadable") : verdictOf(id)]; }));
}

/** crawl-tagline 이 다시 짓는 후보(pendingTaglinePredicate 와 같은 조건) — 소개 없음으로 멈춘 자동·관리자·DeepSeek 결정 후보 */
const TAGLINE_DECIDERS = ["auto", "admin", "deepseek"];
/**
 * 수집 소개 짓기(2026-11-09). 장부 키(text:crawl-tagline:<세대·물음 해시>)는 열 수 없어 멤버 키 crawl-tagline:<후보 id> 로 후보를 찾는다.
 * 같은 세대·물음의 결과 미확정 행은 그 단계를 다시 보내지 못하게 막는다(crawlTaglineFence·crawl_tagline_phase_idx, 「보낸 단계」) — 잡이 실패를
 * 적지 못한 채 끝났으면(틱 끝 중단·프로세스 종료) 그 후보는 세대가 바뀔 때까지 매 틱 넘겨진다.
 * 다시 넣기: 실패가 적힌 소개 행은 시도·재시도 시각을 되돌린다 — 행이 바뀌어 다음 물음은 새 세대라 막히지 않는다. 소개 행이 없으면 잡이 이미
 * 고르는 후보이고, 이 장부 행을 닫는 것(withdrawn 은 「보낸 단계」가 아니다)이 막힘을 푼다.
 * 이미 지었거나(사람이 적은 줄·실패 없는 줄) 더 짓지 않는 후보(승인·거절·발행·소개 있음)는 닫기만 한다.
 */
async function requeueCrawlTagline(tx: ProductTransaction, rows: readonly UnknownRow[], apply: boolean): Promise<Verdicts> {
  const idOf = (row: UnknownRow) => positiveId(parseMembers(asArray(row.logicalMemberKeys), "crawl-tagline:")[0]);
  const candidateIds = ids(rows.map(idOf));
  const candidateQuery = tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, state: crawlCandidates.state, reason: crawlCandidates.reason,
    decidedBy: crawlCandidates.decidedBy }).from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds.length ? candidateIds : [0]));
  const candidates = apply ? await candidateQuery.for("update") : await candidateQuery;
  const repos = [...new Set(candidates.map(candidate => candidate.repo))];
  const lineQuery = tx.select({ repo: crawlTaglines.repo, writtenBy: crawlTaglines.writtenBy, errorCode: crawlTaglines.errorCode })
    .from(crawlTaglines).where(inArray(crawlTaglines.repo, repos.length ? repos : [""]));
  const lines = new Map((apply ? await lineQuery.for("update") : await lineQuery).map(line => [line.repo, line]));
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const verdictOf = (id: number): Verdict => {
    const candidate = byId.get(id);
    if (!candidate) return done("candidate_gone");
    if (candidate.state !== "needs_review" || candidate.reason !== "no_description" || !TAGLINE_DECIDERS.includes(candidate.decidedBy ?? ""))
      return done("tagline_not_needed");
    const line = lines.get(candidate.repo);
    if (line && (line.writtenBy !== null || line.errorCode === null)) return done("tagline_done");
    return REQUEUED;
  };
  const pending = candidateIds.filter(id => verdictOf(id).outcome === "requeued");
  if (apply && pending.length) {
    const failedRepos = pending.map(id => byId.get(id)!.repo).filter(repo => lines.has(repo));
    if (failedRepos.length) await tx.update(crawlTaglines).set({ attempts: 0, retryAt: timestampSql, updatedAt: timestampSql })
      .where(and(inArray(crawlTaglines.repo, failedRepos), isNull(crawlTaglines.writtenBy), sql`${crawlTaglines.errorCode} is not null`));
    await requestJob("crawl-tagline", tx);
  }
  return new Map(rows.map(row => { const id = idOf(row); return [row.requestId, id === null ? skipped("key_unreadable") : verdictOf(id)]; }));
}

const HANDLERS: Readonly<Record<string, RequeueHandler>> = {
  "crawl-tagline": requeueCrawlTagline,
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
export const canRequeueUnknownRoute = (routeId: string) => Object.hasOwn(HANDLERS, routeId);

type Scope = Readonly<{ routeId?: string; groupId?: string; provider?: string; limit?: number }>;
async function readUnknownRows(scope: Scope & { requestIds?: readonly string[] }): Promise<UnknownRow[]> {
  const limit = Math.max(1, Math.min(500, scope.limit ?? 500));
  return db.select({ requestId: modelCapacityRequests.requestId, routeId: modelCapacityRequests.routeId,
    workKey: modelCapacityRequests.workKey, logicalWorkKey: modelCapacityRequests.logicalWorkKey,
    logicalMemberKeys: modelCapacityRequests.logicalMemberKeys, dispatchedAt: modelCapacityRequests.dispatchedAt })
    .from(modelCapacityRequests)
    .where(and(eq(modelCapacityRequests.state, "indeterminate"),
      scope.routeId ? eq(modelCapacityRequests.routeId, scope.routeId) : undefined,
      scope.groupId ? eq(modelCapacityRequests.groupId, scope.groupId) : undefined,
      scope.provider ? eq(modelCapacityRequests.provider, scope.provider) : undefined,
      scope.requestIds ? inArray(modelCapacityRequests.requestId, scope.requestIds.length ? [...scope.requestIds] : ["00000000-0000-0000-0000-000000000000"]) : undefined))
    .orderBy(asc(modelCapacityRequests.dispatchedAt), asc(modelCapacityRequests.queueOrdinal)).limit(limit);
}
const byRoute = (rows: readonly UnknownRow[]) => rows.reduce((map, row) => map.set(row.routeId, [...(map.get(row.routeId) ?? []), row]), new Map<string, UnknownRow[]>());
const countLeft = (results: readonly RequeueRowResult[]) => [...results.filter(row => row.outcome === "skipped")
  .reduce((map, row) => map.set(row.reason, (map.get(row.reason) ?? 0) + 1), new Map<RequeueReason, number>())]
  .map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

/**
 * 범위(routeId · groupId=장비 · provider=CLI 도구, 없으면 전부) 안의 결과 미확정 행을 라우트별로 처리한다. 요청 행은 최대 500개까지 읽는다.
 * 작업 재큐(한 라우트 한 트랜잭션)가 성공한 뒤, 다시 넣었거나(requeued) 할 일이 끝난(done) 행만 운영자 검토(withdrawn)로 닫는다 — 메모에 까닭을 남긴다.
 * 지원하지 않는 라우트·키를 못 읽은 행·라우트 처리 오류는 그대로 남는다(skipped + 까닭).
 * 관리자 서버 동작(requeueUnknownReviews)만 부른다 — 그것이 작업 로그(model-capacity-unknown-requeued)를 남긴다.
 */
export async function requeueModelCapacityUnknowns(input: Scope & { operator: string; note: string }): Promise<RequeueUnknownResult> {
  const rows = await readUnknownRows(input);
  const groups: RequeueGroupResult[] = [];
  const leftRows: RequeueUnknownResult["leftRows"] = [];
  for (const [routeId, group] of byRoute(rows)) {
    const handler = HANDLERS[routeId];
    let verdicts: Verdicts, error: string | null = null;
    if (!handler) verdicts = new Map(group.map(row => [row.requestId, skipped("unsupported_route")]));
    else try {
      verdicts = await db.transaction(tx => handler(tx, group, true));
    } catch (failure) {
      error = failure instanceof Error ? failure.message.slice(0, 120) : "requeue_failed";
      verdicts = new Map(group.map(row => [row.requestId, skipped("route_error")]));
    }
    const results: RequeueRowResult[] = [];
    let closed = 0;
    for (const row of group) {
      const verdict = verdicts.get(row.requestId) ?? skipped("key_unreadable");
      if (verdict.outcome === "skipped") { results.push({ requestId: row.requestId, routeId, ...verdict }); continue; }
      const note = `${input.note} · ${routeId} · ${requeueReasonText(verdict.reason)}`.slice(0, 400);
      const closedResult = await closeModelCapacityUnknownReview({ requestId: row.requestId, operator: input.operator, note }).catch(() => null);
      if (closedResult?.kind === "reviewed") closed++;
      // 늦은 종료 근거로 이미 정산·닫힌 행(not_indeterminate)은 남은 행이 아니다. 닫기 자체가 실패한 행만 남는다.
      if (closedResult === null) results.push({ requestId: row.requestId, routeId, outcome: "skipped", reason: "close_failed" });
      else results.push({ requestId: row.requestId, routeId, ...verdict });
    }
    const left = countLeft(results);
    for (const result of results) if (result.outcome === "skipped" && leftRows.length < 50)
      leftRows.push({ requestId: result.requestId, routeId, reason: result.reason });
    groups.push({ routeId, requests: group.length, requeued: results.filter(row => row.outcome === "requeued").length,
      done: results.filter(row => row.outcome === "done").length, skipped: results.filter(row => row.outcome === "skipped").length, closed, left, error });
  }
  return { groups, closed: groups.reduce((sum, group) => sum + group.closed, 0), leftRows };
}

/** 한 번 누른 결과 → 화면 한 줄(N건 다시 넣음 · M건 닫음 · K건 남음(까닭)) */
export function summarizeRequeue(result: RequeueUnknownResult): RequeueSummary {
  const reasons = new Map<string, number>();
  for (const group of result.groups) for (const entry of group.left) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + entry.count);
  return { requests: result.groups.reduce((sum, group) => sum + group.requests, 0), requeued: result.groups.reduce((sum, group) => sum + group.requeued, 0),
    done: result.groups.reduce((sum, group) => sum + group.done, 0), closed: result.closed,
    left: result.groups.reduce((sum, group) => sum + group.skipped, 0),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) };
}

/**
 * 미리보기(읽기만) — 지금 「다시 대기열」을 누르면 행마다 어떻게 되는지(다시 넣음 · 닫음 + 까닭 · 남음 + 까닭). 기록 › 재실행 패널이 행마다 까닭을 보인다.
 * 읽기 전용 트랜잭션에서 같은 판정 함수를 apply=false 로 부른다(잠그지도 쓰지도 않는다). 못 읽은 라우트는 빠진다(화면은 그 행의 까닭을 비운다).
 */
export async function previewModelCapacityUnknowns(requestIds: readonly string[]): Promise<Map<string, RequeueRowResult>> {
  const out = new Map<string, RequeueRowResult>();
  if (!requestIds.length) return out;
  const rows = await readUnknownRows({ requestIds, limit: 500 });
  for (const [routeId, group] of byRoute(rows)) {
    const handler = HANDLERS[routeId];
    let verdicts: Verdicts;
    if (!handler) verdicts = new Map(group.map(row => [row.requestId, skipped("unsupported_route")]));
    else try {
      verdicts = await db.transaction(tx => handler(tx, group, false), { accessMode: "read only" });
    } catch { continue; }
    for (const row of group) out.set(row.requestId, { requestId: row.requestId, routeId, ...(verdicts.get(row.requestId) ?? skipped("key_unreadable")) });
  }
  return out;
}
