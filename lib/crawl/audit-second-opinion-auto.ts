import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, operationsObservations, productAuditAttempts, productAuditCampaigns, productAuditItems,
  productAuditPolicyRunItems, productAuditPolicyRuns, productAuditSecondOpinions, products, secondReviews, type SecondReviewAutoOpinion } from "@/lib/db/schema";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import type { JobContext } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import type { ReviewInput } from "./agent-review-contract";
import { loadReviewInput } from "./agent-review-repository";
import { writeAuditSecondOpinions } from "./audit-second-opinion-import";
import { AUTO_CLOSE_MIN_CONFIDENCE, autoClosableSql, autoCloseOpinion, autoCloseToday, utcDay, type AutoCloseResult,
  type AutoCloseToday } from "./audit-auto-close";
import { openAuditRejectUniverse } from "./audit-policy";
import { AUDIT_HOLD_PURGE, AUDIT_HOLD_SWEEP_BATCH, AUDIT_RELEASE_PURGE, auditItemModel, holdCandidate } from "./product-audit-hold";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { QWEN_AUDIT_PROVIDER } from "./product-audit-reviewer";
import { endpointBackoffActive, noteQwenCallFailure, noteQwenEndpointSuccess, qwenEndpointBackingOff, readQwenEndpointBackoff,
  withQwenSecondarySlot } from "./qwen-endpoint-backoff";
import { loadAuditInput } from "./product-audit";
import { applyPublishedAutoOpinion, type PublishedAutoResult } from "./published-second-review";
import { QWEN_V2_AUTO_SOURCE, QWEN_V2_PROMPT_VERSION, QwenDirectError, qwenDirectConfig, reviewWithQwenDirect,
  type QwenDirectReview } from "./qwen-direct-review";
import { lockedSettings, type AuditHoldSettings } from "./settings";
import type { AuditOpinionScope, CrawlSettings } from "./settings-schema";
import { thinPageTextSql } from "./audit-text-gate";
import { screenReviewCounts, type ScreenReviewCounts } from "./audit-screen-review";

/**
 * Qwen-v2 자동 단계(2026-10-21) — 감사 잡(jobs/product-audit.ts)이 틱마다 감사 묻기와 나란히 한 번 돈다. gpu3090 의 Qwen 을 게이트웨이 밖에서
 * 바로 부르므로(qwen-direct-review.ts) 게이트웨이 자리·공통 슬롯을 쓰지 않는다(M3 DeepSeek 과 같다). 한 번에 한 호출이다.
 *
 * 1. 감사 두 번째 의견(qwenAuto.auditSecondOpinion, 기본 꺼짐): 묻는 범위(scope)는 지금 감사의 열린 AI 거절 전부(all — 감사 화면·정책 처리의 대상,
 *    공개 상태·사람 결정 없음, 주인 있는 것과 확신 0.95 아래 포함) 또는 보류 후보만(hold — 확신 문턱 이상·주인 없음·그 제품의 마지막 항목, 이미 보류된 것 포함).
 *    그 가운데 이 모델·이 판의 의견이 없는 것을 공개 중(보류 아님) → 보류 중, 각각 첫 감사의 확신 높은 것 → id 차례로 묻고(글이 적은 페이지는
 *    닫을 수 있는 것을 다 물은 뒤 같은 차례로), grok 옮겨 적기와 같은 쓰기
 *    (writeAuditSecondOpinions — 덮어쓰기·보류 다시 가르기·승인이면 풀기)로 출처 qwen-v2-auto 를 적는다. autoClose 면 같은 커밋에서 그 답으로 닫는다
 *    (audit-auto-close.ts — 승인은 유지, 주인 없는 것의 거절은 숨김, 글이 적은 페이지·엇갈림·그 밖은 열어 둠). 답으로 닫기 전에 받아 둔 이 판의 답(다시 묻지 않는다)은
 *    따라잡기(catchUpAutoClose)가 모델을 부르지 않고 틱마다 조금씩 그 답으로 닫는다. 아니면 거절은 쓸기가 다음 틱부터 분당 20건씩 건다
 *    (Qwen 거절은 카탈로그·디렉터리 같은 항목에서 세지 않는다).
 *    감사 모델이 같은 Qwen 이었던 항목은 묻지 않는다 — 같은 모델의 두 번째 의견은 뜻이 없다(답을 낸 심사자 ai_provider 가 qwen-direct 이거나,
 *    coalesce(ai_model, 그 감사가 시작할 때의 model)이 같은 모델 — 0112 전 답은 ai_model 이 비어 있고 시작 모델이 답했다).
 * 2. 공개분 2차 거르기(qwenAuto.publishedFilter, 기본 꺼짐): 공개분 2차가 사람 확인(needs_human)으로 넘긴 행 가운데 이 모델·이 판의 판단이 없는 것을
 *    묻는다. 승인이면 사람의 '유지'와 같은 길로 닫고(누가 qwen-v2-auto), 거절·판단 보류면 판단만 적어 사람 확인 목록 앞에 둔다.
 *    이 길로는 내리지도 숨기지도 않는다.
 *
 * 두 갈래가 번갈아 한 줄로 선다(갈래마다 perTick 까지). 새 호출은 STEP_MS 안에서만, 틱의 끝까지 15초(QWEN_AUTO_MIN_START_MS) 이상 남을 때만
 * 시작하고, 제한 시간은 min(45초, 남은 시간 − 저장 여유)다 — 줄인 제한 시간에 걸린 것(틱 끝)은 적지 않는다. 감사가 Qwen 직접 심사로 바뀌었으면(0112) 같은 서버를 감사 자리(AUDIT_QWEN_CONCURRENCY, 기본 2)가 틱 내내 쓰고
 * 이 단계는 2차 갈림 판가름과 나눠 쓰는 두 번째 자리 하나(withQwenSecondarySlot)로 30초만 쓴다 — gpu3090 동시 호출은 감사 자리 + 1 을
 * 넘지 않고(qwen-endpoint-backoff.ts), 감사가 먼저다. 누가 서버 탈을 만나든 모두 함께 물러난다. 모델 호출은 트랜잭션 밖이고, 쓰기는 한 건마다 DR writer fence → … → 작업 lease 의 한 커밋이다.
 * 서버 탈(qwen-endpoint-backoff.ts noteQwenCallFailure — 닿지 않음·5xx·404·401/403 은 바로, 진짜 시간 초과·429 는 부르는 쪽 모두를 통틀어
 * 성공 없이 세 번 잇달아)이면 이 틱의 나머지를 멈추고 함께 쓰는 물러나기(1분부터 두 배씩 15분까지)를 걸며 마지막 오류를 관측에 남긴다.
 * 항목만의 실패(형식 오류·400·입력 초과·원본 없음, 탈이 아닌 한 번의 진짜 시간 초과)는 그 항목을 두 번까지만 묻는다(관측의 failures).
 * 탈이 아닌 429 는 항목 탓이 아니라 세지 않고 다음 항목으로 간다. 이 단계는 잡을 실패시키지 않는다.
 */
