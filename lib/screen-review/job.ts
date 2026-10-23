import { and, eq, sql } from "drizzle-orm";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { db } from "@/lib/db";
import { operationsObservations, productAuditSecondOpinions } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import { markScreenJudged, screenReviewCounts, screenReviewQueue, type ScreenReviewItem } from "@/lib/crawl/audit-screen-review";
import { loadAuditInput } from "@/lib/crawl/product-audit";
import { qwenBackoffMs, qwenEndpointBackingOff, qwenSoftFailure } from "@/lib/crawl/qwen-endpoint-backoff";
import { QwenDirectError, qwenEndpointFailure } from "@/lib/crawl/qwen-direct-review";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { fontsComplete, type FontCheck } from "./protocol";
import { requestRender, requestRenderHealth, screenRenderConfig } from "./render-client";
import { reviewWithScreenshot, screenInput, screenModelConfig, SCREEN_REVIEW_PROMPT_VERSION, SCREEN_REVIEW_SOURCE, sharesQwenEndpoint,
  visionModelName, type ScreenReview } from "./vision-review";

/**
 * 화면 판별 잡(audit-screen-review, reviewer 의 screen 줄) — '화면 판별 대기'(lib/crawl/audit-screen-review.ts screenReviewQueue — 글이 적거나 원본이
 * 없는 열린 감사 거절, 보류 중 먼저)를 화면 서버(m1-studio)로 그려, 그린 뒤 글과 첫 화면을 m1 Qwen 에 물어 markScreenJudged 로 적는다 — 출처
 * qwen-vision-auto·모델 '<모델>+vision'·판 2026-10-21.v2+shot1 의 두 번째 의견. 같은 커밋에서 답으로 닫는다(audit-auto-close.ts — 승인은 유지, 주인 없는
 * 것의 거절은 숨김. 화면 판정은 글이 적어도 닫고, 엇갈림은 화면을 본 의견끼리만 가른다). 설정 qwenAuto.screenReview(기본 꺼짐)를 쓰는 순간 다시 보고,
 * 답으로 닫기는 감사 두 번째 의견의 autoClose 를 따른다.
 *
 * 한 틱(예산 150초): 그리기(서버 상한 40초) → 묻기(상한 90초, 남은 시간만큼 줄인다) → 적기를 틱당 perTick 건까지, 새 건은 68초 이상 남을 때만.
 * m1 을 나눠 쓰는 법: 이 줄은 한 번에 한 건만 묻는다(줄은 차례로 돌고, 역할 lease 로 reviewer 하나만 일한다). 글만 묻는 단계들의 두 번째 자리
 * (withQwenSecondarySlot)는 잡지 않는다 — 화면 묻기는 한 건이 길어 그 자리를 잡으면 그 단계들의 30초 창을 통째로 빼앗는다. 대신 같은 서버면
 * 그쪽의 물러나기를 따르고(그동안 그리지도 않는다), 이 줄의 탈은 이 줄만 물러나게 한다(잘못 적은 비전 모델 이름의 404 가 글 단계까지 멈추지 않게).
 *
 * 실패: 화면 서버 탈(닿지 않음·401/403·5xx·약속과 다른 답)·모델 서버 탈(닿지 않음·5xx·401/403/404, 시간 초과 세 번 잇달아)은 그 쪽만 1분에서 두 배씩
 * 15분까지 물러난다. 동시 그리기 상한(429)·모델 붐빔(429)은 이 틱만 멈춘다. 페이지 탓(막힘·닿지 않음·4xx/5xx·그리기 시간 초과)과 항목 탓(형식 오류·
 * 입력 초과)은 그 항목을 두 번까지 보고 하루 쉰 뒤 한 번 더 본다(관측의 failures — 원본이 없는 것처럼 다시 해도 같은 것은 바로 쉰다).
 * 답을 받은 것(판단 보류·낮은 확신 포함)은 화면 의견이 적혀 대기에서 빠지고 열린 채 사람이 본다. 화면 서버가 샌드박스를 끄고 있거나 글꼴(한·일·중)이 없으면
 * 그리지 않는다(두부 화면을 모델이 오판한다 — 2026-10-22 재판정에서 겪었다).
 */

