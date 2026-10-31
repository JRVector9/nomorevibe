import { modelLimits, modelTimeoutMs } from "@/lib/llm/model-registry";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { getSettings } from "@/lib/crawl/settings";
import { finishAuditCampaign, loadAuditInput, markAuditInputFailed, markAuditNoSource, pendingAuditItems, recordAuditResult,
  runningAuditCampaign } from "@/lib/crawl/product-audit";
import { auditReviewer, sameAuditReviewer, type AuditReviewer } from "@/lib/crawl/product-audit-reviewer";
import { qwenDirectConfig, QwenDirectError, reviewWithQwenDirect, QWEN_V2_PROMPT_VERSION,
  type QwenDirectErrorCode, type QwenDirectReview } from "@/lib/crawl/qwen-direct-review";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { ProductAuditCampaign } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { classifyQwenCallFailure, noteQwenAnswered, noteQwenEndpointSuccess, qwenBackoffMs, qwenEndpointBackingOff, qwenEndpointBackoff,
  resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { AUDIT_TICK_MS as TICK_MS, AUDIT_WRITE_MARGIN_MS as WRITE_MARGIN_MS, auditCampaignForTick } from "./product-audit";

/**
 * Qwen 직접 감사 잡(audit-qwen) — 남은 감사 모델 바꾸기(0112) 뒤 감사 행의 심사자가 qwen-direct 인 감사의 남은 항목을 gpu3090 vLLM 에 게이트웨이 없이
 * 묻는다(아래 auditWithQwen). 2026-10-31(PR 3a-C) 전에는 감사 잡(product-audit) 틱의 한 갈래였다 — 보류 쓸기·게이트웨이/CLI 감사·두 번째 의견과
 * 한 잡이라 gpu3090 의 서버 탈(물러나기 중 틱 실패)이 쓸기·게이트웨이 감사의 틱까지 실패로 남기고, 게이트웨이 감사의 양보가 이 갈래의 차례를
 * 흔들었다. 이제 자기 줄(audit-qwen)에서 돈다. 감사 행이 게이트웨이/CLI 심사자면 이 잡은 할 일이 없다(product-audit 이 맡는다).
 * 틱의 길이(TICK_MS 65초)·예산(70초)·자리(qwenAuditConcurrency)·물러나기·기록은 그대로다.
 */
export async function auditWithQwenDirect(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  const campaign = await auditCampaignForTick(ctx, settings, "audit_qwen");
  if (!campaign) return { done: true };
  if (!campaign.direct) {
    ctx.log("audit_qwen.skipped", { reason: "gateway_reviewer", campaign: campaign.campaign.id });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("audit qwen requires a valid worker job lease");
  return auditWithQwen(ctx, { campaign: campaign.campaign, reviewer: campaign.reviewer, settings, startedAt, lease });
}

// ─────────────────────────── Qwen 직접 심사(남은 감사 모델 바꾸기 뒤) — 2026-10-31 jobs/product-audit.ts 에서 그대로 옮김 ───────────────────────────

/**
 * 한 호출의 제한 시간 — 운영 실측(2026-10-21, #587·AUDIT_QWEN_CONCURRENCY=4 뒤 한 시간): 한 건만 띄우면 2.5초인데 넷을 띄우면 한 건에 12초쯤
 * (성공 83건 평균 11.8초·최대 19.8초, TP4 MoE·3090 넷)이라 20초 제한에 18건이 걸렸다. 45초로 넉넉히 둔다
 */
export const QWEN_CALL_TIMEOUT_MS = modelTimeoutMs("product-audit");
/** 위 상수는 로드 시점 값(테스트·문서용). 틱은 이 함수로 등록부 경로 product-audit 을 그때 읽는다 — 관리자 실시간 한도가 다음 틱에 반영된다 */
export function qwenCallTimeoutMs(): number { return modelTimeoutMs("product-audit"); }
/**
 * 새 호출을 시작할 수 있는 남은 시간 — 부하 중 p95 쯤. 남은 시간이 45초보다 짧으면 제한 시간을 남은 시간(저장 여유를 뺀)으로 줄여 부른다.
 * 줄인 제한 시간에 걸린 것은 틱 끝 때문이라 서버 탈도 항목의 시도도 아니다 — 적지 않는다(러너 예산으로 끊긴 것과 같다)
 */
export const QWEN_MIN_START_MS = 15_000;
/** 감사 중단·모델 바꿈·수집 스위치를 틱 도중에 다시 보는 간격 — 호출마다 보면 한 틱에 수십 번 설정을 읽는다 */
const QWEN_CONTROL_CHECK_MS = 5_000;
/** 한 번에 읽어 둘 일감 — 자리마다 틱 하나(65초)에 3초씩 스무 건 남짓이라 넉넉히 */
const QWEN_QUEUE_PER_SLOT = 40;
export const QWEN_AUDIT_MAX_CONCURRENCY = 4;

/** 동시 호출 수 — AUDIT_QWEN_CONCURRENCY(기본 2, 최대 4). 1차 심사의 reviewConcurrency(공유 게이트웨이 몫)와 따로다 */
export function qwenAuditConcurrency(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.AUDIT_QWEN_CONCURRENCY?.trim() || Number.NaN);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, QWEN_AUDIT_MAX_CONCURRENCY) : Math.min(modelLimits("direct-review", env).concurrency, QWEN_AUDIT_MAX_CONCURRENCY);
}