export const QWEN_AUTO_OBSERVATION = "qwen-second-opinion";
export const QWEN_V2_AUTO_ACTOR = QWEN_V2_AUTO_SOURCE;
/** 새 호출을 시작하는 창 — 감사 묻기(틱 65초)와 나란히 돌아 틱(예산 70초)을 늘리지 않는다 */
const STEP_MS = 30_000;
/**
 * 한 호출의 상한 — 감사 Qwen 직접 심사와 같다(jobs/product-audit.ts QWEN_CALL_TIMEOUT_MS): 한 건만이면 2.5초지만 감사 자리 넷과 함께 뜨면
 * 한 건에 12초쯤(운영 실측 평균 11.8초·최대 19.8초, 2026-10-21)이라 20초는 짧았다
 */
export const QWEN_AUTO_CALL_TIMEOUT_MS = 45_000;
/** 새 호출을 시작할 수 있는 틱의 남은 시간 — 부하 중 p95 쯤. 더 짧으면 제한 시간을 그 안으로 줄인다 */
export const QWEN_AUTO_MIN_START_MS = 15_000;
const WRITE_MARGIN_MS = 2_000;
/** 이미 받은 답으로 닫는 따라잡기가 틱에서 쓰는 시간의 상한 — 모델을 부르지 않는다(보류 쓸기의 SWEEP_MS 와 같다) */
const CATCH_UP_MS = 3_000;
/** 항목만의 실패를 몇 번까지 다시 묻나 */
export const QWEN_AUTO_ITEM_ATTEMPTS = 2;
/** 관측에 남기는 항목 실패의 수 — 넘으면 오래된 것부터 버린다 */
const FAILURE_MEMORY = 500;

type Kind = "audit" | "published";
type AuditTarget = { kind: "audit"; key: string; itemId: number; productId: number; slug: string };
type PublishedTarget = { kind: "published"; key: string; id: number; slug: string; candidateId: number };
type Target = AuditTarget | PublishedTarget;

export type QwenAutoObservation = {
  model: string; promptVersion: string; lastRunAt: string | null; lastSuccessAt: string | null;
  lastError: { code: string; detail: string | null; target: Kind; at: string } | null;
  /** 항목만의 실패 — 키 a:<감사 항목 id>·p:<공개분 2차 행 id> */
  failures: Record<string, { code: string; count: number; at: string }>;
};

export type QwenAutoTally = {
  audit: { asked: number; approve: number; reject: number; needsReview: number; released: number; skipped: number;
    /** 답으로 닫은 것(audit-auto-close.ts) — 유지·숨김. caughtUp 은 그중 이미 받아 둔 답으로 닫은 것(모델을 부르지 않음) */
    autoKept: number; autoHeld: number; caughtUp: number;
    /** 답으로 닫지 않고 열어 둔 것 중 글이 적은 페이지(화면 판별 대기)·엇갈림(다른 모델이 반대) */
    leftThin: number; leftSplit: number };
  published: { asked: number; kept: number; noted: number; skipped: number };
  failed: number; endpointError: string | null;
};