export const SCREEN_REVIEW_JOB = "audit-screen-review";
export const SCREEN_REVIEW_OBSERVATION = "screen-review";
export const SCREEN_REVIEW_BUDGET_MS = 150_000;
/** 그리기 요청의 상한 — 서버의 그리기 상한 40초 + 브라우저 띄우기·주고받기 */
export const SCREEN_RENDER_TIMEOUT_MS = 55_000;
/** 묻기의 상한 — 재판정 실측 중앙값 77초(두 갈래 동시·운영 부하 함께)·p95 103초, 한 건만이면 12초쯤 */
export const SCREEN_MODEL_TIMEOUT_MS = 90_000;
const MIN_RENDER_WINDOW_MS = 45_000;
const MIN_MODEL_WINDOW_MS = 20_000;
const WRITE_MARGIN_MS = 3_000;
export const SCREEN_REVIEW_ITEM_ATTEMPTS = 2;
/** 그만 본 항목을 다시 보는 간격 — 화면 서버·사이트가 그사이 나아졌을 수 있다. 다시 실패하면 또 이만큼 쉰다 */
export const SCREEN_REVIEW_RETRY_MS = 24 * 3600_000;
const HEALTH_EVERY_MS = 10 * 60_000;
const FAILURE_MEMORY = 1_000;
const SOFT_STREAK = 3;

type Stage = "render" | "model" | "input" | "write" | "config";
type Backoff = { failures: number; retryAt: number; code: string | null };

/** 이 프로세스의 물러나기 — 화면 서버·모델 서버 따로. 워커가 다시 뜨면 처음부터 */
export const screenBackoff: { render: Backoff; model: Backoff; softStreak: number } = {
  render: { failures: 0, retryAt: 0, code: null }, model: { failures: 0, retryAt: 0, code: null }, softStreak: 0,
};
export function resetScreenBackoff(): void {
  screenBackoff.render = { failures: 0, retryAt: 0, code: null };
  screenBackoff.model = { failures: 0, retryAt: 0, code: null };
  screenBackoff.softStreak = 0;
}
function noteOutage(side: "render" | "model", code: string, now = Date.now()): void {
  const state = screenBackoff[side];
  state.failures += 1;
  state.retryAt = now + qwenBackoffMs(state.failures);
  state.code = code;
}
const backingOff = (side: "render" | "model", now = Date.now()) => screenBackoff[side].retryAt > now;

export type ScreenHealth = { at: string; ok: boolean; version: string | null; sandbox: boolean | null; fonts: FontCheck | null };
export type ScreenObservation = {
  model: string; promptVersion: string; lastRunAt: string | null; lastSuccessAt: string | null;
  lastError: { code: string; stage: Stage; at: string } | null;
  /** 항목만의 실패 — 키 a:<감사 항목 id> */
  failures: Record<string, { code: string; count: number; at: string }>;
  health: ScreenHealth | null;
  backoff: { render: { until: string; code: string | null } | null; model: { until: string; code: string | null } | null };
};

export type ScreenTally = { asked: number; approve: number; reject: number; needsReview: number; kept: number; held: number; released: number;
  failed: number; skipped: number; renderMs: number; modelMs: number; outage: string | null };

function emptyObservation(model: string): ScreenObservation {
  return { model, promptVersion: SCREEN_REVIEW_PROMPT_VERSION, lastRunAt: null, lastSuccessAt: null, lastError: null, failures: {}, health: null,
    backoff: { render: null, model: null } };
}

