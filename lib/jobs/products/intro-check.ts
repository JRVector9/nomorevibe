import { configuredModelDefinition, scopedModel } from "@/lib/llm/model-registry";
import type { ReviewCliRun } from "@/lib/crawl/agent-review";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { backgroundCliPath } from "@/lib/llm/cli-model-capacity";
import { reportProviderOutcome } from "@/lib/llm/provider-circuit-breaker";
import { checkIntros, INTRO_CHECK_BATCH, INTRO_CHECK_MODEL, introEvidence } from "@/lib/domain/products/intro-check";
import { checkIntrosWithModelCapacity } from "@/lib/domain/products/intro-check-model-capacity";
import { pendingIntroChecks, recordIntroCheck, type IntroCheckRecord } from "@/lib/domain/products/intro-checks";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/**
 * 소개 검수 — 주인 없는 수집 제품의 AI 소개와 쓸모없어 보이는 메이커 소개를 선택된 모델이 근거와 대조한다
 * (intro-check.ts). 틀리거나 쓸모없으면 고쳐 쓴 줄로 바꾸고, 알 수 없으면 관리자가 본다.
 *
 * reviewer 워커에서 돈다 — 구독 토큰(claude-cli) 또는 설정된 local-direct CLI 가 거기에만 있다. 키워드 검수(동시 2)·2차 심사와 한도를
 * 같이 쓰므로 한 번에 하나만 부른다. 처음 쌓인 약 970건은 30분쯤이면 끝나고, 그 뒤로는 새로 발행되는 것만 온다.
 */

const JOB = "product-intro-check";
/**
 * 한도는 틱마다 runtime_settings jobs.product-intro-check 에서 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * callMs 90초(한 번(10건)에 둘 시간 — 표본에서 평소 13초. CLI 호출에 직접 주는 상한이며 등록부 경로 상한이 아니다 —
 * scopedRequestTimeout 이 단계 모델 범위 안에서는 등록부 상한과의 최솟값을 쓴다), minCallMs 40초(이만큼 남아 있을 때만 새로 부른다).
 * 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 */
/** 제품 탓이 아닌 실패 — 이번 틱을 접는다. 한도에 걸린 것은 30분 쉬게 적힌다(recordIntroCheck) */
const STOP = new Set(["rate_limited", "auth", "missing_cli", "not_configured", "timeout", "cli_error", "budget", "cancelled"]);

export async function checkProductIntros(ctx: JobContext<null>, run?: ReviewCliRun): Promise<JobOutcome<null>> {
  const lease = ctx.lease;
  if (!lease) throw new Error("Intro check requires a job lease");
  const startedAt = Date.now();
  const remaining = tickRemaining(ctx, JOB, startedAt);
  const knobs = runtimeSettings();
  const callMs = jobKnob(knobs, JOB, "callMs"), minCallMs = jobKnob(knobs, JOB, "minCallMs");
  const counts = { kept: 0, replaced: 0, needs_editor: 0, failed: 0 };

  while (ctx.hasBudget() && !ctx.signal?.aborted && remaining() >= minCallMs) {
    const tasks = await pendingIntroChecks(INTRO_CHECK_BATCH);
    if (tasks.length === 0) {
      ctx.log("intro_check.done", { ...counts, drained: true });
      return { done: true };
    }
    // 등록부의 단계 선택을 그대로 따른다 — cliEngine(local-direct)이 있으면 그 모델로 원격 CLI 를 부르고,
    // 없으면 기존 공통 슬롯/Claude 경로를 쓴다. CLI 는 legacy checkIntros 로 떨어지지 않는다.
    const definition = configuredModelDefinition(JOB);
    const cliEngine = definition.cliEngine;
    const selectedModel = cliEngine ? definition.model : scopedModel("product-intro-check", INTRO_CHECK_MODEL);
    const capacity = await backgroundCliPath("product-intro-check", selectedModel, cliEngine ? "opencode-cli" : undefined, cliEngine?.connectionId);
    const items = tasks.map((task) => ({ slug: task.product.slug, intro: task.product.tagline, evidence: introEvidence(task.product) }));
    const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
    const native = (capacity === "native" || cliEngine) ? await checkIntrosWithModelCapacity(tasks, items, lease, { timeoutMs, signal: ctx.signal,
      // 슬롯을 얻은 뒤 띄우기 직전에 이 틱의 여유를 다시 본다(루프 조건과 같다)
      beforeSpawn: () => ctx.hasBudget() && !ctx.signal?.aborted && remaining() >= minCallMs }) : null;
    // 그사이 묶음이 바뀌었거나 여유가 모자라 띄우지 않았다 — 적지 않고 이 틱을 접는다
    if (native && native.kind !== "result") {
      ctx.log("intro_check.not_started", { ...counts, skipped: native.kind === "skipped" });
      return { done: false };
    }
    const result = native ? native.result : await checkIntros(items, { timeoutMs, run, signal: ctx.signal });
    for (const task of tasks) {
      const judgement = result.ok ? result.judgements.get(task.product.slug) : undefined;
      // 답이 빠진 제품은 실패로 적는다 — 다음에 다시 본다
      const outcome: IntroCheckRecord = judgement ? { kind: "success", judgement, model: selectedModel }
        : { kind: "failure", error: result.ok ? "missing_result" : result.error };
      const recorded = await recordIntroCheck(task, lease, outcome);
      if (recorded) counts[recorded]++;
    }
    reportProviderOutcome(result);
    if (!result.ok && STOP.has(result.error)) {
      ctx.log("intro_check.blocked", { ...counts, error: result.error });
      // 멈추라는 신호(cancelled)는 배포·종료다. 그 밖(인증·CLI 없음·한도·시간 초과)은 성공이 아니다 — 소개 검수가 일을 못 했다
      return result.error === "cancelled" ? { done: true }
        : { done: true, degraded: { code: result.error, detail: `소개 검수 ${selectedModel} 호출 실패` } };
    }
  }
  ctx.log("intro_check.done", { ...counts, drained: false });
  return { done: false };
}