const emptyTally = (): QwenAutoTally => ({ audit: { asked: 0, approve: 0, reject: 0, needsReview: 0, released: 0, skipped: 0, autoKept: 0, autoHeld: 0, caughtUp: 0,
  leftThin: 0, leftSplit: 0 },
  published: { asked: 0, kept: 0, noted: 0, skipped: 0 }, failed: 0, endpointError: null });

/** 앞의 게이트웨이 자리 표시('[gpu3090] ')를 뗀 소문자 모델 이름 — second-opinion-rules.ts sameOpinionModel 과 같다 */
const bareModel = (model: SQL) => sql`lower(regexp_replace(trim(${model}), '^\\[[^]]*\\]\\s*', ''))`;
const bareModelValue = (model: string) => model.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();

/** 지금(마지막) 감사 — 감사 화면·정책 처리가 보는 감사와 같다. 끝난 뒤에도 그 감사의 열린 거절을 묻는다 */
const latestCampaign = sql`(select max(${productAuditCampaigns.id}) from ${productAuditCampaigns})`;

/** 묻는 범위 — all: 지금 감사의 열린 AI 거절 전부(정책 처리의 대상과 같다), hold: 보류 후보(holdCandidate) */
function auditScope(scope: AuditOpinionScope, hold: Pick<AuditHoldSettings, "minConfidence">): SQL {
  return scope === "hold" ? holdCandidate("i", "p", hold.minConfidence)
    : sql`(i.product_id = p.id and ${openAuditRejectUniverse(latestCampaign)})`;
}

/**
 * 물을 감사 항목 — 범위(auditScope)에 들고, 이 모델·이 판의 의견이 없고, 감사 답을 낸 심사자·시도가 같은 모델이 아니며(같은 모델 규칙),
 * 수집 원본이 있다(loadAuditInput 이 입력을 만들 수 있다)
 */
function auditOpinionWanted(scope: AuditOpinionScope, hold: Pick<AuditHoldSettings, "minConfidence">, model: string, skip: readonly number[]): SQL {
  return sql`${auditScope(scope, hold)}
    and not exists (select 1 from ${productAuditSecondOpinions} o where o.item_id = i.id and o.model = ${model}
      and o.prompt_version = ${QWEN_V2_PROMPT_VERSION})
    and coalesce(i.ai_provider, '') <> ${QWEN_AUDIT_PROVIDER} and ${bareModel(auditItemModel("i"))} <> ${bareModelValue(model)}
    and not exists (select 1 from ${productAuditAttempts} a where a.item_id = i.id and a.outcome is not null
      and ${bareModel(sql`a.model`)} = ${bareModelValue(model)})
    and exists (select 1 from ${crawlCandidates} c join ${crawlDocuments} d on d.repo = c.repo where c.published_slug = p.slug)
    ${skip.length ? sql`and i.id not in (${sql.join(skip.map((id) => sql`${id}`), sql`, `)})` : sql``}`;
}

/**
 * 묻는 차례(2026-10-22 사용자 결정 "공개 먼저") — 지금 공개 목록에 떠 있는 것(보류 아님)을 첫 감사의 확신 높은 순으로, 그다음 보류 중인 것을
 * 같은 순으로 → id. 다만 글이 적은 페이지(audit-text-gate.ts — m1 의 답은 의견으로만 남고 아무것도 닫지 않는다)는 닫을 수 있는 것을 다 물은
 * 뒤에 같은 차례(공개 먼저·확신 높은 순)로 묻는다 — 닫지 못할 답에 자리를 먼저 쓰지 않게.
 * 한 틱에 limit(perTick) 건까지 — 공개분 2차 거르기와 번갈아 한 줄로 서고(interleave), 갈림 판가름·보류 재심사와는 두 번째 자리를 한 호출씩
 * 나눠 쓴다(이 차례는 감사 갈래 안의 차례라 다른 갈래의 몫은 그대로다)
 */
async function auditTargets(scope: AuditOpinionScope, hold: AuditHoldSettings, model: string, skip: readonly number[], limit: number): Promise<AuditTarget[]> {
  const rows = await db.execute<{ item_id: number; product_id: number; slug: string }>(sql`
    select i.id as item_id, p.id as product_id, p.slug from ${productAuditItems} i, ${products} p
     where ${auditOpinionWanted(scope, hold, model, skip)}
     order by ${thinPageTextSql(sql`p.id`)}, (p.audit_hold_at is not null), i.ai_confidence desc nulls last, i.id limit ${limit}`);
  return rows.map((row) => ({ kind: "audit", key: `a:${row.item_id}`, itemId: row.item_id, productId: row.product_id, slug: row.slug }));
}

/**
 * 물을 공개분 2차 행 — 사람 확인(needs_human)을 기다리고, 이 모델·이 판의 판단이 없다. 2차 표나 공개를 승인한 1차가 같은 모델이면 묻지 않는다
 * (같은 모델 규칙). 오래된 것부터
 */
