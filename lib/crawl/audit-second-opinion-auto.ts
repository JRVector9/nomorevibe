import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, operationsObservations, productAuditAttempts, productAuditItems, productAuditSecondOpinions,
  products, secondReviews, type SecondReviewAutoOpinion } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import type { ReviewInput } from "./agent-review-contract";
import { loadReviewInput } from "./agent-review-repository";
import { writeAuditSecondOpinions } from "./audit-second-opinion-import";
import { holdCandidate } from "./product-audit-hold";
import { loadAuditInput } from "./product-audit";
import { decidePublishedSecondReview, notePublishedSecondReviewOpinion } from "./published-second-review";
import { QWEN_V2_AUTO_SOURCE, QWEN_V2_PROMPT_VERSION, QwenDirectError, qwenDirectConfig, qwenEndpointFailure, reviewWithQwenDirect,
  type QwenDirectReview } from "./qwen-direct-review";
import type { AuditHoldSettings } from "./settings";
import type { CrawlSettings } from "./settings-schema";

/**
 * Qwen-v2 자동 단계(2026-10-21) — 감사 잡(jobs/product-audit.ts)이 틱마다 감사 묻기와 나란히 한 번 돈다. gpu3090 의 Qwen 을 게이트웨이 밖에서
 * 바로 부르므로(qwen-direct-review.ts) 게이트웨이 자리·공통 슬롯을 쓰지 않는다(M3 DeepSeek 과 같다). 한 번에 한 호출이다.
 *
 * 1. 감사 두 번째 의견(auditHold.autoSecondOpinion): 보류 후보(확신 문턱 이상·주인 없음·사람 결정 없음·그 제품의 마지막 항목, 이미 보류된 것 포함)
 *    가운데 이 모델·이 판의 의견이 없는 것을 묻고, grok 옮겨 적기와 같은 쓰기(writeAuditSecondOpinions — 덮어쓰기·보류 다시 가르기·승인이면 풀기)로
 *    출처 qwen-v2-auto 를 적는다. 거절은 쓸기가 다음 틱부터 분당 20건씩 건다(Qwen 거절은 카탈로그·디렉터리 같은 항목에서 세지 않는다).
 *    감사 모델이 같은 Qwen 이었던 항목은 묻지 않는다 — 같은 모델의 두 번째 의견은 뜻이 없다.
 * 2. 공개분 2차 거르기(auditHold.publishedFilter): 공개분 2차가 사람 확인(needs_human)으로 넘긴 행 가운데 이 모델·이 판의 판단이 없는 것을
 *    묻는다. 승인이면 사람의 '유지'와 같은 길로 닫고(누가 qwen-v2-auto), 거절·판단 보류면 판단만 적어 사람 확인 목록 앞에 둔다.
 *    이 길로는 내리지도 숨기지도 않는다.
 *
 * 두 갈래가 번갈아 한 줄로 선다(갈래마다 perTick 까지). 새 호출은 STEP_MS 안에서만 시작하고, 틱의 끝까지 호출 하나(CALL_TIMEOUT_MS)와
 * 기록 여유가 남아야 한다. 모델 호출은 트랜잭션 밖이고, 쓰기는 한 건마다 DR writer fence → … → 작업 lease 의 한 커밋이다.
 * 부르는 곳의 탈(닿지 않음·시간 초과·5xx·404·401/403·429)이면 이 틱의 나머지를 멈추고(다음 틱에 다시) 마지막 오류를 관측에 남긴다.
 * 항목만의 실패(형식 오류·400·입력 초과·원본 없음)는 그 항목을 두 번까지만 묻는다(관측의 failures). 이 단계는 잡을 실패시키지 않는다.
 */
export const QWEN_AUTO_OBSERVATION = "qwen-second-opinion";
export const QWEN_V2_AUTO_ACTOR = QWEN_V2_AUTO_SOURCE;
/** 새 호출을 시작하는 창 — 감사 묻기(틱 65초)와 나란히 돌아 틱(예산 70초)을 늘리지 않는다 */
const STEP_MS = 30_000;
/** 한 호출의 상한 — 실측 2.2~4.7초(2026-10-21, 50건). 이보다 길면 서버가 붐비거나 멈춘 것이다 */
export const QWEN_AUTO_CALL_TIMEOUT_MS = 20_000;
const WRITE_MARGIN_MS = 2_000;
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
  audit: { asked: number; approve: number; reject: number; needsReview: number; released: number; skipped: number };
  published: { asked: number; kept: number; noted: number; skipped: number };
  failed: number; endpointError: string | null;
};

const emptyTally = (): QwenAutoTally => ({ audit: { asked: 0, approve: 0, reject: 0, needsReview: 0, released: 0, skipped: 0 },
  published: { asked: 0, kept: 0, noted: 0, skipped: 0 }, failed: 0, endpointError: null });