/** 부르는 곳이 탈 났을 때 물러나는 시간 — 1분에서 두 배씩, 15분까지. 한 틱에서라도 답을 받으면 처음부터 센다 */
export const qwenAuditBackoffMs = qwenBackoffMs;

/**
 * 부르는 곳이 연달아 탈 난 틱 수와 다시 물어볼 시각 — gpu3090 을 부르는 모든 쪽(두 번째 의견·공개분 거르기·갈림 판가름)과 함께 쓴다
 * (qwen-endpoint-backoff.ts). 누가 탈을 만나든 감사도 물러나고, 감사가 탈을 만나면 다른 쪽도 물러난다
 */
const qwenEndpoint = qwenEndpointBackoff;
export { resetQwenAuditBackoff };

/** 틱의 호출 시간 — 수·평균·p90·최대(ms). 답을 받았거나 진짜로 실패한 호출만(멈춤·틱 끝에 끊긴 것은 뺀다) */
export function latencyStats(values: number[]): { count: number; avgMs: number | null; p90Ms: number | null; maxMs: number | null } {
  if (!values.length) return { count: 0, avgMs: null, p90Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, avgMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p90Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)], maxMs: sorted.at(-1)! };
}

/** 항목 탓일 수 없는 탈 — 닿지 않음·설정·키·모델 없음. 시도로 세지 않는다 */
const neverItemFailure = (code: QwenDirectErrorCode) =>
  code === "qwen_unreachable" || code === "qwen_not_configured" || /^qwen_http_(401|403|404)$/.test(code);

/**
 * Qwen 직접 심사로 묻는 감사의 틱(0112) — gpu3090 vLLM 을 게이트웨이 없이 부른다(qwen-direct-review.ts). 게이트웨이 길과 다른 것:
 *  - 자리 수는 qwenAuditConcurrency(기본 2, 최대 4). 공통 모델 슬롯을 거치지 않는다 — 게이트웨이도 Claude CLI 도 아니다.
 *  - 틱(TICK_MS, 러너 예산 70초 안)이 끝날 때까지 자리마다 다음 것을 잇달아 묻는다. 틱 끝까지 QWEN_MIN_START_MS(15초) 이상 남아 있으면
 *    새로 시작하고, 제한 시간은 min(45초, 남은 시간 − 저장 여유)다. 줄인 제한 시간에 걸린 것(틱 끝)은 적지 않는다 — 서버 탈도 항목의 시도도 아니다.
 *  - 감사 중단·모델 바꿈·수집 스위치를 QWEN_CONTROL_CHECK_MS 마다 다시 보고, 바뀌었으면 새 호출을 멈춘다(이미 띄운 호출의 답은 적는다).
 *  - 서버 탈(qwen-endpoint-backoff.ts noteQwenCallFailure — 닿지 않음·5xx·401/403/404 는 바로, 진짜 시간 초과·429 는 부르는 쪽 모두를
 *    통틀어 성공 없이 세 번 잇달아): 이 틱의 새 호출을 멈추고 잡을 실패로 남기며(운영센터에 드러난다) 1분·2분·4분…15분 동안 묻지 않는다.
 *    그동안의 틱도 실패로 남긴다 — 감사가 서 있는 것이 보이게.
 *  - 탈이 아닌 한 번의 진짜 시간 초과(45초를 다 썼다)는 그 항목의 시도로 세고(세 번까지) 다른 자리는 이어 간다 — 잡을 실패로 남기지 않는다.
 *    429 는 항목 탓이 아니라 세지 않는다. 서버 탈로 끝난 호출은 Qwen 이 멀쩡하던 중(틱에 들어올 때 연속 탈이 없었거나 이 틱에 이미 답을
 *    받았다)에 난 제한 시간·429·5xx 만 센다 — 서버가 오래 죽어 있어도 남은 항목의 시도가 닳지 않는다.
 *    닿지 않음·설정·키·모델 없음은 항목 탓일 수 없어 세지 않는다. 형식 오류·입력 초과·400 대 요청 거절은 그 항목의 실패로 센다.
 *  - 틱마다 호출 시간(수·평균·p90·최대 ms)과 진짜 시간 초과·줄인 제한 시간에 걸린 수를 product_audit.reviewed 에 남긴다.
 * DB 트랜잭션 안에서 부르지 않는다 — 원본을 읽고(loadAuditInput), 밖에서 묻고, 답을 적는 트랜잭션(recordAuditResult)을 따로 연다.
 */