function publishedOpinionWanted(model: string, skip: readonly number[]): SQL {
  const bare = bareModelValue(model);
  return sql`s.status = 'needs_human' and s.published_slug is not null
    and (s.auto_opinion is null or s.auto_opinion->>'model' is distinct from ${model}
      or s.auto_opinion->>'promptVersion' is distinct from ${QWEN_V2_PROMPT_VERSION})
    and ${bareModel(sql`coalesce(s.model, '')`)} <> ${bare} and ${bareModel(sql`coalesce(s.first_model, '')`)} <> ${bare}
    ${skip.length ? sql`and s.id not in (${sql.join(skip.map((id) => sql`${id}`), sql`, `)})` : sql``}`;
}

async function publishedTargets(model: string, skip: readonly number[], limit: number): Promise<PublishedTarget[]> {
  const rows = await db.execute<{ id: number; slug: string; candidate_id: number }>(sql`
    select s.id, s.published_slug as slug, s.candidate_id from ${secondReviews} s
     where ${publishedOpinionWanted(model, skip)} order by s.id limit ${limit}`);
  return rows.map((row) => ({ kind: "published", key: `p:${row.id}`, id: row.id, slug: row.slug, candidateId: row.candidate_id }));
}

/** 공개분 행의 입력 — 2차가 공개분을 볼 때와 같다(후보·문서·지금 설정, loadReviewInput). 후보가 내려갔거나 주소가 바뀌었으면 null */
async function publishedInput(target: PublishedTarget, settings: CrawlSettings): Promise<ReviewInput | null> {
  const [row] = await db.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(crawlCandidates.id, target.candidateId), eq(crawlCandidates.state, "published"), eq(crawlCandidates.publishedSlug, target.slug)))
    .limit(1);
  return row && row.candidate.productUrl === row.document.productUrl ? loadReviewInput(row.candidate, row.document, settings) : null;
}

function emptyObservation(model: string): QwenAutoObservation {
  return { model, promptVersion: QWEN_V2_PROMPT_VERSION, lastRunAt: null, lastSuccessAt: null, lastError: null, failures: {} };
}

/** 지금 모델·판의 관측 — 모델이나 판이 바뀌었으면 항목 실패는 버린다(새 글로 다시 묻는다) */
export async function readQwenAutoObservation(model: string): Promise<QwenAutoObservation> {
  const [row] = await db.select({ value: operationsObservations.value }).from(operationsObservations)
    .where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
  const value = row?.value as Partial<QwenAutoObservation> | undefined;
  if (!value || typeof value !== "object") return emptyObservation(model);
  const same = value.model === model && value.promptVersion === QWEN_V2_PROMPT_VERSION;
  return { ...emptyObservation(model), lastRunAt: value.lastRunAt ?? null, lastSuccessAt: value.lastSuccessAt ?? null,
    lastError: value.lastError ?? null, failures: same && value.failures && typeof value.failures === "object" ? value.failures : {} };
}

async function saveObservation(lease: JobLease, value: QwenAutoObservation): Promise<void> {
  const kept = Object.entries(value.failures).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, FAILURE_MEMORY);
  const next = { ...value, failures: Object.fromEntries(kept) };
  await withJobLeaseWrite(lease, async (tx) => {
    await tx.insert(operationsObservations).values({ key: QWEN_AUTO_OBSERVATION, value: next, observedAt: new Date() })
      .onConflictDoUpdate({ target: operationsObservations.key, set: { value: next, observedAt: new Date() } });
  });
}

/** 항목만의 실패로 더 묻지 않는 것 — prefix 는 a:(감사 항목)·p:(공개분 2차 행) */
function givenUp(observation: QwenAutoObservation, prefix: "a:" | "p:"): number[] {
  return Object.entries(observation.failures)
    .flatMap(([key, failure]) => key.startsWith(prefix) && failure.count >= QWEN_AUTO_ITEM_ATTEMPTS ? [Number(key.slice(prefix.length))] : [])
    .filter(Number.isSafeInteger);
}

/** 두 갈래를 번갈아 한 줄로 */
function interleave(left: Target[], right: Target[]): Target[] {
  const out: Target[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (index < left.length) out.push(left[index]);
    if (index < right.length) out.push(right[index]);
  }
  return out;
}

const autoOpinion = (review: QwenDirectReview, input: ReviewInput): SecondReviewAutoOpinion => ({
  by: QWEN_V2_AUTO_ACTOR, model: review.model, promptVersion: review.promptVersion, decision: review.outcome.decision,
  confidence: review.outcome.confidence ?? null, reason: review.outcome.reason?.trim().slice(0, 2_000) || null,
  inputHash: input.inputHash, at: new Date().toISOString(),
});

/**
 * 한 틱의 Qwen-v2 단계. 잡을 실패시키지 않는다 — 뜻밖의 오류(DB·lease 잃음·fence)도 남기고 돌아온다: lease 를 잃었거나 fence 됐으면
 * 감사 묻기의 쓰기와 러너의 ACK 가 같은 까닭으로 멈춘다.
 */
export async function runQwenSecondOpinions(ctx: JobContext<null>, settings: CrawlSettings): Promise<QwenAutoTally> {
  const tally = emptyTally();
  try {
    await runStep(ctx, settings, tally);
  } catch (error) {
    const code = error instanceof Error ? error.name === "Error" ? error.message.slice(0, 80) : error.name : "unknown";
    logger.error("qwen_second_opinion.failed", { code });
    ctx.log("qwen_second_opinion.failed", { failed: 1 });
  }
  return tally;
}

