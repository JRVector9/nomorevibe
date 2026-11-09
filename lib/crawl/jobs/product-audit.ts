import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { assertCliModelAdmission } from "@/lib/llm/cli-capacity-admission";
import { backgroundCliPath } from "@/lib/llm/cli-model-capacity";
import { reportProviderOutcome } from "@/lib/llm/provider-circuit-breaker";
import { auditCliModelCapacity, reviewAuditWithRemoteCliModelCapacity } from "@/lib/crawl/product-audit-model-capacity";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { reviewCliTimeoutMs, reviewWithAgent, type AgentReviewResult } from "@/lib/crawl/agent-review";
import { reviewGatewayTimeoutMs, reviewWithGateway } from "@/lib/crawl/agent-review-gateway";
import { finishAuditCampaign, loadAuditInput, markAuditInputFailed, markAuditNoSource, pendingAuditItems, recordAuditResult,
  runningAuditCampaign } from "@/lib/crawl/product-audit";
import { sweepAuditHolds } from "@/lib/crawl/product-audit-hold";
import { auditReviewer, QWEN_AUDIT_PROVIDER, type AuditReviewer } from "@/lib/crawl/product-audit-reviewer";
import { firstReviewHasWork, oldestPendingRecheckHours, recheckLimits, recheckReviewerPlan, rollingStream } from "@/lib/crawl/published-recheck";
import { ensureAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { ProductAuditCampaign } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { JobLeaseLostError } from "@/lib/jobs/lease";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import type { CliEngineSource } from "@/lib/llm/cli-engine-config";

/**
 * 틱의 길이와 새 호출을 시작할 여유.
 *
 * 같은 reviewer 워커에서 차례로 돌므로 한 번의 정상 gateway 호출(60초)과 기록 여유만 둔다.
 * 실측(2026-10-15, 같은 모델·동시성4) 정상 응답이 29.7~36.3초라 이전 24초 틱은 답을 잘랐다.
 * 다음 호출의 전체 제한 시간과 저장 여유가 없으면 다음 요청으로 넘겨 시도 횟수를 보존한다.
 */
export const AUDIT_TICK_MS = 65_000;
export const AUDIT_WRITE_MARGIN_MS = 2_000;
const TICK_MS = AUDIT_TICK_MS;
const WRITE_MARGIN_MS = AUDIT_WRITE_MARGIN_MS;
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
 *
 * 2026-10-31(PR 3a-C) 전에는 이 틱이 보류 쓸기 + 게이트웨이/CLI 감사 + Qwen 직접 감사(gpu3090) + 두 번째 의견·공개분 거르기(gpu3090)를
 * 한 잡에서 돌렸다 — 한 장비의 느림·서버 탈이 다른 장비의 큐·쓸기의 틱을 미루고 실패로 남겼다. 이제 Qwen 직접 감사는 audit-qwen
 * (jobs/audit-qwen.ts), 두 번째 의견·공개분 거르기는 audit-second-opinion(jobs/audit-second-opinion.ts) 잡·줄이다. 이 잡은 보류 쓸기와
 * 게이트웨이/CLI 감사만 한다 — 감사 행의 심사자가 qwen-direct 면 쓸기만 하고 묻기는 audit-qwen 에 맡긴다. 1차 후보 큐를 보고 양보하지 않는다(3a-B, 아래).
 * 운영 주의: PIPELINE_BACKGROUND_CONSUMER_JOBS 에 product-audit 을 넣으면 이 잡(쓸기·게이트웨이/CLI 감사)이 배경 consumer 줄에서만 돌고, 그 줄은
 * 공통 모델 슬롯이 open 일 때만 돈다(scripts/worker.ts runConsumerLane) — 쓸기도 함께 멈추니 slot 모드가 open 이 아니면 넣지 않는다.
 * audit-qwen·audit-second-opinion 은 공통 슬롯을 쓰지 않아 그 목록에 들지 않는다(lib/jobs/background-consumer.ts).
 * 2026-11-09(0171): 공개분 변경 재판정의 늘 열린 줄도 이 잡이 묻는다(askRecheckStream) — 장부 binding 의 job.name 이 product-audit 이어야 감사 경로
 * (product_audit_cli)를 새 binding 없이 쓸 수 있다. 모델은 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정 순위다. 올리기(견주기)는 자기 잡 published-recheck 가 한다.
 */
export async function auditPublishedProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  await sweepAuditHolds(ctx, settings.auditHold, { autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled });
  // 공개분 변경 재판정(0171)의 항목을 먼저 조금(askBatch) 묻는다 — 하루 수십 건이라 사람이 연 감사의 틱을 거의 쓰지 않는다
  await askRecheckStreamSafely(ctx, settings);
  return askAuditCampaign(ctx, settings);
}