/** 지금 모델·판의 관측 — 모델·판이 바뀌었으면 항목 실패는 버린다 */
export async function readScreenObservation(model: string): Promise<ScreenObservation> {
  const [row] = await db.select({ value: operationsObservations.value }).from(operationsObservations)
    .where(eq(operationsObservations.key, SCREEN_REVIEW_OBSERVATION));
  const value = row?.value as Partial<ScreenObservation> | undefined;
  if (!value || typeof value !== "object") return emptyObservation(model);
  const same = value.model === model && value.promptVersion === SCREEN_REVIEW_PROMPT_VERSION;
  return { ...emptyObservation(model), lastRunAt: value.lastRunAt ?? null, lastSuccessAt: value.lastSuccessAt ?? null, lastError: value.lastError ?? null,
    failures: same && value.failures && typeof value.failures === "object" ? value.failures : {}, health: value.health ?? null,
    backoff: value.backoff ?? { render: null, model: null } };
}

async function saveObservation(lease: JobLease, value: ScreenObservation): Promise<void> {
  const kept = Object.entries(value.failures).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, FAILURE_MEMORY);
  const iso = (state: Backoff) => state.retryAt > Date.now() ? { until: new Date(state.retryAt).toISOString(), code: state.code } : null;
  const next = { ...value, failures: Object.fromEntries(kept), backoff: { render: iso(screenBackoff.render), model: iso(screenBackoff.model) } };
  await withJobLeaseWrite(lease, async (tx) => {
    await tx.insert(operationsObservations).values({ key: SCREEN_REVIEW_OBSERVATION, value: next, observedAt: new Date() })
      .onConflictDoUpdate({ target: operationsObservations.key, set: { value: next, observedAt: new Date() } });
  });
}

/** 지금 그만 보는 항목 — 두 번 실패했고 마지막 실패가 하루 안. 하루가 지나면 한 번 더 본다(그 실패가 다시 나면 또 하루) */
function givenUp(observation: ScreenObservation, now = Date.now()): number[] {
  return Object.entries(observation.failures)
    .flatMap(([key, failure]) => key.startsWith("a:") && failure.count >= SCREEN_REVIEW_ITEM_ATTEMPTS && now - Date.parse(failure.at) < SCREEN_REVIEW_RETRY_MS
      ? [Number(key.slice(2))] : [])
    .filter(Number.isSafeInteger);
}

export type ScreenReviewDeps = { env?: Readonly<Record<string, string | undefined>>; request?: typeof fetch; settings?: CrawlSettings };