async function runStep(ctx: JobContext<null>, settings: CrawlSettings, tally: QwenAutoTally): Promise<void> {
  const { auditSecondOpinion: audit, publishedFilter: published } = settings.qwenAuto;
  const lease = ctx.lease;
  // 수집 스위치는 비상 정지다 — 모델을 부르는 다른 잡처럼 여기서도 멈춘다
  if (!lease || !settings.enabled || (!audit.enabled && !published.enabled)) return;
  // 감사의 Qwen 직접 심사가 서버 탈로 물러나는 중이면 같은 서버를 부르지 않는다 — 감사가 먼저다
  if (qwenEndpointBackingOff()) {
    ctx.log("qwen_second_opinion.backoff", { skipped: true });
    return;
  }
  const config = qwenDirectConfig();
  const observation = await readQwenAutoObservation(config?.model ?? "");
  const now = () => new Date().toISOString();
  if (!config) {
    tally.endpointError = "qwen_not_configured";
    await saveObservation(lease, { ...observation, lastRunAt: now(), lastError: { code: "qwen_not_configured", detail: null,
      target: audit.enabled ? "audit" : "published", at: now() } });
    return;
  }
  // 답으로 닫기 전에 받아 둔 이 판의 답(배포 전·꺼 두었던 동안)으로 먼저 닫는다 — 모델을 부르지 않고 시작 창(STEP_MS) 밖에서
  // 따라잡기의 뜻밖의 오류는 남기고 묻기로 넘어간다 — 따라잡기가 묻기를 막지 않게. lease 잃음·fence 는 묻기의 쓰기도 같은 까닭으로 멈춘다
  if (audit.enabled && audit.autoClose) {
    try {
      await catchUpAutoClose(ctx, lease, settings, config.model, tally);
    } catch (error) {
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
      logger.error("qwen_second_opinion.catch_up_failed", { code: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
    }
  }
  const startedAt = Date.now();
  const given = (prefix: "a:" | "p:") => givenUp(observation, prefix);
  const queue = interleave(
    published.enabled ? await publishedTargets(config.model, given("p:"), published.perTick) : [],
    audit.enabled ? await auditTargets(audit.scope, settings.auditHold, config.model, given("a:"), audit.perTick) : [],
  );
  if (!queue.length) return;
  // 새 호출은 시작 창(STEP_MS) 안에서 틱 끝까지 15초 이상 남을 때만, 그리고 누가 서버 탈을 만나 함께 쓰는 물러나기가 걸리면 곧바로 멈춘다.
  // 제한 시간은 min(45초, 남은 시간 − 저장 여유) — 줄인 제한 시간에 걸린 것(틱 끝)은 서버 탈도 항목의 실패도 아니다
  const left = () => (ctx.deadlineAt ?? Infinity) - Date.now();
  const canStart = () => !ctx.signal?.aborted && ctx.hasBudget() && Date.now() - startedAt < STEP_MS && !qwenEndpointBackingOff()
    && left() >= QWEN_AUTO_MIN_START_MS;
  const failItem = (target: Target, code: string) => {
    tally.failed += 1;
    observation.failures[target.key] = { code, count: (observation.failures[target.key]?.count ?? 0) + 1, at: now() };
  };
  let ran = false;
  for (const target of queue) {
    if (!canStart()) break;
    // 입력을 만들다 실패한 항목(입력 상한 초과 등)은 그 항목의 실패로 적고 넘어간다 — 한 항목이 단계를 막거나 틱마다 같은 자리에서 멈추지 않게
    let input: ReviewInput | null;
    try {
      input = target.kind === "audit" ? await loadAuditInput(target.slug, settings) : await publishedInput(target, settings);
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]{3,60}$/.test(error.message) ? error.message : "input_error";
      failItem(target, code);
      observation.lastError = { code, detail: null, target: target.kind, at: now() };
      ran = true;
      continue;
    }
    if (!input) { failItem(target, "no_source"); ran = true; continue; }
    if (!canStart()) break;
    ran = true;
    let review: QwenDirectReview | null;
    let callStartedAt = 0;
    let shrunk = false;
    try {
      // 두 번째 자리(갈림 판가름과 나눠 쓴다)를 얻은 뒤 남은 시간·물러나기를 다시 본다 — 기다리는 동안 바뀐다
      review = await withQwenSecondarySlot(async () => {
        if (!canStart()) return null;
        const timeoutMs = Math.min(QWEN_AUTO_CALL_TIMEOUT_MS, left() - WRITE_MARGIN_MS);
        shrunk = timeoutMs < QWEN_AUTO_CALL_TIMEOUT_MS;
        callStartedAt = Date.now();
        return reviewWithQwenDirect(input, { timeoutMs, signal: ctx.signal });
      });
    } catch (error) {
      if (!(error instanceof QwenDirectError)) throw error;
      if (error.code === "qwen_cancelled") break;
      // 줄인 제한 시간(틱 끝)에 걸렸다 — 아무것도 적지 않고 멈춘다
      if (error.code === "qwen_timeout" && shrunk) break;
      const { outage } = await noteQwenCallFailure(error.code);
      observation.lastError = { code: error.code, detail: error.detail, target: target.kind, at: now() };
      if (outage) {
        // 서버 탈 — 이 틱의 나머지는 부르지 않고 gpu3090 을 부르는 모두가 물러난다. 항목에는 아무것도 적지 않는다
        tally.endpointError = error.code;
        break;
      }
      // 탈이 아닌 붐빔 — 429 는 항목 탓이 아니라 세지 않고, 한 번의 진짜 시간 초과는 그 항목의 실패로 센다
      if (error.code !== "qwen_http_429") failItem(target, error.code);
      continue;
    }
    if (!review) break;
    // 다른 쪽(감사의 Qwen 직접 심사 등)이 탈을 적기 전에 띄운 호출의 답은 그 물러나기를 풀지 않는다 — 다음 항목은 canStart 가 막는다
    await noteQwenEndpointSuccess(callStartedAt);
    delete observation.failures[target.key];
    observation.lastSuccessAt = now();
    const written = target.kind === "audit" ? await writeAudit(target, review, input, lease, tally, audit.autoClose)
      : await writePublished(target, review, input, lease, tally);
    // 쓰는 순간 그 단계가 꺼져 있었다 — 이 틱의 나머지는 부르지 않는다
    if (written === "switched_off") break;
    // 그 사이 사람이 정했거나 내려갔다 — 다시 묻지 않게 항목 실패로 센다
    if (written === "not_open") failItem(target, "not_open");
  }
  if (!ran) return;
  ctx.log("qwen_second_opinion.ran", { auditAsked: tally.audit.asked, auditReleased: tally.audit.released, auditKept: tally.audit.autoKept,
    auditHeld: tally.audit.autoHeld, auditCaughtUp: tally.audit.caughtUp, auditLeftThin: tally.audit.leftThin, auditLeftSplit: tally.audit.leftSplit,
    publishedAsked: tally.published.asked,
    publishedKept: tally.published.kept, failed: tally.failed, endpointError: tally.endpointError !== null });
  await saveObservation(lease, { ...observation, lastRunAt: now() });
}

/**
 * 한 답을 적는다 — close(이 틱이 읽은 autoClose)면 같은 트랜잭션에서 그 답으로 닫는다. 스위치는 쓰는 트랜잭션이 잠근 설정 행에서 다시 본다
 * (이 틱의 값이 꺼짐이면 세대·항목을 잡지 않고 옛 길로만 적는다 — 그 사이 켠 것은 다음 틱부터)
 */
async function writeAudit(target: AuditTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease, tally: QwenAutoTally, close: boolean):
  Promise<"written" | "not_open" | "switched_off"> {
  const { outcome } = review;
  const result = await writeAuditSecondOpinions(db, [{ itemId: target.itemId, productId: target.productId, model: review.model,
    decision: outcome.decision, confidence: outcome.confidence ?? null, reason: outcome.reason?.trim().slice(0, 2_000) || null,
    inputHash: input.inputHash, promptVersion: review.promptVersion }], { dryRun: false, source: QWEN_V2_AUTO_SOURCE, lease,
    auto: { actor: QWEN_V2_AUTO_ACTOR, close } });
  tally.audit.asked += 1;
  if (result.skipped.switched_off) { tally.audit.skipped += 1; return "switched_off"; }
  if (result.inserted + result.updated === 0) { tally.audit.skipped += 1; return "not_open"; }
  tally.audit.released += result.released;
  tally.audit.autoKept += result.autoClose?.kept ?? 0;
  tally.audit.autoHeld += result.autoClose?.held ?? 0;
  tally.audit.leftThin += result.autoClose?.left.thin_text ?? 0;
  tally.audit.leftSplit += result.autoClose?.left.split ?? 0;
  if (outcome.decision === "approve") tally.audit.approve += 1;
  else if (outcome.decision === "reject") tally.audit.reject += 1;
  else tally.audit.needsReview += 1;
  return "written";
}

/**
 * 이미 받은 답으로 닫는 따라잡기 — 이 모델·이 판의 자동 의견이 있어 다시 묻지 않는 열린 거절 가운데(묻는 범위 그대로) 그 답으로 닫을 수 있는 것
 * (autoClosableSql — autoCloseVerdict 와 같은 규칙)을 오래된 것부터 닫는다. 답으로 닫기 전(2026-10-22 배포 전·스위치를 꺼 두었던 동안)에 받은 답이다.
 * 운영자가 되돌린 항목(정책 실행 항목이 되돌림·되돌리지 못함)과 자동 실행이 이미 손댄 항목은 다시 고르지 않는다.
 * 한 틱에 보류 쓸기와 같은 수(지난 60초에 적힌 보류·풀기 지우기 줄만큼 뺀다)와 CATCH_UP_MS 안에서만. 제품 하나가 한 트랜잭션이고 잠금은
 * 의견을 적는 쓰기와 같은 차례다: DR writer fence → stage → 제품 세대 → 감사 항목 → 설정 행 → 자동 실행 행 → 작업 lease
 */
async function catchUpAutoClose(ctx: JobContext<null>, lease: JobLease, settings: CrawlSettings, model: string, tally: QwenAutoTally): Promise<void> {
  const startedAt = Date.now();
  const [recent] = await db.select({ count: sql<number>`count(*)::int` }).from(cdnPurges).where(and(
    sql`${cdnPurges.reason} in (${AUDIT_HOLD_PURGE}, ${AUDIT_RELEASE_PURGE})`, sql`${cdnPurges.createdAt} > now() - interval '60 seconds'`));
  const room = Math.max(0, AUDIT_HOLD_SWEEP_BATCH - (recent?.count ?? 0));
  if (room === 0) return;
  const step = settings.qwenAuto.auditSecondOpinion;
  const rows = await db.execute<{ item_id: number; product_id: number; slug: string; model: string; decision: string; confidence: number | null;
    prompt_version: string | null }>(sql`
    select i.id as item_id, p.id as product_id, p.slug, o.model, o.decision, o.confidence, o.prompt_version
      from ${productAuditItems} i, ${products} p, ${productAuditSecondOpinions} o
     where ${auditScope(step.scope, settings.auditHold)} and o.item_id = i.id and o.source = ${QWEN_V2_AUTO_SOURCE} and o.model = ${model}
       and o.prompt_version = ${QWEN_V2_PROMPT_VERSION} and ${autoClosableSql(settings.auditHold.enabled)}
       -- 운영자가 되돌린 것(자동 실행이든 정책 실행이든)은 다시 닫지 않는다 — 되돌림은 '사람이 본다'는 뜻이다. 자동 실행이 이미 손댄 항목도
       -- 다시 고르지 않는다(같은 날 같은 실행에 두 번 적을 수 없어 틱마다 같은 자리에 걸린다)
       and not exists (select 1 from ${productAuditPolicyRunItems} ri join ${productAuditPolicyRuns} r on r.id = ri.run_id where ri.item_id = i.id
         and (ri.state in ('undone', 'undo_blocked') or (r.options->'auto') is not null))
     order by i.id limit ${room}`);
  for (const row of rows) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() - startedAt > CATCH_UP_MS) break;
    // 한 항목의 뜻밖의 오류(교착 등)는 남기고 다음 항목으로 — 한 항목이 따라잡기를 막지 않게. lease 잃음·fence 는 모든 쓰기가 같은 까닭으로 멈춘다
    const outcome = await withJobLeaseWrite(lease, async (tx): Promise<AutoCloseResult | null> => {
      await lockPipelineInputStages(tx);
      if (!(await lockProductGeneration(tx, row.product_id, row.slug))) return null;
      await tx.select({ id: productAuditItems.id }).from(productAuditItems).where(eq(productAuditItems.id, row.item_id)).for("update");
      const locked = await lockedSettings(tx);
      // 쓰는 순간 그 단계가 꺼졌으면 닫지 않는다(답으로 닫기는 autoCloseOpinion 이 잠근 값으로 본다)
      const result = locked.qwenAuto.auditSecondOpinion.enabled ? await autoCloseOpinion(tx, { itemId: row.item_id, productId: row.product_id,
        slug: row.slug, model: row.model, decision: row.decision, confidence: row.confidence, promptVersion: row.prompt_version,
        actor: QWEN_V2_AUTO_ACTOR, settings: locked }) : null;
      await assertJobLeaseAtWallTime(tx, lease);
      return result;
    }).catch((error: unknown) => {
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
      logger.error("qwen_second_opinion.catch_up_item_failed", { item: row.item_id, code: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
      return null;
    });
    if (outcome?.action === "kept") tally.audit.autoKept += 1;
    else if (outcome?.action === "held") tally.audit.autoHeld += 1;
    if (outcome?.action) tally.audit.caughtUp += 1;
  }
  if (tally.audit.caughtUp) ctx.log("qwen_second_opinion.caught_up", { caughtUp: tally.audit.caughtUp, candidates: rows.length });
}

async function writePublished(target: PublishedTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease,
  tally: QwenAutoTally): Promise<PublishedAutoResult> {
  const opinion = autoOpinion(review, input);
  tally.published.asked += 1;
  const written = await applyPublishedAutoOpinion({ id: target.id, slug: target.slug, autoOpinion: opinion, lease });
  if (written === "kept") tally.published.kept += 1;
  else if (written === "noted") tally.published.noted += 1;
  else tally.published.skipped += 1;
  return written;
}

export type QwenAutoStatus = {
  model: string | null; url: string | null; promptVersion: string;
  audit: { enabled: boolean; perTick: number; lastHour: number; lastDay: number; remaining: number; scope: AuditOpinionScope; autoClose: boolean };
  /** 오늘(UTC) 답으로 닫은 수(audit-auto-close.ts) — 유지·숨김(되돌린 것 포함)·되돌린 수, 그 확신 하한 */
  autoClose: AutoCloseToday & { minConfidence: number };
  /** 답으로 닫지 않고 열어 둔 무리 — 화면 판별 대기(글이 적은 페이지)·엇갈림(audit-screen-review.ts). 못 읽으면 null */
  screen: ScreenReviewCounts | null;
  published: { enabled: boolean; perTick: number; lastHour: number; lastDay: number; keptHour: number; keptDay: number; remaining: number };
  lastRunAt: string | null; lastSuccessAt: string | null; lastError: QwenAutoObservation["lastError"];
  /** 항목만의 실패로 더 묻지 않는 수 */
  givenUp: number;
  /** gpu3090 을 부르는 모두가 물러나는 중이면 그 끝과 까닭(qwen-endpoint-backoff.ts — Qwen 직접 감사도 이 동안 묻지 않는다) */
  endpointBackoff: { until: string; code: string | null; failures: number } | null;
};

/** 감사 화면의 Qwen-v2 단계 상태 — 켬/끔, 지난 1시간·24시간에 적은 수, 남은 것, 마지막 오류 */
export async function qwenSecondOpinionStatus(settings: Pick<CrawlSettings, "auditHold" | "qwenAuto">): Promise<QwenAutoStatus> {
  const hold = settings.auditHold;
  const steps = settings.qwenAuto;
  const config = qwenDirectConfig();
  const model = config?.model ?? "";
  const observation = await readQwenAutoObservation(model);
  const given = (prefix: "a:" | "p:") => givenUp(observation, prefix);
  const [[auditRow], [publishedRow], [auditLeft], [publishedLeft], backoff, today, screen] = await Promise.all([
    db.select({
      hour: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '1 hour')::int`,
      day: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '24 hours')::int`,
    }).from(productAuditSecondOpinions).where(and(eq(productAuditSecondOpinions.source, QWEN_V2_AUTO_SOURCE),
      eq(productAuditSecondOpinions.model, model), eq(productAuditSecondOpinions.promptVersion, QWEN_V2_PROMPT_VERSION))),
    db.select({
      hour: sql<number>`count(*) filter (where (${secondReviews.autoOpinion}->>'at')::timestamptz > now() - interval '1 hour')::int`,
      day: sql<number>`count(*) filter (where (${secondReviews.autoOpinion}->>'at')::timestamptz > now() - interval '24 hours')::int`,
      keptHour: sql<number>`count(*) filter (where ${secondReviews.resolvedBy} = ${QWEN_V2_AUTO_ACTOR}
        and ${secondReviews.resolvedAt} > now() - interval '1 hour')::int`,
      keptDay: sql<number>`count(*) filter (where ${secondReviews.resolvedBy} = ${QWEN_V2_AUTO_ACTOR}
        and ${secondReviews.resolvedAt} > now() - interval '24 hours')::int`,
    }).from(secondReviews).where(and(sql`${secondReviews.autoOpinion} is not null`, sql`${secondReviews.autoOpinion}->>'model' = ${model}`,
      sql`${secondReviews.autoOpinion}->>'promptVersion' = ${QWEN_V2_PROMPT_VERSION}`)),
    db.execute<{ count: number }>(sql`select count(*)::int as count from ${productAuditItems} i, ${products} p
      where ${auditOpinionWanted(steps.auditSecondOpinion.scope, hold, model, given("a:"))}`),
    db.execute<{ count: number }>(sql`select count(*)::int as count from ${secondReviews} s where ${publishedOpinionWanted(model, given("p:"))}`),
    readQwenEndpointBackoff().catch(() => null),
    // 일지(0116)를 못 읽어도 상태 칸은 그린다
    autoCloseToday().catch(() => ({ day: utcDay(), kept: 0, held: 0, undone: 0 })),
    screenReviewCounts().catch(() => null),
  ]);
  return {
    model: config?.model ?? null, url: config?.baseUrl ?? null, promptVersion: QWEN_V2_PROMPT_VERSION,
    audit: { enabled: steps.auditSecondOpinion.enabled, perTick: steps.auditSecondOpinion.perTick, lastHour: auditRow?.hour ?? 0, lastDay: auditRow?.day ?? 0,
      remaining: auditLeft?.count ?? 0, scope: steps.auditSecondOpinion.scope, autoClose: steps.auditSecondOpinion.autoClose },
    autoClose: { ...today, minConfidence: AUTO_CLOSE_MIN_CONFIDENCE }, screen,
    published: { enabled: steps.publishedFilter.enabled, perTick: steps.publishedFilter.perTick, lastHour: publishedRow?.hour ?? 0,
      lastDay: publishedRow?.day ?? 0, keptHour: publishedRow?.keptHour ?? 0, keptDay: publishedRow?.keptDay ?? 0, remaining: publishedLeft?.count ?? 0 },
    lastRunAt: observation.lastRunAt, lastSuccessAt: observation.lastSuccessAt, lastError: observation.lastError,
    givenUp: Object.values(observation.failures).filter((failure) => failure.count >= QWEN_AUTO_ITEM_ATTEMPTS).length,
    endpointBackoff: endpointBackoffActive(backoff) ? { until: backoff.retryAt, code: backoff.lastError, failures: backoff.failures } : null,
  };
}