/**
 * 재판정 갈래는 사람이 연 감사의 틱을 바꾸지 않는다 — 그 갈래의 실패(읽기·기록·호출 오류)는 로그로만 남기고 감사 묻기로 넘어간다.
 * 작업 lease 를 잃었거나 DR writer fence 에 막혔으면 이 틱 전체가 더 쓰면 안 되므로 그대로 던진다
 */
async function askRecheckStreamSafely(ctx: JobContext<null>, settings: CrawlSettings): Promise<void> {
  try { await askRecheckStream(ctx, settings); }
  catch (error) {
    if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
    ctx.log("published_recheck.failed", { error: error instanceof ModelCapacityDeferredError ? `deferred:${error.reason}`
      : error instanceof Error && /^[a-z0-9_:.-]{1,80}$/.test(error.message) ? error.message : "error" });
  }
}

/** 한 호출의 재료 — 감사 행(또는 재판정 줄)·묻는 심사자·원격 OpenCode 연결(없으면 Claude CLI·게이트웨이)·호출 상한 */
type AuditAsk = { campaign: Pick<ProductAuditCampaign, "id" | "provider" | "model" | "promptVersion" | "rulesVersion">; reviewer: AuditReviewer;
  cliEngine: CliEngineSource | null; ceiling: number };
/**
 * 한 항목을 한 번 묻는다 — 사람이 연 감사(askAuditCampaign)와 공개분 변경 재판정(askRecheckStream)가 같은 길을 쓴다. 감사 경로(product-audit)의
 * 장부 binding(product_audit_cli)·게이트웨이 입장이다. 슬롯 확인에서 이 항목만의 미룸이면 passed(다음 항목), 끊겼거나 건너뛰었으면 cut(기록하지 않고
 * 이 자리를 끝낸다). 모델·전역 미룸은 던진다. 결과는 기록하지 않는다 — 부르는 쪽이 recordAuditResult 로 적는다.
 */
