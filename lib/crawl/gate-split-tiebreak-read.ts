import { and, desc, eq, inArray, isNotNull, sql, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, gateSplitTiebreaks, secondReviews } from "@/lib/db/schema";
import { endpointBackoffActive, readQwenEndpointBackoff } from "./qwen-endpoint-backoff";
import { QWEN_V2_PROMPT_VERSION } from "./qwen-direct-review";

/**
 * 2차 갈림 판가름(gate-split-tiebreak.ts)의 읽기 쪽 — 심사 큐의 배지·정렬과 머리의 상태 줄. DB 를 쓰지 않는다.
 * 심사 목록(admin-review.ts)이 이 파일을 읽고, 판가름 잡은 admin-review.ts 를 읽으므로 둘을 나눠 순환을 막는다.
 */

/** 거부로 닫은 갈림 보류의 사유 — 사람의 거부 사유(personal_site·not_a_product·large_oss)와 가른다. 40자 칸에 31자 */
export const SPLIT_QWEN_REJECT_REASON = "second_review_split_qwen_reject";
/** 결정 기록(crawl_review_attempts kind=delegated)의 provider — 게이트웨이(abcllm)를 거치지 않은 gpu3090 직접 호출. actor 는 QWEN_V2_AUTO_SOURCE */
export const SPLIT_TIEBREAK_PROVIDER = "qwen-direct";

/** 항목 탓 실패(형식 오류 등)는 세 번이면 그만 묻는다 — 2차 표와 같은 수(MAX_SECOND_REVIEW_FAILURES) */
export const SPLIT_TIEBREAK_MAX_FAILURES = 3;

const t = gateSplitTiebreaks;

/**
 * 지금도 사람 큐에 선 갈림 보류에 붙은 이 판의 판가름인가. 관문 세대가 바뀌었으면(새 1차 판단·새 입력) 옛 답은 지금 후보의 답이 아니다.
 * 관문 행이 아직 사람 확인(needs_human)으로 열려 있어야 한다.
 */
const liveVerdict = sql`${t.state} = 'succeeded' AND ${t.promptVersion} = ${QWEN_V2_PROMPT_VERSION}
  AND ${crawlCandidates.state} = 'needs_review' AND ${crawlCandidates.reason} = 'second_review_split'
  AND EXISTS (SELECT 1 FROM ${secondReviews} g WHERE g.candidate_id = ${t.candidateId} AND g.generation_key = ${t.generationKey}
    AND g.trigger = 'ai_approved' AND g.status = 'needs_human')`;

/**
 * 목록의 맨 앞 — Qwen-v2 도 승인한 갈림 보류(«Qwen-v2 승인 — 발행 후보»). 사람이 확인만 하면 되는 것부터 보이게 어떤 정렬보다 앞에 둔다.
 * 거부·발행 목록에서는 늘 거짓이라 순서를 바꾸지 않는다.
 */
export const splitTiebreakApprovedFirst = sql`(EXISTS (SELECT 1 FROM ${t} WHERE ${t.candidateId} = ${crawlCandidates.id}
  AND ${t.decision} = 'approve' AND ${liveVerdict})) DESC`;

export type SplitTiebreakView = {
  decision: "approve" | "reject" | "needs_review" | null; confidence: number | null; reason: string | null;
  model: string; promptVersion: string; applied: string | null; at: string | null;
  /** 지금 후보의 관문 세대에 붙은 답인가 — 아니면 지난 입력의 답이라 배지를 달지 않는다 */
  current: boolean;
};

/** 후보마다 마지막 판가름 — 상세의 «Qwen-v2 판가름» 칸과 목록의 배지 */
export async function splitTiebreakVerdicts(candidateIds: number[]): Promise<Map<number, SplitTiebreakView>> {
  if (!candidateIds.length) return new Map();
  const rows = await db.selectDistinctOn([t.candidateId], {
    candidateId: t.candidateId, decision: t.decision, confidence: t.confidence, reason: t.reason, model: t.model,
    promptVersion: t.promptVersion, applied: t.applied, completedAt: t.completedAt,
    current: sql<boolean>`(${liveVerdict})`,
  }).from(t).innerJoin(crawlCandidates, eq(crawlCandidates.id, t.candidateId))
    .where(and(inArray(t.candidateId, candidateIds), eq(t.state, "succeeded")))
    .orderBy(t.candidateId, desc(t.completedAt), desc(t.id));
  return new Map(rows.map(row => [row.candidateId, { decision: row.decision, confidence: row.confidence, reason: row.reason,
    model: row.model, promptVersion: row.promptVersion, applied: row.applied, at: row.completedAt?.toISOString() ?? null,
    current: Boolean(row.current) }]));
}

