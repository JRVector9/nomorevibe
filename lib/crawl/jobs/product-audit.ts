import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { assertCliModelAdmission } from "@/lib/llm/cli-capacity-admission";
import { backgroundCliPath } from "@/lib/llm/cli-model-capacity";
import { reportProviderOutcome } from "@/lib/llm/provider-circuit-breaker";
import { auditCliModelCapacity } from "@/lib/crawl/product-audit-model-capacity";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates } from "@/lib/crawl/agent-review-repository";
import { reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "@/lib/crawl/agent-review-gateway";
import { finishAuditCampaign, loadAuditInput, markAuditNoSource, pendingAuditItems, recordAuditResult,
  runningAuditCampaign } from "@/lib/crawl/product-audit";
import { sweepAuditHolds } from "@/lib/crawl/product-audit-hold";
import { runQwenSecondOpinions } from "@/lib/crawl/audit-second-opinion-auto";
import { auditReviewer, QWEN_AUDIT_PROVIDER, sameAuditReviewer, type AuditReviewer } from "@/lib/crawl/product-audit-reviewer";
import { qwenDirectConfig, qwenEndpointFailure, QwenDirectError, reviewWithQwenDirect, QWEN_V2_PROMPT_VERSION,
  type QwenDirectErrorCode, type QwenDirectReview } from "@/lib/crawl/qwen-direct-review";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { ProductAuditCampaign } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { qwenBackoffMs, qwenEndpointBackoff, resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";

/**
 * 틱의 길이와 새 호출을 시작할 여유.
 *
 * 같은 reviewer 워커에서 차례로 돌므로 한 번의 정상 gateway 호출(60초)과 기록 여유만 둔다.
 * 실측(2026-10-15, 같은 모델·동시성4) 정상 응답이 29.7~36.3초라 이전 24초 틱은 답을 잘랐다.
 * 다음 호출의 전체 제한 시간과 저장 여유가 없으면 다음 요청으로 넘겨 시도 횟수를 보존한다.
 */
const TICK_MS = 65_000;
const WRITE_MARGIN_MS = 2_000;
/** 설정(reviewConcurrency)의 상한과 같다. 1차 심사 잡의 안전망과 같은 값이다 */
const MAX_CONCURRENT_REVIEWS = 16;
/** 항목이 아니라 심사자 쪽이 없는 실패 — 이 틱을 멈추고 잡을 실패로 남겨 운영센터에 드러낸다 */
const REVIEWER_DOWN = new Set(["not_configured", "auth", "missing_cli", "model_unavailable"]);

/**
 * 발행분 감사. 진행 중인 감사에서 아직 답을 못 받은 제품을 1차 심사 글로 묻고 결과를 적는다.
 *
 * crawl_candidates.state 도 products.status 도 쓰지 않는다 — 내리는 것은 사람이 /admin/audit 에서 한 건씩 누른다.
 * 확신 높은 거부만 사람이 볼 때까지 공개 목록에서 뺀다(감사 보류): 답을 적는 커밋에서, 그리고 틱마다 먼저 밀린 것을 조금씩 쓴다.
 * 쓸기는 모델을 부르지 않으므로 감사가 끝났거나 수집이 꺼져 있어도 돈다 — 스위치는 감사 보류 하나다(product-audit-hold.ts).
 */
export async function auditPublishedProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  await sweepAuditHolds(ctx, settings.auditHold);
  /*
   * Qwen-v2 단계(감사 두 번째 의견·공개분 2차 거르기, audit-second-opinion-auto.ts)는 감사 묻기와 나란히 돈다 — gpu3090 에 바로 한 번에
   * 한 호출이라 게이트웨이 자리를 쓰지 않고, 새 호출은 30초 안에만 시작해 틱(예산 70초)을 늘리지 않는다. 앞에 두면 감사 묻기가
   * 60초 호출을 시작할 여유(TICK_MS)를 잃고, 뒤에 두면 감사가 도는 동안 영영 차례가 오지 않는다. 이 단계는 잡을 실패시키지 않는다.
   * gpu3090 동시 호출의 끝(qwen-endpoint-backoff.ts): 감사 Qwen 직접 심사의 자리(qwenAuditConcurrency, 기본 2·최대 4) + 두 번째 자리 1.
   * 두 번째 자리는 이 단계(두 번째 의견·공개분 거르기)와 2차 잡의 갈림 판가름이 프로세스 안에서 나눠 쓴다 — 두 잡이 겹쳐 돌아도 기본 3·최대 5.
   * 감사는 틱 내내(65초) 자리를 다 쓰고 이 단계는 30초만 쓴다. 누가 서버 탈을 만나든 모두 함께 물러난다.
   * 감사 묻기가 끝나도(실패해도) 단계가 끝날 때까지 기다린 뒤 틱을 닫는다 — 쓰기가 lease 를 놓은 뒤에 남지 않게.
   */
  const opinions = runQwenSecondOpinions(ctx, settings);
  try {
    return await askAuditCampaign(ctx, settings);
  } finally {
    await opinions;
  }
}

/** 진행 중인 감사에서 아직 답을 못 받은 제품을 묻는다 */
async function askAuditCampaign(ctx: JobContext<null>, settings: CrawlSettings): Promise<JobOutcome<null>> {
  // 쓸기에 쓴 시간은 틱에서 빼지 않는다(쓸기는 SWEEP_MS 안이고, 러너 예산 70초가 바깥 상한이다)
  const startedAt = Date.now();
  const campaign = await runningAuditCampaign();
  if (!campaign) return { done: true };
  // 수집 스위치는 비상 정지다. 이것을 끄면 발행 문이 멈추는데, 감사가 계속 돌면 끈 순간 그 빈
  // 자리를 감사가 다 차지해 공유 게이트웨이에 오히려 더 많이 보낸다
  if (!settings.enabled) {
    ctx.log("product_audit.skipped", { reason: "disabled", campaign: campaign.id });
    return { done: true };
  }
  // 감사는 시작할 때 굳힌 글로만 묻는다. 배포로 글이 바뀌면 사람이 중단하고 새로 연다 — 자동으로
  // 다시 보지 않는다(글이 한 줄 바뀔 때마다 10,751건을 다시 부르지 않기로 했다)
  if (campaign.promptVersion !== REVIEW_PROMPT_VERSION || campaign.rulesVersion !== REVIEW_RULES_VERSION) {
    ctx.log("product_audit.skipped", { reason: "policy_changed", campaign: campaign.id });
    return { done: true };
  }
  /*
   * 먼저 양보한다. 발행 문에 한 번도 심사받지 않은 새 후보가 하나라도 있으면 이 틱은 쉰다.
   *
   * 새 후보는 심사를 받아야 공개되고, 공개분은 이미 떠 있다 — 기다려서 잃는 쪽이 새 후보다.
   * 같은 워커에서 차례로 돌므로 둘이 게이트웨이에 겹쳐 보내는 일은 없다 — 동시 호출은 늘
   * settings.reviewConcurrency 이하다(4 → 성공 94%, 6 → 87% 실측).
   *
   * "기다리는 후보가 하나라도 있으면"으로 두었을 때는 감사가 영영 돌지 않았다. 2026-09-18 프로드에서
   * 문은 여덟 번 모두 100건으로 찼고, 전부 이미 심사받은 보류 건이 24시간마다 다시 도는 것이었다
   * (새 후보 0건). 그 재심사에 양보할 이유는 없다 — observe 에서는 결과가 반영되지도 않는다.
   */
  if ((await listReviewCandidates(settings, 1, { unreviewedOnly: true })).length) {
    ctx.log("product_audit.yielded", { campaign: campaign.id });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("product audit requires a valid worker job lease");
  // 누가 볼지는 감사 행에 적혀 있다 — 남은 감사 모델 바꾸기(0112) 뒤면 바꾼 심사자다. Qwen 직접 심사는 따로 돈다(아래 auditWithQwen)
  const reviewer = auditReviewer(campaign);
  if (reviewer.provider === QWEN_AUDIT_PROVIDER) return auditWithQwen(ctx, { campaign, reviewer, settings, startedAt, lease });
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const queue = await pendingAuditItems(campaign.id, concurrency * 4);
  if (!queue.length) {
    if (await finishAuditCampaign(campaign.id, ctx.lease)) ctx.log("product_audit.finished", { campaign: campaign.id });
    return { done: true };
  }
  const deadlineAt = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity);
  const remaining = () => deadlineAt - Date.now();
  // 1차 심사자 설정을 바꿔도 감사는 따라가지 않는다 — 감사 행의 심사자(reviewer)로만 묻는다
  const ceiling = reviewer.provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  let reviewed = 0, failed = 0, noSource = 0;
  let down: string | null = null;
  // 한 자리가 공통 모델 슬롯에서 미뤄지면 다른 자리도 새 호출을 시작하지 않는다 — 이미 시작한 호출은 끝까지 기다린다
  let deferred = false;
  const canStart = () => !down && !deferred && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= ceiling + WRITE_MARGIN_MS;

  // 자리마다 다음 것을 집어 묻는다. 한 호출이 실패해도 그 자리는 다음 것으로 넘어간다
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!canStart()) return;
      const input = await loadAuditInput(item.slug, settings);
      // 원본 조회도 예산을 쓴다 — 짧아진 제한 시간으로 새 호출을 시작하지 않는다.
      if (!canStart()) return;
      if (!input) {
        noSource += 1;
        await markAuditNoSource(item.id, lease);
        continue;
      }
      // open·draining 이면 부르지 않고 미룬다 — 감사 시도 행을 넣지 않으므로 시도 횟수·재시도 시각이 그대로다.
      // Claude CLI 는 계약이 있으면 공통 슬롯을 얻어 부른다. 게이트웨이(abcllm)는 native 종료 근거가 없어 open 이면 늘 미룬다
      let capacity: "legacy" | "native" = "legacy";
      try {
        if (reviewer.provider === "abcllm") await assertCliModelAdmission({ routeId: "product-audit", provider: "abcllm", model: reviewer.model });
        else capacity = await backgroundCliPath("product-audit", reviewer.model);
      } catch (error) {
        if (error instanceof ModelCapacityDeferredError) deferred = true;
        throw error;
      }
      const callStartedAt = new Date();
      const controller = new AbortController();
      // 슬롯을 얻은 뒤 띄우기 직전에 이 자리의 시작 조건을 다시 본다
      const native = capacity === "native"
        ? auditCliModelCapacity({ campaign: { ...campaign, ...reviewer }, item, input, lease, beforeSpawn: () => canStart() && !controller.signal.aborted }) : null;
      const abort = () => controller.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      const ownershipPoll = setInterval(() => { if (!ctx.hasBudget() || remaining() <= 0) controller.abort(); }, 250);
      ownershipPoll.unref?.();
      let result;
      try {
        if (!canStart()) controller.abort();
        const options = { model: reviewer.model, timeoutMs: ceiling, signal: controller.signal };
        result = reviewer.provider === "abcllm"
          ? await reviewWithGateway(input, options)
          : await reviewWithAgent(input, native ? { ...options, run: native.run } : options);
      } finally {
        clearInterval(ownershipPoll);
        ctx.signal?.removeEventListener("abort", abort);
      }
      // 슬롯 미룸은 다른 자리의 새 시작도 멈춘다. 건너뜀·띄우지 않음은 parser 에 cancelled 로 보여 아래에서 기록 없이 끝난다
      try { native?.settled(); } catch (error) {
        if (error instanceof ModelCapacityDeferredError) deferred = true;
        throw error;
      }
      // 멈추라고 해서 끊긴 것은 실패가 아니다 — 다음 회차가 처음부터 본다
      if (controller.signal.aborted || ctx.signal?.aborted || !ctx.hasBudget() || remaining() <= 0
        || (!result.ok && result.error === "cancelled")) return;
      // 게이트웨이 감사는 전송 단계(observeProviderTransport)가 이미 알린다 — 두 번 세지 않게 CLI 결과만
      if (reviewer.provider !== "abcllm") reportProviderOutcome(result);
      const call = { itemId: item.id, startedAt: callStartedAt, provider: reviewer.provider, model: reviewer.model,
        promptVersion: campaign.promptVersion, input };
      if (result.ok) {
        reviewed += 1;
        await recordAuditResult({ ...call, ok: true, outcome: result.outcome }, lease, settings.auditHold);
        continue;
      }
      const reviewerDown = REVIEWER_DOWN.has(result.error);
      if (reviewerDown) down = result.error;
      else failed += 1;
      await recordAuditResult({ ...call, ok: false, error: result.error, counted: !reviewerDown }, lease);
    }
  }));

  ctx.log("product_audit.reviewed", { campaign: campaign.id, reviewed, failed, noSource });
  const failures = settled.filter((result) => result.status === "rejected");
  const failure = failures.find((result) => !(result.reason instanceof ModelCapacityDeferredError));
  if (failure) throw failure.reason;
  if (down) throw new Error(`product_audit_reviewer_unavailable:${down}`);
  // 슬롯에서 미뤘다 — 러너가 잠금만 놓고 요청·커서·기록은 그대로 둔다
  if (failures.length) throw failures[0].reason;
  return { done: false };
}