async function callAuditReviewer(ctx: JobContext<null>, lease: JobLease, ask: AuditAsk, item: { id: number; slug: string }, input: ReviewInput,
  canStart: () => boolean, remaining: () => number): Promise<{ kind: "passed"; reason: string } | { kind: "cut" } | { kind: "result"; result: AgentReviewResult }> {
  const { campaign, reviewer, cliEngine, ceiling } = ask;
  const remoteRequested = Boolean(cliEngine);
  // open·draining 이면 부르지 않고 미룬다 — 감사 시도 행을 넣지 않으므로 시도 횟수·재시도 시각이 그대로다.
  // Claude CLI 는 계약이 있으면 공통 슬롯을 얻어 부른다. 게이트웨이(abcllm)는 native 종료 근거가 없어 open 이면 늘 미룬다
  let capacity: "legacy" | "native" | "remote" = "legacy";
  try {
    if (remoteRequested) {
      await backgroundCliPath("product-audit", reviewer.model, "opencode-cli", cliEngine?.connectionId);
      capacity = "remote";
    } else if (reviewer.provider === "abcllm") await assertCliModelAdmission({ routeId: "product-audit", provider: "abcllm", model: reviewer.model });
    else capacity = await backgroundCliPath("product-audit", reviewer.model);
  } catch (error) {
    // 이 항목만의 미룸(같은 항목이 다른 요청에 묶임·앞선 호출이 보내진 중·장부 세대 어긋남) — 항목 하나를 넘기고 이 자리는 다음 항목을 본다
    if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerWork(error.reason)) return { kind: "passed", reason: error.reason };
    // 모델·전역 미룸 — 이 자리만 새 호출을 멈춘다(부르는 쪽이 모은다). 다른 자리의 새 시작을 세우지 않는다
    throw error;
  }
  const controller = new AbortController();
  // 슬롯을 얻은 뒤 띄우기 직전에 이 자리의 시작 조건을 다시 본다
  const native = capacity === "native"
    ? auditCliModelCapacity({ campaign: { ...campaign, ...reviewer }, item, input, lease, beforeSpawn: () => canStart() && !controller.signal.aborted }) : null;
  if (capacity === "remote" && !cliEngine) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  const remote = capacity === "remote" && cliEngine
    ? () => reviewAuditWithRemoteCliModelCapacity({ campaign: { ...campaign, ...reviewer }, item, input, lease,
        beforeSpawn: () => canStart() && !controller.signal.aborted, source: cliEngine,
        timeoutMs: ceiling, signal: controller.signal }) : null;
  const abort = () => controller.abort();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget() || remaining() <= 0) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  let result: AgentReviewResult;
  try {
    if (!canStart()) controller.abort();
    if (remote) {
      const settledRemote = await remote();
      // 원격 슬롯의 건너뜀·띄우지 않음은 이 자리를 기록 없이 끝낸다
      if (settledRemote.kind !== "result") return { kind: "cut" };
      result = settledRemote.result;
    } else {
      const options = { model: reviewer.model, timeoutMs: ceiling, signal: controller.signal };
      result = reviewer.provider === "abcllm"
        ? await reviewWithGateway(input, options)
        : await reviewWithAgent(input, native ? { ...options, run: native.run } : options);
    }
  } finally {
    clearInterval(ownershipPoll);
    ctx.signal?.removeEventListener("abort", abort);
  }
  // 정산의 미룸은 이 자리만 끝낸다(부르는 쪽이 모은다). 건너뜀·띄우지 않음은 parser 에 cancelled 로 보여 아래에서 기록 없이 끝난다
  native?.settled();
  // 멈추라고 해서 끊긴 것은 실패가 아니다 — 다음 회차가 처음부터 본다
  if (controller.signal.aborted || ctx.signal?.aborted || !ctx.hasBudget() || remaining() <= 0
    || (!result.ok && result.error === "cancelled")) return { kind: "cut" };
  // 게이트웨이 감사는 전송 단계(observeProviderTransport)가 이미 알린다 — 두 번 세지 않게 CLI/원격 결과만
  if (remoteRequested || reviewer.provider !== "abcllm") reportProviderOutcome(result);
  return { kind: "result", result };
}

/**
 * 공개분 변경 재판정(0171, lib/crawl/published-recheck.ts)의 항목을 묻는다 — 감사 잡의 한 갈래(장부 job.name 이 product-audit 이어야 감사 경로의
 * binding 을 쓸 수 있다). 심사자는 재판정 자신의 설정인 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(product-audit) 1·2·3순위다(recheckReviewerPlan —
 * 사람이 연 감사를 시작할 때와 같은 해석, OpenCode·Claude CLI 연결만). 1차 순위와는 나뉜다. 한 순위가 이 틱에 모델·전역 미룸이거나 심사자 쪽 탈이면 다음 순위로 간다.
 * 순위가 없으면 묻지 않는다 — 올리기(published-recheck)만 쌓이고 화면이 그 까닭을 말한다.
 *
 * 1차를 늦추지 않는다: 감사 경로의 요청은 장부의 background 등급이고(1차는 first), 1차 심사 대기에 후보가 있으면 물러난다 — 다만 가장 오래 기다린
 * 재판정 항목이 yieldHours 를 넘으면 함께 묻는다(1차 대기가 늘 차 있는 운영에서 영영 굶지 않게). 한 틱에 askBatch 건까지, 한 번에 하나씩 묻는다.
 * 답은 감사와 같은 길로 적는다(recordAuditResult — 확신 높은 거절은 감사 보류, 답이 곧 그 제품의 새 기준). 실패해도 이 잡을 실패로 남기지 않는다 —
 * 사람이 연 감사와 보류 쓸기를 막지 않게. 멈춘 까닭은 로그(published_recheck.*)와 /admin/audit?tab=recheck 에 보인다.
 */