/** 앞의 게이트웨이 자리 표시('[gpu3090] ')를 뗀 소문자 모델 이름 — second-opinion-rules.ts sameOpinionModel 과 같다 */
const bareModel = (model: SQL) => sql`lower(regexp_replace(trim(${model}), '^\\[[^]]*\\]\\s*', ''))`;
const bareModelValue = (model: string) => model.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();

/**
 * 물을 감사 항목 — 보류 후보(holdCandidate)이고, 이 모델·이 판의 의견이 없고, 감사 답을 낸 시도가 같은 모델이 아니며(같은 모델 규칙),
 * 수집 원본이 있다(loadAuditInput 이 입력을 만들 수 있다). 지금 보류의 까닭인 항목 먼저 — 승인이면 목록에 돌아온다 — 그다음 오래된 것부터
 */
function auditOpinionWanted(hold: Pick<AuditHoldSettings, "minConfidence">, model: string, skip: readonly number[]): SQL {
  return sql`${holdCandidate("i", "p", hold.minConfidence)}
    and not exists (select 1 from ${productAuditSecondOpinions} o where o.item_id = i.id and o.model = ${model}
      and o.prompt_version = ${QWEN_V2_PROMPT_VERSION})
    and not exists (select 1 from ${productAuditAttempts} a where a.item_id = i.id and a.outcome is not null
      and ${bareModel(sql`a.model`)} = ${bareModelValue(model)})
    and exists (select 1 from ${crawlCandidates} c join ${crawlDocuments} d on d.repo = c.repo where c.published_slug = p.slug)
    ${skip.length ? sql`and i.id not in (${sql.join(skip.map((id) => sql`${id}`), sql`, `)})` : sql``}`;
}

async function auditTargets(hold: AuditHoldSettings, model: string, skip: readonly number[], limit: number): Promise<AuditTarget[]> {
  const rows = await db.execute<{ item_id: number; product_id: number; slug: string }>(sql`
    select i.id as item_id, p.id as product_id, p.slug from ${productAuditItems} i, ${products} p
     where ${auditOpinionWanted(hold, model, skip)}
     order by coalesce(p.audit_hold_item_id = i.id, false) desc, i.id limit ${limit}`);
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
  const { autoSecondOpinion: audit, publishedFilter: published } = settings.auditHold;
  const lease = ctx.lease;
  // 수집 스위치는 비상 정지다 — 모델을 부르는 다른 잡처럼 여기서도 멈춘다
  if (!lease || !settings.enabled || (!audit.enabled && !published.enabled)) return;
  const startedAt = Date.now();
  const config = qwenDirectConfig();
  const observation = await readQwenAutoObservation(config?.model ?? "");
  const now = () => new Date().toISOString();
  if (!config) {
    tally.endpointError = "qwen_not_configured";
    await saveObservation(lease, { ...observation, lastRunAt: now(), lastError: { code: "qwen_not_configured", detail: null,
      target: audit.enabled ? "audit" : "published", at: now() } });
    return;
  }
  const given = (prefix: "a:" | "p:") => givenUp(observation, prefix);
  const queue = interleave(
    published.enabled ? await publishedTargets(config.model, given("p:"), published.perTick) : [],
    audit.enabled ? await auditTargets(settings.auditHold, config.model, given("a:"), audit.perTick) : [],
  );
  if (!queue.length) return;
  const canStart = () => !ctx.signal?.aborted && ctx.hasBudget() && Date.now() - startedAt < STEP_MS
    && (ctx.deadlineAt === undefined || ctx.deadlineAt - Date.now() >= QWEN_AUTO_CALL_TIMEOUT_MS + WRITE_MARGIN_MS);
  const failItem = (target: Target, code: string) => {
    tally.failed += 1;
    observation.failures[target.key] = { code, count: (observation.failures[target.key]?.count ?? 0) + 1, at: now() };
  };
  let ran = false;
  for (const target of queue) {
    if (!canStart()) break;
    const input = target.kind === "audit" ? await loadAuditInput(target.slug, settings) : await publishedInput(target, settings);
    if (!input) { failItem(target, "no_source"); ran = true; continue; }
    if (!canStart()) break;
    ran = true;
    let review: QwenDirectReview;
    try {
      review = await reviewWithQwenDirect(input, { timeoutMs: QWEN_AUTO_CALL_TIMEOUT_MS, signal: ctx.signal });
    } catch (error) {
      if (!(error instanceof QwenDirectError)) throw error;
      if (error.code === "qwen_cancelled") break;
      if (qwenEndpointFailure(error.code)) {
        // 부르는 곳의 탈 — 이 틱의 나머지는 부르지 않는다. 항목에는 아무것도 적지 않는다
        tally.endpointError = error.code;
        observation.lastError = { code: error.code, detail: error.detail, target: target.kind, at: now() };
        break;
      }
      failItem(target, error.code);
      observation.lastError = { code: error.code, detail: error.detail, target: target.kind, at: now() };
      continue;
    }
    delete observation.failures[target.key];
    observation.lastSuccessAt = now();
    if (target.kind === "audit") await writeAudit(target, review, input, lease, tally);
    else await writePublished(target, review, input, lease, tally);
  }
  if (!ran) return;
  ctx.log("qwen_second_opinion.ran", { auditAsked: tally.audit.asked, auditReleased: tally.audit.released, publishedAsked: tally.published.asked,
    publishedKept: tally.published.kept, failed: tally.failed, endpointError: tally.endpointError !== null });
  await saveObservation(lease, { ...observation, lastRunAt: now() });
}