async function auditWithQwen(ctx: JobContext<null>, value: { campaign: ProductAuditCampaign; reviewer: AuditReviewer; settings: CrawlSettings;
  startedAt: number; lease: JobLease }): Promise<JobOutcome<null>> {
  const { campaign, reviewer, settings, startedAt, lease } = value;
  if (qwenEndpointBackingOff()) {
    ctx.log("product_audit.endpoint_backoff", { campaign: campaign.id, failures: qwenEndpoint.failures, waitMs: qwenEndpoint.retryAt - Date.now() });
    throw new Error(`product_audit_endpoint_backoff:${qwenEndpoint.lastError ?? "qwen_unreachable"}`);
  }
  // 모델은 감사 행이 정한다(바꿀 때 굳힌 것) — 주소·키만 환경변수(AUDIT_SECOND_OPINION_URL·_API_KEY)에서 읽는다
  const env = { ...process.env, AUDIT_SECOND_OPINION_MODEL: reviewer.model };
  if (!qwenDirectConfig(env)) throw new Error("product_audit_reviewer_unavailable:qwen_not_configured");
  const concurrency = qwenAuditConcurrency();
  const queue = await pendingAuditItems(campaign.id, concurrency * QWEN_QUEUE_PER_SLOT);
  if (!queue.length) {
    if (await finishAuditCampaign(campaign.id, lease)) ctx.log("product_audit.finished", { campaign: campaign.id });
    return { done: true };
  }
  // 틱 끝과, 저장 여유를 남긴 호출의 끝 — 여기에 걸린 호출은 끊는다
  const tickEnd = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity);
  const left = () => tickEnd - Date.now();
  const remaining = () => left() - WRITE_MARGIN_MS;
  const callTimeoutMs = qwenCallTimeoutMs();
  let reviewed = 0, failed = 0, noSource = 0, timeouts = 0, cutoff = 0;
  const latencies: number[] = [];
  let endpoint: QwenDirectErrorCode | null = null;
  // 답을 받은 호출 중 가장 늦게 띄운 것의 시각 — 다른 쪽이 그 뒤에 적은 탈(물러나기)은 이 틱의 답으로 풀지 않는다
  let lastAnsweredStartAt = 0;
  // 감사가 멈췄거나·심사자가 바뀌었거나·수집 스위치가 꺼졌다 — 새 호출을 시작하지 않는다
  let stopped = false;
  let checkedAt = Date.now();
  let checking: Promise<void> | null = null;
  const recheck = async () => {
    if (stopped || Date.now() - checkedAt < QWEN_CONTROL_CHECK_MS) return;
    checking ??= (async () => {
      const [now, latest] = await Promise.all([runningAuditCampaign(), getSettings()]);
      checkedAt = Date.now();
      if (!now || now.id !== campaign.id || !sameAuditReviewer(auditReviewer(now), reviewer) || !latest.enabled) stopped = true;
    })().finally(() => { checking = null; });
    await checking;
  };
  // 틱 끝까지 15초 이상 남아야 시작한다(제한 시간은 그 안으로 줄인다). 누가 서버 탈을 만나 함께 쓰는 물러나기(qwen-endpoint-backoff.ts)가
  // 걸리면 같은 틱의 다른 자리도 곧바로 멈춘다
  const canStart = () => !endpoint && !stopped && !ctx.signal?.aborted && ctx.hasBudget() && !qwenEndpointBackingOff()
    && left() >= QWEN_MIN_START_MS;

  const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!canStart()) return;
      await recheck();
      if (!canStart()) return;
      // 입력을 만들다 실패한 항목(입력 상한 초과 등)이 매 틱 같은 자리를 막거나 잡을 실패시키지 않게 그 항목의 실패로 적고 넘어간다
      let input: Awaited<ReturnType<typeof loadAuditInput>>;
      try { input = await loadAuditInput(item.slug, settings); }
      catch (caught) {
        failed += 1;
        await markAuditInputFailed(item.id, caught instanceof Error && /^[a-z0-9_]{3,60}$/.test(caught.message) ? caught.message : "input_error", lease);
        continue;
      }
      if (!canStart()) return;
      if (!input) {
        noSource += 1;
        await markAuditNoSource(item.id, lease);
        continue;
      }
      // 시도로 셀지는 부르는 순간의 서버 상태로 — 같은 틱의 다른 자리가 막 탈을 만났을 수 있다
      const healthy = qwenEndpoint.failures === 0 || reviewed > 0;
      // 남은 시간이 45초보다 짧으면 그만큼 줄여 부른다 — 줄인 제한 시간에 걸린 것은 틱 끝 때문이다
      const timeoutMs = Math.min(callTimeoutMs, remaining());
      const shrunk = timeoutMs < callTimeoutMs;
      if (timeoutMs <= 0) return;
      const callStartedAt = new Date();
      const controller = new AbortController();
      const abort = () => controller.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      const ownershipPoll = setInterval(() => { if (!ctx.hasBudget() || remaining() <= 0) controller.abort(); }, 250);
      ownershipPoll.unref?.();
      let review: QwenDirectReview | null = null;
      let error: QwenDirectErrorCode | null = null;
      try {
        review = await withLocalModelCapacity({ target: { kind: "audit", purpose: "audit", itemId: item.id, slug: item.slug },
          input, lease, promptVersion: QWEN_V2_PROMPT_VERSION, env },
        request => reviewWithQwenDirect(input, { timeoutMs, signal: controller.signal, env, request }));
      } catch (caught) {
        if (caught instanceof ModelCapacityDeferredError) { ctx.log("audit.local_model_deferred", { reason: caught.reason }); return; }
        if (!(caught instanceof QwenDirectError)) throw caught;
        error = caught.code;
      } finally {
        clearInterval(ownershipPoll);
        ctx.signal?.removeEventListener("abort", abort);
      }
      // 멈추라고 해서 끊긴 것은 실패가 아니다 — 적지 않는다. 줄인 제한 시간(틱 끝)에 걸린 것도 같다 — 서버 탈도 항목의 시도도 아니다
      if (controller.signal.aborted || ctx.signal?.aborted || !ctx.hasBudget() || error === "qwen_cancelled"
        || error === "qwen_timeout" && shrunk) { cutoff += 1; return; }
      latencies.push(Date.now() - callStartedAt.getTime());
      const call = { itemId: item.id, startedAt: callStartedAt, provider: reviewer.provider, model: review?.model ?? reviewer.model,
        promptVersion: review?.promptVersion ?? QWEN_V2_PROMPT_VERSION, input };
      if (review) {
        reviewed += 1;
        noteQwenAnswered();
        lastAnsweredStartAt = Math.max(lastAnsweredStartAt, callStartedAt.getTime());
        await recordAuditResult({ ...call, ok: true, outcome: review.outcome }, lease, settings.auditHold);
        continue;
      }
      const code = error ?? "qwen_unreachable";
      if (code === "qwen_timeout") timeouts += 1;
      // 서버 탈인지는 함께 쓰는 셈이 가른다 — 바로(기다림 없이) 가르고 적어 같은 순간 실패한 다른 자리가 탈을 두 번 세지 않게 하고,
      // 이 틱에서 이미 답을 받았으면 연속 탈을 처음부터 센다
      let outage = Boolean(endpoint);
      if (!endpoint) {
        const noted = classifyQwenCallFailure(code, { freshStreak: reviewed > 0 });
        outage = noted.outage;
        if (outage) endpoint = code;
        await noted.persisted;
      }
      if (!outage) {
        // 그 항목만의 실패 — 형식 오류·입력 초과·요청 거절, 그리고 한 번의 진짜 시간 초과(세 번까지). 429 는 항목 탓이 아니라 세지 않는다
        failed += 1;
        await recordAuditResult({ ...call, ok: false, error: code, counted: code !== "qwen_http_429" }, lease);
        ctx.log("product_audit.call_failed", { campaign: campaign.id, itemId: item.id, error: code, latencyMs: Date.now() - callStartedAt.getTime() });
        continue;
      }
      await recordAuditResult({ ...call, ok: false, error: code, counted: !neverItemFailure(code) && healthy }, lease);
      return;
    }
  }));

  ctx.log("product_audit.reviewed", { campaign: campaign.id, reviewed, failed, noSource, concurrency, stopped, timeouts, cutoff,
    latency: latencyStats(latencies) });
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  if (endpoint) {
    ctx.log("product_audit.endpoint_error", { campaign: campaign.id, failures: qwenEndpoint.failures, waitMs: Math.max(0, qwenEndpoint.retryAt - Date.now()) });
    throw new Error(`product_audit_endpoint_error:${endpoint}`);
  }
  if (reviewed > 0) await noteQwenEndpointSuccess(lastAnsweredStartAt);
  return { done: false };
}