async function askRecheckStream(ctx: JobContext<null>, settings: CrawlSettings): Promise<void> {
  const limits = recheckLimits();
  if (!settings.enabled || limits.askBatch === 0) return;
  const lease = ctx.lease;
  if (!lease) return;
  const stream = await rollingStream();
  if (!stream) return;
  const queue = await pendingAuditItems(stream.id, limits.askBatch);
  if (!queue.length) return;
  if (limits.yieldHours > 0 && await firstReviewHasWork(settings)) {
    const waited = await oldestPendingRecheckHours(stream.id);
    if (waited === null || waited < limits.yieldHours) {
      ctx.log("published_recheck.yielded", { stream: stream.id, pending: queue.length, waitedHours: waited === null ? null : Math.round(waited * 10) / 10 });
      return;
    }
  }
  await ensureAiTaskModels();
  const plan = recheckReviewerPlan();
  if (!plan.reviewers.length) {
    ctx.log("published_recheck.no_reviewer", { stream: stream.id, status: plan.status, pending: queue.length,
      skipped: plan.skipped.map((row) => `${row.rank}:${row.model}:${row.reason}`).slice(0, 3) });
    return;
  }
  const startedAt = Date.now();
  const deadlineAt = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity);
  const remaining = () => deadlineAt - Date.now();
  const paused = new Set<number>();
  let asked = 0, failed = 0, noSource = 0, passed = 0;
  const deferred: string[] = [];
  // CLI 호출의 상한 — 사람이 연 감사의 CLI 심사자와 같다
  const ceiling = reviewCliTimeoutMs();
  const startable = () => !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= ceiling + WRITE_MARGIN_MS;
  items: for (const item of queue) {
    if (!startable() || plan.reviewers.every((reviewer) => paused.has(reviewer.rank))) break;
    let input: ReviewInput | null;
    try { input = await loadAuditInput(item.slug, settings); }
    catch (caught) {
      failed += 1;
      await markAuditInputFailed(item.id, caught instanceof Error && /^[a-z0-9_]{3,60}$/.test(caught.message) ? caught.message : "input_error", lease);
      continue;
    }
    if (!input) { noSource += 1; await markAuditNoSource(item.id, lease); continue; }
    for (const reviewer of plan.reviewers) {
      if (paused.has(reviewer.rank)) continue;
      if (!startable()) break items;
      const ask: AuditAsk = { campaign: { id: stream.id, provider: reviewer.provider, model: reviewer.model, promptVersion: REVIEW_PROMPT_VERSION,
        rulesVersion: REVIEW_RULES_VERSION }, reviewer: { provider: reviewer.provider, model: reviewer.model },
        // OpenCode 는 순위의 연결(원격 호스트)로, Claude 는 이 워커의 감사 경로 Claude 계약으로(callAuditReviewer)
        cliEngine: reviewer.provider === "opencode-cli"
          ? { connectionId: reviewer.connectionId, ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}) } : null, ceiling };
      let outcome: Awaited<ReturnType<typeof callAuditReviewer>>;
      const callStartedAt = new Date();
      try { outcome = await callAuditReviewer(ctx, lease, ask, item, input, startable, remaining); }
      catch (error) {
        if (!(error instanceof ModelCapacityDeferredError)) throw error;
        // 이 심사자가 감사 경로에서 지금 열리지 않는다(경로 매핑 없음·계약 없음·포화·draining) — 이 틱에는 다음 순위로
        paused.add(reviewer.rank);
        deferred.push(`${reviewer.rank}:${error.reason}`);
        continue;
      }
      if (outcome.kind === "passed") { passed += 1; continue items; }
      if (outcome.kind === "cut") break items;
      const result = outcome.result;
      const call = { itemId: item.id, startedAt: callStartedAt, provider: reviewer.provider, model: reviewer.model, promptVersion: REVIEW_PROMPT_VERSION, input };
      if (result.ok) {
        asked += 1;
        await recordAuditResult({ ...call, ok: true, outcome: result.outcome }, lease, settings.auditHold);
        continue items;
      }
      const reviewerDown = REVIEWER_DOWN.has(result.error);
      await recordAuditResult({ ...call, ok: false, error: result.error, counted: !reviewerDown }, lease);
      if (!reviewerDown) { failed += 1; continue items; }
      // 심사자 쪽이 없다(설정·키·CLI·모델 없음) — 항목 탓이 아니다. 이 틱에는 다음 순위로
      paused.add(reviewer.rank);
      deferred.push(`${reviewer.rank}:${result.error}`);
    }
  }
  ctx.log("published_recheck.asked", { stream: stream.id, asked, failed, noSource, passed, deferred, reviewers: plan.reviewers.map((row) => `${row.rank}:${row.provider}:${row.model}`) });
}