/** 한 틱 — 잡을 실패시키지 않는 탈(서버·설정)은 degraded 로 알린다 */
export async function reviewThinPagesByScreen(ctx: JobContext<null>, deps: ScreenReviewDeps = {}): Promise<JobOutcome<null>> {
  const settings = deps.settings ?? await getSettings();
  const step = settings.qwenAuto.screenReview;
  const lease = ctx.lease;
  // 수집 스위치는 비상 정지다 — 모델을 부르는 다른 잡처럼 여기서도 멈춘다
  if (!lease || !settings.enabled || !step.enabled) return { done: true };
  const env = deps.env ?? process.env;
  const render = screenRenderConfig(env);
  const model = screenModelConfig(env);
  const recordedModel = model ? visionModelName(model.model) : "";
  const observation = await readScreenObservation(recordedModel);
  const now = () => new Date().toISOString();
  if (!render || !model) {
    observation.lastError = { code: "screen_review_not_configured", stage: "config", at: now() };
    await saveObservation(lease, { ...observation, lastRunAt: now() });
    return { done: true, degraded: { code: "screen_review_not_configured",
      detail: "SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN(32자 이상)과 모델 주소(SCREEN_REVIEW_MODEL_URL 또는 AUDIT_SECOND_OPINION_URL)를 확인하세요." } };
  }
  const shared = sharesQwenEndpoint(env);
  // 같은 m1 을 글 단계들이 탈로 물러나는 중이면 그리지도 않는다 — 글 단계가 먼저다
  if ((shared && qwenEndpointBackingOff()) || backingOff("render") || backingOff("model")) {
    ctx.log("screen_review.backoff", { skipped: true });
    return { done: true };
  }
  const request = deps.request;
  // 화면 서버 상태 — 10분마다. 샌드박스가 꺼져 있거나 글꼴이 없으면 그리지 않는다
  const healthAge = observation.health ? Date.now() - Date.parse(observation.health.at) : Infinity;
  if (!(healthAge < HEALTH_EVERY_MS) || !observation.health?.ok) {
    const health = await requestRenderHealth({ config: render, request });
    observation.health = { at: now(), ok: Boolean(health?.sandbox && fontsComplete(health.fonts)), version: health?.version ?? null,
      sandbox: health?.sandbox ?? null, fonts: health?.fonts ?? null };
    if (!health) {
      noteOutage("render", "render_unreachable");
      observation.lastError = { code: "render_unreachable", stage: "render", at: now() };
      await saveObservation(lease, { ...observation, lastRunAt: now() });
      return { done: true, degraded: { code: "screen_render_unreachable", detail: "화면 서버(SCREEN_RENDER_URL)에 닿지 않습니다." } };
    }
    if (!observation.health.ok) {
      const code = !health.sandbox ? "screen_render_unsandboxed" : "screen_render_fonts_missing";
      observation.lastError = { code, stage: "render", at: now() };
      await saveObservation(lease, { ...observation, lastRunAt: now() });
      return { done: true, degraded: { code, critical: true, detail: !health.sandbox
        ? "화면 서버가 Chromium 샌드박스 없이 돌고 있어 그리지 않습니다."
        : "화면 서버에 한·일·중 글꼴이 없어 그리지 않습니다(두부 화면은 오판한다)." } };
    }
  }
  const targets = await screenReviewQueue({ limit: step.perTick, skip: givenUp(observation) });
  const tally: ScreenTally = { asked: 0, approve: 0, reject: 0, needsReview: 0, kept: 0, held: 0, released: 0, failed: 0, skipped: 0,
    renderMs: 0, modelMs: 0, outage: null };
  if (!targets.length) {
    await saveObservation(lease, { ...observation, lastRunAt: now() });
    return { done: true };
  }
  const left = () => (ctx.deadlineAt ?? Infinity) - Date.now();
  const canStart = () => !ctx.signal?.aborted && ctx.hasBudget() && left() >= MIN_RENDER_WINDOW_MS + MIN_MODEL_WINDOW_MS + WRITE_MARGIN_MS
    && !backingOff("render") && !backingOff("model") && !(shared && qwenEndpointBackingOff());
  /** 항목만의 실패 — permanent 면(원본 없음 등 다시 해도 같은 것) 바로 그만 본다 */
  const failItem = (target: ScreenReviewItem, code: string, stage: Stage, permanent = false) => {
    tally.failed += 1;
    const key = `a:${target.itemId}`;
    const count = permanent ? SCREEN_REVIEW_ITEM_ATTEMPTS : (observation.failures[key]?.count ?? 0) + 1;
    observation.failures[key] = { code: code.slice(0, 80), count, at: now() };
    observation.lastError = { code: code.slice(0, 80), stage, at: now() };
  };

  for (const target of targets) {
    if (!canStart()) break;
    let input: ReviewInput | null;
    try {
      input = await loadAuditInput(target.slug, settings);
    } catch (error) {
      failItem(target, error instanceof Error && /^[a-z0-9_]{3,60}$/.test(error.message) ? error.message : "input_error", "input");
      continue;
    }
    // 수집 원본이 없는 항목도 대기에 든다(글을 확인할 수 없다) — 입력(증거·README)을 만들 수 없어 사람이 본다
    if (!input) { failItem(target, "no_source", "input", true); continue; }
    // 판정할 주소는 공개 목록이 여는 그 주소(대기의 url — 보류 918건 재판정과 같다)
    const url = target.url || input.snapshot.product.url;
    if (!url) { failItem(target, "no_url", "input", true); continue; }

    const renderStarted = Date.now();
    const rendered = await requestRender(url, { config: render, request, signal: ctx.signal,
      timeoutMs: Math.min(SCREEN_RENDER_TIMEOUT_MS, left() - MIN_MODEL_WINDOW_MS - WRITE_MARGIN_MS) });
    tally.renderMs += Date.now() - renderStarted;
    if (!rendered.ok) {
      if (rendered.kind === "busy") break;
      if (rendered.kind === "outage") {
        noteOutage("render", rendered.code);
        observation.lastError = { code: rendered.code, stage: "render", at: now() };
        tally.outage = rendered.code;
        break;
      }
      failItem(target, rendered.code, "render");
      continue;
    }
    screenBackoff.render = { failures: 0, retryAt: 0, code: null };

    if (shared && qwenEndpointBackingOff()) break;
    const timeoutMs = Math.min(SCREEN_MODEL_TIMEOUT_MS, left() - WRITE_MARGIN_MS);
    if (timeoutMs < MIN_MODEL_WINDOW_MS) break;
    const shrunk = timeoutMs < SCREEN_MODEL_TIMEOUT_MS;
    const modelStarted = Date.now();
    let review: ScreenReview;
    try {
      const reviewInput = screenInput(input, rendered.text);
      review = await withLocalModelCapacity({ target: { kind: "audit", purpose: "screen", itemId: target.itemId, slug: target.slug },
        input: reviewInput, lease, promptVersion: SCREEN_REVIEW_PROMPT_VERSION, env },
      fetchModel => reviewWithScreenshot(reviewInput, rendered.jpeg, { config: model, timeoutMs, signal: ctx.signal, request: fetchModel }), request);
    } catch (error) {
      tally.modelMs += Date.now() - modelStarted;
      if (error instanceof ModelCapacityDeferredError) { ctx.log("screen_review.model_deferred", { reason: error.reason }); break; }
      if (!(error instanceof QwenDirectError)) throw error;
      if (error.code === "qwen_cancelled") break;
      // 줄인 제한 시간(틱 끝)에 걸렸다 — 서버 탓도 항목 탓도 아니다
      if (error.code === "qwen_timeout" && shrunk) break;
      if (error.code === "qwen_http_429") break;
      if (qwenSoftFailure(error.code)) {
        screenBackoff.softStreak += 1;
        failItem(target, error.code, "model");
        if (screenBackoff.softStreak >= SOFT_STREAK) { noteOutage("model", error.code); tally.outage = error.code; break; }
        continue;
      }
      if (qwenEndpointFailure(error.code)) {
        noteOutage("model", error.code);
        observation.lastError = { code: error.code, stage: "model", at: now() };
        tally.outage = error.code;
        break;
      }
      failItem(target, error.code, "model");
      continue;
    }
    tally.modelMs += Date.now() - modelStarted;
    screenBackoff.model = { failures: 0, retryAt: 0, code: null };
    screenBackoff.softStreak = 0;
    const written = await writeScreenOpinion(target, review, lease, tally);
    if (written === "switched_off") break;
    if (written === "not_open") { failItem(target, "not_open", "write"); continue; }
    delete observation.failures[`a:${target.itemId}`];
    observation.lastSuccessAt = now();
  }
  ctx.log("screen_review.ran", { asked: tally.asked, approve: tally.approve, reject: tally.reject, needsReview: tally.needsReview, kept: tally.kept,
    held: tally.held, released: tally.released, failed: tally.failed, renderMs: tally.renderMs, modelMs: tally.modelMs, outage: tally.outage !== null });
  await saveObservation(lease, { ...observation, lastRunAt: now() });
  if (tally.outage) {
    return { done: true, degraded: { code: tally.outage.startsWith("render_") ? "screen_render_outage" : "screen_model_outage", detail: tally.outage } };
  }
  return { done: true };
}

