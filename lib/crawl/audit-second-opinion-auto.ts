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
import { auditItemModel, holdCandidate } from "./product-audit-hold";
import { QWEN_AUDIT_PROVIDER } from "./product-audit-reviewer";
import { endpointBackoffActive, noteQwenCallFailure, noteQwenEndpointSuccess, qwenEndpointBackingOff, readQwenEndpointBackoff,
  withQwenSecondarySlot } from "./qwen-endpoint-backoff";
import { loadAuditInput } from "./product-audit";
import { applyPublishedAutoOpinion, type PublishedAutoResult } from "./published-second-review";
import { QWEN_V2_AUTO_SOURCE, QWEN_V2_PROMPT_VERSION, QwenDirectError, qwenDirectConfig, reviewWithQwenDirect,
  type QwenDirectReview } from "./qwen-direct-review";
import type { AuditHoldSettings } from "./settings";
import type { CrawlSettings } from "./settings-schema";

/**
 * Qwen-v2 자동 단계(2026-10-21) — 감사 잡(jobs/product-audit.ts)이 틱마다 감사 묻기와 나란히 한 번 돈다. gpu3090 의 Qwen 을 게이트웨이 밖에서
 * 바로 부르므로(qwen-direct-review.ts) 게이트웨이 자리·공통 슬롯을 쓰지 않는다(M3 DeepSeek 과 같다). 한 번에 한 호출이다.
 *
 * 1. 감사 두 번째 의견(qwenAuto.auditSecondOpinion, 기본 꺼짐): 보류 후보(확신 문턱 이상·주인 없음·사람 결정 없음·그 제품의 마지막 항목, 이미 보류된 것 포함)
 *    가운데 이 모델·이 판의 의견이 없는 것을 묻고, grok 옮겨 적기와 같은 쓰기(writeAuditSecondOpinions — 덮어쓰기·보류 다시 가르기·승인이면 풀기)로
 *    출처 qwen-v2-auto 를 적는다. 거절은 쓸기가 다음 틱부터 분당 20건씩 건다(Qwen 거절은 카탈로그·디렉터리 같은 항목에서 세지 않는다).
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
 * 물을 감사 항목 — 보류 후보(holdCandidate)이고, 이 모델·이 판의 의견이 없고, 감사 답을 낸 심사자·시도가 같은 모델이 아니며(같은 모델 규칙),
 * 수집 원본이 있다(loadAuditInput 이 입력을 만들 수 있다). 지금 보류의 까닭인 항목 먼저 — 승인이면 목록에 돌아온다 — 그다음 오래된 것부터
 */
function auditOpinionWanted(hold: Pick<AuditHoldSettings, "minConfidence">, model: string, skip: readonly number[]): SQL {
  return sql`${holdCandidate("i", "p", hold.minConfidence)}
    and not exists (select 1 from ${productAuditSecondOpinions} o where o.item_id = i.id and o.model = ${model}
      and o.prompt_version = ${QWEN_V2_PROMPT_VERSION})
    and coalesce(i.ai_provider, '') <> ${QWEN_AUDIT_PROVIDER} and ${bareModel(auditItemModel("i"))} <> ${bareModelValue(model)}
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
  const { auditSecondOpinion: audit, publishedFilter: published } = settings.qwenAuto;
  const lease = ctx.lease;
  // 수집 스위치는 비상 정지다 — 모델을 부르는 다른 잡처럼 여기서도 멈춘다
  if (!lease || !settings.enabled || (!audit.enabled && !published.enabled)) return;
  // 감사의 Qwen 직접 심사가 서버 탈로 물러나는 중이면 같은 서버를 부르지 않는다 — 감사가 먼저다
  if (qwenEndpointBackingOff()) {
    ctx.log("qwen_second_opinion.backoff", { skipped: true });
    return;
  }
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
    const written = target.kind === "audit" ? await writeAudit(target, review, input, lease, tally)
      : await writePublished(target, review, input, lease, tally);
    // 쓰는 순간 그 단계가 꺼져 있었다 — 이 틱의 나머지는 부르지 않는다
    if (written === "switched_off") break;
    // 그 사이 사람이 정했거나 내려갔다 — 다시 묻지 않게 항목 실패로 센다
    if (written === "not_open") failItem(target, "not_open");
  }
  if (!ran) return;
  ctx.log("qwen_second_opinion.ran", { auditAsked: tally.audit.asked, auditReleased: tally.audit.released, publishedAsked: tally.published.asked,
    publishedKept: tally.published.kept, failed: tally.failed, endpointError: tally.endpointError !== null });
  await saveObservation(lease, { ...observation, lastRunAt: now() });
}

async function writeAudit(target: AuditTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease, tally: QwenAutoTally):
  Promise<"written" | "not_open" | "switched_off"> {
  const { outcome } = review;
  const result = await writeAuditSecondOpinions(db, [{ itemId: target.itemId, productId: target.productId, model: review.model,
    decision: outcome.decision, confidence: outcome.confidence ?? null, reason: outcome.reason?.trim().slice(0, 2_000) || null,
    inputHash: input.inputHash, promptVersion: review.promptVersion }], { dryRun: false, source: QWEN_V2_AUTO_SOURCE, lease,
    auto: { actor: QWEN_V2_AUTO_ACTOR } });
  tally.audit.asked += 1;
  if (result.skipped.switched_off) { tally.audit.skipped += 1; return "switched_off"; }
  if (result.inserted + result.updated === 0) { tally.audit.skipped += 1; return "not_open"; }
  tally.audit.released += result.released;
  if (outcome.decision === "approve") tally.audit.approve += 1;
  else if (outcome.decision === "reject") tally.audit.reject += 1;
  else tally.audit.needsReview += 1;
  return "written";
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
  audit: { enabled: boolean; perTick: number; lastHour: number; lastDay: number; remaining: number };
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
  const [[auditRow], [publishedRow], [auditLeft], [publishedLeft], backoff] = await Promise.all([
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
    readQwenEndpointBackoff().catch(() => null),
  ]);
  return {
    model: config?.model ?? null, url: config?.baseUrl ?? null, promptVersion: QWEN_V2_PROMPT_VERSION,
    audit: { enabled: steps.auditSecondOpinion.enabled, perTick: steps.auditSecondOpinion.perTick, lastHour: auditRow?.hour ?? 0, lastDay: auditRow?.day ?? 0,
      remaining: auditLeft?.count ?? 0 },
    published: { enabled: steps.publishedFilter.enabled, perTick: steps.publishedFilter.perTick, lastHour: publishedRow?.hour ?? 0,
      lastDay: publishedRow?.day ?? 0, keptHour: publishedRow?.keptHour ?? 0, keptDay: publishedRow?.keptDay ?? 0, remaining: publishedLeft?.count ?? 0 },
    lastRunAt: observation.lastRunAt, lastSuccessAt: observation.lastSuccessAt, lastError: observation.lastError,
    givenUp: Object.values(observation.failures).filter((failure) => failure.count >= QWEN_AUTO_ITEM_ATTEMPTS).length,
    endpointBackoff: endpointBackoffActive(backoff) ? { until: backoff.retryAt, code: backoff.lastError, failures: backoff.failures } : null,
  };
}