export type SplitTiebreakStatus = {
  /** 이 판으로 답을 받은 수 · 그중 거부로 닫은 수 · 승인이라 사람을 기다리는 지금 후보 수 · 거부지만 다수가 아니거나 카탈로그라 남긴 수 */
  processed: number; rejected: number; approvedWaiting: number; heldReject: number;
  /** 아직 답이 없는 지금 갈림 보류(관문 세대 기준) — 실패 뒤 기다리는 것 포함 */
  remaining: number;
  /** 관문 입력을 그대로 다시 만들 수 없어 사람에게 남긴 것(원본·정책이 바뀜 등) · 항목 탓 실패를 다 쓴 것 */
  ineligible: number; exhausted: number;
  /** 최근 24시간 */
  day: { processed: number; rejected: number };
  /** 이 판의 마지막 실패(멈춤·단계 전환은 오류가 아니다)와 마지막으로 답을 받은 때 — 마지막 성공이 더 늦으면 그 뒤 다시 받은 것이다 */
  lastError: { code: string; at: string } | null;
  lastSuccessAt: string | null;
  /** gpu3090 을 부르는 모두가 물러나는 중이면 그 끝(qwen-endpoint-backoff.ts — 워커가 적은 관측) */
  backoffUntil: string | null;
};

/** 심사 큐 머리의 판가름 줄 — 한 번에 센다(표가 작다: 갈림 보류 수 × 판) */
export async function splitTiebreakStatus(): Promise<SplitTiebreakStatus> {
  const maxFailures = SPLIT_TIEBREAK_MAX_FAILURES;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [counts] = await db.select({
    processed: sql<number>`count(*) filter (where ${t.state} = 'succeeded')::int`,
    rejected: sql<number>`count(*) filter (where ${t.applied} = 'rejected')::int`,
    heldReject: sql<number>`count(*) filter (where ${t.applied} in ('held_minority', 'held_catalog', 'held_low_confidence', 'held_not_enforce'))::int`,
    ineligible: sql<number>`count(*) filter (where ${t.state} = 'ineligible')::int`,
    exhausted: sql<number>`count(*) filter (where ${t.state} = 'failed' and ${t.failureCount} >= ${maxFailures})::int`,
    dayProcessed: sql<number>`count(*) filter (where ${t.state} = 'succeeded' and ${t.completedAt} > ${since}::timestamp)::int`,
    dayRejected: sql<number>`count(*) filter (where ${t.applied} = 'rejected' and ${t.completedAt} > ${since}::timestamp)::int`,
  }).from(t).where(eq(t.promptVersion, QWEN_V2_PROMPT_VERSION));
  const [waiting] = await db.select({ count: sql<number>`count(distinct ${t.candidateId})::int` }).from(t)
    .innerJoin(crawlCandidates, eq(crawlCandidates.id, t.candidateId)).where(and(eq(t.decision, "approve"), liveVerdict));
  const [open] = await db.select({ count: sql<number>`count(distinct (${crawlCandidates.id}, ${secondReviews.generationKey}))::int` })
    .from(crawlCandidates).innerJoin(secondReviews, and(eq(secondReviews.candidateId, crawlCandidates.id),
      eq(secondReviews.trigger, "ai_approved"), eq(secondReviews.status, "needs_human")))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "second_review_split"),
      eq(crawlCandidates.decidedBy, "auto"), sql`${crawlCandidates.publishedSlug} is null`,
      sql`not exists (select 1 from ${t} where ${t.candidateId} = ${crawlCandidates.id} and ${t.generationKey} = ${secondReviews.generationKey}
        and ${t.promptVersion} = ${QWEN_V2_PROMPT_VERSION}
        and (${t.state} in ('succeeded', 'ineligible') or (${t.state} = 'failed' and ${t.failureCount} >= ${maxFailures})))`));
  const [error] = await db.select({ code: t.errorCode, at: t.completedAt }).from(t)
    .where(and(eq(t.state, "failed"), isNotNull(t.errorCode), isNotNull(t.completedAt), eq(t.promptVersion, QWEN_V2_PROMPT_VERSION),
      notInArray(t.errorCode, ["stage_draining", "qwen_cancelled"]))).orderBy(desc(t.completedAt)).limit(1);
  const [success] = await db.select({ at: t.completedAt }).from(t)
    .where(and(eq(t.state, "succeeded"), isNotNull(t.completedAt), eq(t.promptVersion, QWEN_V2_PROMPT_VERSION))).orderBy(desc(t.completedAt)).limit(1);
  const backoff = await readQwenEndpointBackoff().catch(() => null);
  return {
    processed: counts?.processed ?? 0, rejected: counts?.rejected ?? 0, approvedWaiting: waiting?.count ?? 0,
    heldReject: counts?.heldReject ?? 0, remaining: open?.count ?? 0, ineligible: counts?.ineligible ?? 0, exhausted: counts?.exhausted ?? 0,
    day: { processed: counts?.dayProcessed ?? 0, rejected: counts?.dayRejected ?? 0 },
    lastError: error?.code && error.at ? { code: error.code, at: error.at.toISOString() } : null,
    lastSuccessAt: success?.at?.toISOString() ?? null,
    backoffUntil: endpointBackoffActive(backoff) ? backoff.retryAt : null,
  };
}