/**
 * 한 답을 적는다 — 화면 판별 대기의 판정 표시(markScreenJudged — 두 번째 의견 한 줄·보류 다시 가르기)를 지나 같은 커밋에서 그 답으로 닫는다.
 * 스위치는 화면 판별(screenReview)을 쓰는 순간 다시 본다
 */
async function writeScreenOpinion(target: ScreenReviewItem, review: ScreenReview, lease: JobLease, tally: ScreenTally):
  Promise<"written" | "not_open" | "switched_off"> {
  const { outcome } = review;
  const result = await markScreenJudged([{ itemId: target.itemId, productId: target.productId, model: review.recordedModel,
    decision: outcome.decision, confidence: outcome.confidence ?? null, reason: outcome.reason?.trim().slice(0, 2_000) || null,
    inputHash: review.inputHash, promptVersion: review.promptVersion }],
  { source: SCREEN_REVIEW_SOURCE, actor: SCREEN_REVIEW_SOURCE, lease, close: true, step: "screenReview" });
  tally.asked += 1;
  if (result.skipped.switched_off) { tally.skipped += 1; return "switched_off"; }
  if (result.inserted + result.updated === 0) { tally.skipped += 1; return "not_open"; }
  tally.released += result.released;
  tally.kept += result.autoClose?.kept ?? 0;
  tally.held += result.autoClose?.held ?? 0;
  if (outcome.decision === "approve") tally.approve += 1;
  else if (outcome.decision === "reject") tally.reject += 1;
  else tally.needsReview += 1;
  return "written";
}