// ─────────────────────────── Qwen 직접 심사(남은 감사 모델 바꾸기 뒤) ───────────────────────────

/** 한 호출의 제한 시간 — 실측(2026-10-21 50건) 2.2~4.7초의 다섯 배쯤. 이보다 오래 걸리면 서버가 붐비거나 탈 난 것이라 물러난다 */
const QWEN_CALL_TIMEOUT_MS = 20_000;
/**
 * 새 호출을 시작할 여유. 게이트웨이 길은 한 호출의 전체 제한 시간(60초)이 남아야 시작해 틱 하나에 자리마다 한 건이었다.
 * Qwen 은 몇 초면 끝나므로 이만큼만 남아도 시작하고, 틱 끝에 걸린 호출은 끊는다 — 끊긴 호출은 적지 않아 시도를 쓰지 않는다
 */
const QWEN_MIN_START_MS = 6_000;
/** 감사 중단·모델 바꿈·수집 스위치를 틱 도중에 다시 보는 간격 — 호출마다 보면 한 틱에 수십 번 설정을 읽는다 */
const QWEN_CONTROL_CHECK_MS = 5_000;
/** 한 번에 읽어 둘 일감 — 자리마다 틱 하나(65초)에 3초씩 스무 건 남짓이라 넉넉히 */
const QWEN_QUEUE_PER_SLOT = 40;
export const QWEN_AUDIT_DEFAULT_CONCURRENCY = 2;
export const QWEN_AUDIT_MAX_CONCURRENCY = 4;