export type AuditCampaignForTick = { campaign: ProductAuditCampaign; reviewer: AuditReviewer; direct: boolean };

/**
 * 이 틱이 물을 수 있는 진행 중 감사 — 감사 잡(product-audit)과 Qwen 직접 감사 잡(audit-qwen)이 같은 관문을 지난다. 없으면 null(로그 prefix 로 까닭을 적는다).
 *  - 진행 중인 감사가 없으면 할 일이 없다.
 *  - 수집 스위치는 비상 정지다. 이것을 끄면 발행 문이 멈추는데, 감사가 계속 돌면 끈 순간 그 빈 자리를 감사가 다 차지해 공유 게이트웨이에 오히려 더 많이 보낸다.
 *  - 감사는 시작할 때 굳힌 글로만 묻는다. 배포로 글이 바뀌면 사람이 중단하고 새로 연다 — 자동으로 다시 보지 않는다(글이 한 줄 바뀔 때마다 10,751건을 다시 부르지 않기로 했다).
 * 누가 볼지는 감사 행에 적혀 있다 — 남은 감사 모델 바꾸기(0112) 뒤면 바꾼 심사자다. direct = qwen-direct(gpu3090, audit-qwen 이 묻는다).
 */
export async function auditCampaignForTick(ctx: JobContext<null>, settings: CrawlSettings, prefix: "product_audit" | "audit_qwen"): Promise<AuditCampaignForTick | null> {
  const campaign = await runningAuditCampaign();
  if (!campaign) return null;
  if (!settings.enabled) {
    ctx.log(`${prefix}.skipped`, { reason: "disabled", campaign: campaign.id });
    return null;
  }
  if (campaign.promptVersion !== REVIEW_PROMPT_VERSION || campaign.rulesVersion !== REVIEW_RULES_VERSION) {
    ctx.log(`${prefix}.skipped`, { reason: "policy_changed", campaign: campaign.id });
    return null;
  }
  const reviewer = auditReviewer(campaign);
  return { campaign, reviewer, direct: reviewer.provider === QWEN_AUDIT_PROVIDER };
}