export type ScreenReviewStatus = {
  enabled: boolean; perTick: number; configured: boolean; renderHost: string | null; model: string | null; shared: boolean; promptVersion: string;
  lastHour: number; lastDay: number; approveDay: number; rejectDay: number;
  /** 화면 판별 대기에서 그만 본 것을 뺀 수 · 그중 공개 목록에 떠 있는 것(screenReviewCounts) */
  remaining: number; waitingPublic: number; givenUp: number;
  lastRunAt: string | null; lastSuccessAt: string | null; lastError: ScreenObservation["lastError"]; health: ScreenHealth | null;
  backoff: ScreenObservation["backoff"];
};

/** 감사 화면의 화면 판별 상태 — 켬/끔, 설정, 지난 1시간·24시간에 적은 수, 남은 것, 서버 상태 */
export async function screenReviewStatus(settings: Pick<CrawlSettings, "qwenAuto">, deps: Pick<ScreenReviewDeps, "env"> = {}):
  Promise<ScreenReviewStatus> {
  const env = deps.env ?? process.env;
  const render = screenRenderConfig(env);
  const model = screenModelConfig(env);
  const recordedModel = model ? visionModelName(model.model) : "";
  const observation = await readScreenObservation(recordedModel);
  const skipped = givenUp(observation);
  const [[counts], waiting] = await Promise.all([
    db.select({
      hour: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '1 hour')::int`,
      day: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '24 hours')::int`,
      approveDay: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '24 hours' and ${productAuditSecondOpinions.decision} = 'approve')::int`,
      rejectDay: sql<number>`count(*) filter (where ${productAuditSecondOpinions.createdAt} > now() - interval '24 hours' and ${productAuditSecondOpinions.decision} = 'reject')::int`,
    }).from(productAuditSecondOpinions).where(and(eq(productAuditSecondOpinions.source, SCREEN_REVIEW_SOURCE),
      eq(productAuditSecondOpinions.model, recordedModel), eq(productAuditSecondOpinions.promptVersion, SCREEN_REVIEW_PROMPT_VERSION))),
    screenReviewCounts().catch((error: unknown) => {
      logger.warn("screen_review.remaining_failed", { code: error instanceof Error ? error.name : "unknown" });
      return null;
    }),
  ]);
  return {
    enabled: settings.qwenAuto.screenReview.enabled, perTick: settings.qwenAuto.screenReview.perTick, configured: Boolean(render && model),
    renderHost: render ? new URL(render.baseUrl).host : null, model: model ? recordedModel : null, shared: sharesQwenEndpoint(env),
    promptVersion: SCREEN_REVIEW_PROMPT_VERSION, lastHour: counts?.hour ?? 0, lastDay: counts?.day ?? 0, approveDay: counts?.approveDay ?? 0,
    rejectDay: counts?.rejectDay ?? 0, remaining: Math.max(0, (waiting?.screenWait ?? 0) - skipped.length), waitingPublic: waiting?.screenWaitPublic ?? 0,
    givenUp: skipped.length, lastRunAt: observation.lastRunAt, lastSuccessAt: observation.lastSuccessAt,
    lastError: observation.lastError, health: observation.health, backoff: observation.backoff,
  };
}