/** 동시 호출 수 — AUDIT_QWEN_CONCURRENCY(기본 2, 최대 4). 1차 심사의 reviewConcurrency(공유 게이트웨이 몫)와 따로다 */
export function qwenAuditConcurrency(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.AUDIT_QWEN_CONCURRENCY?.trim() || Number.NaN);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, QWEN_AUDIT_MAX_CONCURRENCY) : QWEN_AUDIT_DEFAULT_CONCURRENCY;
}

/** 부르는 곳이 탈 났을 때 물러나는 시간 — 1분에서 두 배씩, 15분까지. 한 틱에서라도 답을 받으면 처음부터 센다 */
export const qwenAuditBackoffMs = qwenBackoffMs;

/**
 * 부르는 곳이 연달아 탈 난 틱 수와 다시 물어볼 시각 — gpu3090 을 부르는 모든 쪽(두 번째 의견·공개분 거르기·갈림 판가름)과 함께 쓴다
 * (qwen-endpoint-backoff.ts). 누가 탈을 만나든 감사도 물러나고, 감사가 탈을 만나면 다른 쪽도 물러난다
 */
const qwenEndpoint = qwenEndpointBackoff;
export { resetQwenAuditBackoff };

/** 항목 탓일 수 없는 탈 — 닿지 않음·설정·키·모델 없음. 시도로 세지 않는다 */
const neverItemFailure = (code: QwenDirectErrorCode) =>
  code === "qwen_unreachable" || code === "qwen_not_configured" || /^qwen_http_(401|403|404)$/.test(code);