async function writeAudit(target: AuditTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease, tally: QwenAutoTally): Promise<void> {
  const { outcome } = review;
  const result = await writeAuditSecondOpinions(db, [{ itemId: target.itemId, productId: target.productId, model: review.model,
    decision: outcome.decision, confidence: outcome.confidence ?? null, reason: outcome.reason?.trim().slice(0, 2_000) || null,
    inputHash: input.inputHash, promptVersion: review.promptVersion }], { dryRun: false, source: QWEN_V2_AUTO_SOURCE, lease });
  tally.audit.asked += 1;
  if (result.inserted + result.updated === 0) { tally.audit.skipped += 1; return; }
  tally.audit.released += result.released;
  if (outcome.decision === "approve") tally.audit.approve += 1;
  else if (outcome.decision === "reject") tally.audit.reject += 1;
  else tally.audit.needsReview += 1;
}

async function writePublished(target: PublishedTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease,
  tally: QwenAutoTally): Promise<void> {
  const opinion = autoOpinion(review, input);
  tally.published.asked += 1;
  const written = opinion.decision === "approve"
    ? await decidePublishedSecondReview({ id: target.id, slug: target.slug, decision: "keep", actor: QWEN_V2_AUTO_ACTOR, autoOpinion: opinion, lease })
    : await notePublishedSecondReviewOpinion({ id: target.id, slug: target.slug, autoOpinion: opinion, lease });
  if (!written) tally.published.skipped += 1;
  else if (opinion.decision === "approve") tally.published.kept += 1;
  else tally.published.noted += 1;
}

export type QwenAutoStatus = {
  model: string | null; url: string | null; promptVersion: string;
  audit: { enabled: boolean; perTick: number; lastHour: number; lastDay: number; remaining: number };
  published: { enabled: boolean; perTick: number; lastHour: number; lastDay: number; keptHour: number; keptDay: number; remaining: number };
  lastRunAt: string | null; lastSuccessAt: string | null; lastError: QwenAutoObservation["lastError"];
  /** 항목만의 실패로 더 묻지 않는 수 */
  givenUp: number;
};

/** 감사 화면의 Qwen-v2 단계 상태 — 켬/끔, 지난 1시간·24시간에 적은 수, 남은 것, 마지막 오류 */
export async function qwenSecondOpinionStatus(hold: AuditHoldSettings): Promise<QwenAutoStatus> {
  const config = qwenDirectConfig();
  const model = config?.model ?? "";
  const observation = await readQwenAutoObservation(model);
  const given = (prefix: "a:" | "p:") => givenUp(observation, prefix);
  const [[auditRow], [publishedRow], [auditLeft], [publishedLeft]] = await Promise.all([
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
      where ${auditOpinionWanted(hold, model, given("a:"))}`),
    db.execute<{ count: number }>(sql`select count(*)::int as count from ${secondReviews} s where ${publishedOpinionWanted(model, given("p:"))}`),
  ]);
  return {
    model: config?.model ?? null, url: config?.baseUrl ?? null, promptVersion: QWEN_V2_PROMPT_VERSION,
    audit: { enabled: hold.autoSecondOpinion.enabled, perTick: hold.autoSecondOpinion.perTick, lastHour: auditRow?.hour ?? 0, lastDay: auditRow?.day ?? 0,
      remaining: auditLeft?.count ?? 0 },
    published: { enabled: hold.publishedFilter.enabled, perTick: hold.publishedFilter.perTick, lastHour: publishedRow?.hour ?? 0,
      lastDay: publishedRow?.day ?? 0, keptHour: publishedRow?.keptHour ?? 0, keptDay: publishedRow?.keptDay ?? 0, remaining: publishedLeft?.count ?? 0 },
    lastRunAt: observation.lastRunAt, lastSuccessAt: observation.lastSuccessAt, lastError: observation.lastError,
    givenUp: Object.values(observation.failures).filter((failure) => failure.count >= QWEN_AUTO_ITEM_ATTEMPTS).length,
  };
}