/** 진행 중인 감사에서 아직 답을 못 받은 제품을 게이트웨이/CLI 심사자로 묻는다 */
async function askAuditCampaign(ctx: JobContext<null>, settings: CrawlSettings): Promise<JobOutcome<null>> {
  // 쓸기에 쓴 시간은 틱에서 빼지 않는다(쓸기는 SWEEP_MS 안이고, 러너 예산 70초가 바깥 상한이다)
  const startedAt = Date.now();
  const current = await auditCampaignForTick(ctx, settings, "product_audit");
  if (!current) return { done: true };
  const { campaign, reviewer, direct } = current;
  /*
   * 다른 단계(1차 심사)의 큐를 보고 양보하지 않는다(2026-10-31, PR 3a-B 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다").
   * 예전에는 발행 문에 한 번도 심사받지 않은 새 후보가 하나라도 있으면 이 틱을 쉬었는데, 2026-10-21 뒤 프로드에서는 새 후보가 늘 있어
   * 틱마다 양보만 하고 한 건도 묻지 않았다(product_audit.yielded). 공유 장비(게이트웨이)에서 1차 심사에 자리를 먼저 주는 일은 장비 순위
   * (PR 1b model_capacity_device_roles: ai1 rank 1, audit rank 2 + secondaryCap·reserve)가 입장 TX 에서 정한다 — 배포 전에 그 행을 둔다.
   */
  // Qwen 직접 심사(gpu3090)는 자기 잡 audit-qwen(jobs/audit-qwen.ts)이 묻는다 — 이 잡은 쓸기까지만
  if (direct) {
    ctx.log("product_audit.skipped", { reason: "qwen_direct", campaign: campaign.id });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("product audit requires a valid worker job lease");
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const queue = await pendingAuditItems(campaign.id, concurrency * 4);
  if (!queue.length) {
    if (await finishAuditCampaign(campaign.id, ctx.lease)) ctx.log("product_audit.finished", { campaign: campaign.id });
    return { done: true };
  }
  const cliEngine = reviewer.provider === campaign.provider && reviewer.model === campaign.model ? campaign.cliSource : null;
  const remoteRequested = Boolean(cliEngine);
  if (reviewer.provider === "opencode-cli" && !cliEngine) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  const deadlineAt = Math.min(startedAt + TICK_MS, ctx.deadlineAt ?? Infinity);
  const remaining = () => deadlineAt - Date.now();
  // 1차 심사자 설정을 바꿔도 감사는 따라가지 않는다 — 감사 행의 심사자(reviewer)로만 묻는다
  const ceiling = !remoteRequested && reviewer.provider === "abcllm" ? reviewGatewayTimeoutMs() : reviewCliTimeoutMs();
  let reviewed = 0, failed = 0, noSource = 0, passed = 0;
  let down: string | null = null;
  // 심사자 쪽이 없는 실패(REVIEWER_DOWN — 설정·키·CLI·모델 없음, 항목 탓일 수 없다)만 모든 자리의 새 호출을 멈춘다. 한 자리의 장부 미룸은
  // 그 자리만 멈춘다(2026-10-31) — 다른 자리는 각자 장부에 묻고 각자 답을 받는다
  const canStart = () => !down && !ctx.signal?.aborted && ctx.hasBudget() && remaining() >= ceiling + WRITE_MARGIN_MS;

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
      const callStartedAt = new Date();
      const outcome = await callAuditReviewer(ctx, lease, { campaign, reviewer, cliEngine, ceiling }, item, input, canStart, remaining);
      if (outcome.kind === "passed") {
        passed += 1;
        ctx.log("product_audit.passed", { campaign: campaign.id, itemId: item.id, reason: outcome.reason });
        continue;
      }
      if (outcome.kind === "cut") return;
      const result = outcome.result;
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

  ctx.log("product_audit.reviewed", { campaign: campaign.id, reviewed, failed, noSource, passed });
  const failures = settled.filter((result) => result.status === "rejected");
  const failure = failures.find((result) => !(result.reason instanceof ModelCapacityDeferredError));
  if (failure) throw failure.reason;
  if (down) throw new Error(`product_audit_reviewer_unavailable:${down}`);
  // 자리가 장부에서 미뤄졌다(모델·전역). 이 틱에 적은 것이 하나도 없으면 미룸으로 끝낸다 — 러너가 잠금만 놓고 요청·커서·기록은 그대로 둔다.
  // 적은 것이 있으면 그 일은 끝난 일이다 — 다음 틱이 이어 본다
  if (failures.length && reviewed + failed + noSource + passed === 0) throw failures[0].reason;
  if (failures.length) ctx.log("product_audit.deferred", { campaign: campaign.id, reason: (failures[0].reason as ModelCapacityDeferredError).reason });
  return { done: false };
}