/**
 * Qwen 직접 심사로 묻는 감사의 틱(0112) — gpu3090 vLLM 을 게이트웨이 없이 부른다(qwen-direct-review.ts). 게이트웨이 길과 다른 것:
 *  - 자리 수는 qwenAuditConcurrency(기본 2, 최대 4). 공통 모델 슬롯을 거치지 않는다 — 게이트웨이도 Claude CLI 도 아니다.
 *  - 틱(TICK_MS, 러너 예산 70초 안)이 끝날 때까지 자리마다 다음 것을 잇달아 묻는다. 남은 시간이 QWEN_MIN_START_MS 보다 적으면 새로
 *    시작하지 않고, 틱 끝에 걸린 호출은 끊는다(적지 않는다 — 다음 틱이 처음부터 본다).
 *  - 감사 중단·모델 바꿈·수집 스위치를 QWEN_CONTROL_CHECK_MS 마다 다시 보고, 바뀌었으면 새 호출을 멈춘다(이미 띄운 호출의 답은 적는다).
 *  - 부르는 곳의 탈(qwenEndpointFailure — 제한 시간·닿지 않음·401/403/404/429/5xx): 이 틱의 새 호출을 멈추고 잡을 실패로 남기며
 *    (운영센터에 드러난다) 1분·2분·4분…15분 동안 묻지 않는다. 그동안의 틱도 실패로 남긴다 — 감사가 서 있는 것이 보이게.
 *    시도로는 Qwen 이 멀쩡하던 중(틱에 들어올 때 연속 탈이 없었거나 이 틱에 이미 답을 받았다)에 난 제한 시간·429·5xx 만 센다 —
 *    한 항목이 늘 서버를 넘어뜨리면 세 번이면 끝나고, 서버가 오래 죽어 있어도 남은 항목의 시도가 닳지 않는다.
 *    닿지 않음·설정·키·모델 없음은 항목 탓일 수 없어 세지 않는다. 형식 오류·입력 초과·400 대 요청 거절은 그 항목의 실패로 센다.
 * DB 트랜잭션 안에서 부르지 않는다 — 원본을 읽고(loadAuditInput), 밖에서 묻고, 답을 적는 트랜잭션(recordAuditResult)을 따로 연다.
 */
async function auditWithQwen(ctx: JobContext<null>, value: { campaign: ProductAuditCampaign; reviewer: AuditReviewer; settings: CrawlSettings;
  startedAt: number; lease: JobLease }): Promise<JobOutcome<null>> {
  const { campaign, reviewer, settings, startedAt, lease } = value;
  if (qwenEndpoint.retryAt > Date.now()) {
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
  // 저장 여유를 남긴 틱 끝 — 여기에 걸린 호출은 끊는다
  const deadlineAt = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity) - WRITE_MARGIN_MS;
  const remaining = () => deadlineAt - Date.now();
  const healthyAtStart = qwenEndpoint.failures === 0;
  let reviewed = 0, failed = 0, noSource = 0;
  let endpoint: QwenDirectErrorCode | null = null;
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
  const canStart = () => !endpoint && !stopped && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= QWEN_MIN_START_MS;

  const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!canStart()) return;
      await recheck();
      if (!canStart()) return;
      const input = await loadAuditInput(item.slug, settings);
      if (!canStart()) return;
      if (!input) {
        noSource += 1;
        await markAuditNoSource(item.id, lease);
        continue;
      }
      const callStartedAt = new Date();
      const controller = new AbortController();
      const abort = () => controller.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      const ownershipPoll = setInterval(() => { if (!ctx.hasBudget() || remaining() <= 0) controller.abort(); }, 250);
      ownershipPoll.unref?.();
      let review: QwenDirectReview | null = null;
      let error: QwenDirectErrorCode | null = null;
      try {
        review = await reviewWithQwenDirect(input, { timeoutMs: QWEN_CALL_TIMEOUT_MS, signal: controller.signal, env });
      } catch (caught) {
        if (!(caught instanceof QwenDirectError)) throw caught;
        error = caught.code;
      } finally {
        clearInterval(ownershipPoll);
        ctx.signal?.removeEventListener("abort", abort);
      }
      // 멈추라고 해서 끊긴 것은 실패가 아니다 — 적지 않는다
      if (controller.signal.aborted || ctx.signal?.aborted || !ctx.hasBudget() || error === "qwen_cancelled") return;
      const call = { itemId: item.id, startedAt: callStartedAt, provider: reviewer.provider, model: review?.model ?? reviewer.model,
        promptVersion: review?.promptVersion ?? QWEN_V2_PROMPT_VERSION, input };
      if (review) {
        reviewed += 1;
        await recordAuditResult({ ...call, ok: true, outcome: review.outcome }, lease, settings.auditHold);
        continue;
      }
      const code = error ?? "qwen_unreachable";
      if (!qwenEndpointFailure(code)) {
        failed += 1;
        await recordAuditResult({ ...call, ok: false, error: code, counted: true }, lease);
        continue;
      }
      endpoint ??= code;
      await recordAuditResult({ ...call, ok: false, error: code, counted: !neverItemFailure(code) && (healthyAtStart || reviewed > 0) }, lease);
      return;
    }
  }));

  ctx.log("product_audit.reviewed", { campaign: campaign.id, reviewed, failed, noSource, concurrency, stopped });
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  if (endpoint) {
    qwenEndpoint.failures = reviewed > 0 ? 1 : qwenEndpoint.failures + 1;
    const waitMs = qwenAuditBackoffMs(qwenEndpoint.failures);
    qwenEndpoint.retryAt = Date.now() + waitMs;
    qwenEndpoint.lastError = endpoint;
    ctx.log("product_audit.endpoint_error", { campaign: campaign.id, failures: qwenEndpoint.failures, waitMs });
    throw new Error(`product_audit_endpoint_error:${endpoint}`);
  }
  if (reviewed > 0) resetQwenAuditBackoff();
  return { done: false };
}
