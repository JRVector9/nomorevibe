import { modelRequestBudget, modelRouteTimeoutMs, scopedModel } from "@/lib/llm/model-registry";
import { translateKoreanTaglinesWithModelCapacity, type KoreanTaglineCapacityResult } from "@/lib/domain/products/korean-tagline-model-capacity";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { checkKoreanTaglineOutput } from "@/lib/domain/products/korean-tagline";
import { homeListSlugs, pendingKoreanTaglines, pendingKoreanTaglineRecovery, recordKoreanTaglines, koreanTaglineSource as taglineSource, type KoreanTaglineResult, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { translateKoreanTaglinesWithQwen } from "@/lib/crawl/korean-translation-qwen";
import { KOREAN_TRANSLATION_NATIVE_MAX_CHARS,
  KOREAN_TRANSLATION_QWEN_MODEL, koreanTranslationQwenEnabled, koreanTranslationQwenRecoveryEnabled } from "@/lib/crawl/korean-translation-config";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { pendingTextPoolModel } from "@/lib/llm/text-task-pool-resume";

/**
 * 한국어 한 줄 소개 짓기(UX-13) — 공개 제품의 지금 소개를 한국어 한 줄로 옮긴다. 새 제품·홈에 보이는 제품부터, 나머지는 스타 순.
 *
 * legacy text 워커의 한국어 전용 줄에서 단일 잡 lease로 돈다. 서로 다른 묶음을 GPT와 GPU Qwen에 나누며,
 * 장부가 열리면 서로 다른 소개 묶음을 경로 동시 호출 한도만큼 실행한다. 장부가 꺼진 예전 경로는 backend당 한 묶음이다.
 * 느리거나 실패한 backend는 이번 틱에서 쉬고 이미 보낸 다른 묶음의 결과는 남긴다.
 * 모델이 준 줄은 코드 검사를 통과한 것만 남기고, 버린 것은 사유를 적어 센다(korean-taglines.ts koreanTaglineProgress).
 */

const JOB = "product-tagline-ko";
/**
 * 손잡이는 틱마다 runtime_settings jobs.product-tagline-ko 에서 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * - batch 8·batchChars 3,600: 한 번에 옮기는 양(legacy). 예약 증명을 쓰는 native 경로는 원래 1,200자(KOREAN_TRANSLATION_NATIVE_MAX_CHARS, 고정)·
 *   요청 형식을 유지한다. 호출 한 번에 고정 6초쯤 들어 묶을수록 낫지만, 출력이 한글이라 길어지면 20초를 넘는다.
 * - minCallMs 25초: 이만큼 남아 있을 때만 새로 부른다 — 묶음 하나가 15~25초라 틱 끝에 부르면 제한이 짧아져 헛실패가 난다.
 * - slowCallMs 35초: 한 묶음이 이보다 오래 걸리면 게이트웨이가 밀린 것이다 — 이번 틱을 접고 심사에 자리를 준다.
 * - soloAttempts 2: 이만큼 실패·버림이 쌓인 소개는 혼자 보낸다 — 그것 하나가 옆의 멀쩡한 소개까지 끌고 실패하지 않게.
 * 한 번 부르는 데 둘 시간은 등록부 경로 product-tagline-ko(routes.limits)에서, 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 —
 * 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 */
/**
 * 소개 하나만 보냈는데 배열을 못 받았으면(invalid_output) 그 소개 탓이다 — 품질 거절로 세어 한도(MAX_REJECTIONS)에 닿게 한다.
 * 게이트웨이 실패로 두면 혼자 보낸 같은 소개가 같은 실패로 하루 간격까지 늘려 가며 끝없이 섰다. 묶음의 invalid_output 은 누구 탓인지 몰라 그대로 둔다.
 */
export const SOLO_INVALID_OUTPUT = "rejected:invalid_output";

export { taglineSource };

/** 앞에서부터 개수·글자 수 한도까지 — 차례(새 제품·홈 먼저)를 지킨다. maxChars 기본은 legacy 묶음 글자(jobs.product-tagline-ko.batchChars) */
export function packTaglineBatch(tasks: KoreanTaglineTask[], maxChars?: number): KoreanTaglineTask[] {
  const knobs = runtimeSettings();
  const limit = maxChars ?? jobKnob(knobs, JOB, "batchChars"), size = jobKnob(knobs, JOB, "batch"), soloAttempts = jobKnob(knobs, JOB, "soloAttempts");
  const fitting = tasks.filter(task => task.tagline.length <= limit);
  if (fitting[0] && fitting[0].attempts >= soloAttempts) return [fitting[0]];
  const batch: KoreanTaglineTask[] = [];
  let chars = 0;
  for (const task of fitting) {
    if (task.attempts >= soloAttempts) continue;
    if (batch.length && (batch.length >= size || chars + task.tagline.length > limit)) break;
    batch.push(task);
    chars += task.tagline.length;
  }
  return batch;
}

export async function writeKoreanTaglines(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  // GPT 경로는 「작업 ↔ 모델」 순위(PR B)만 부른다 — 순위마다 그 연결을 가리키는 엔진 직접 계약이 있어야 한다. Qwen 직접 경로(korean-translation-direct)는
  // 아직 예전 설정(PR C 가 옮긴다)이라 계약이 필요 없다.
  const ranks = await TextTaskRanks.open(JOB);
  try { return await writeKoreanTaglinesWithRanks(ctx, ranks); }
  finally { ctx.log("ai_task.ranks", ranks.summary()); }
}

async function writeKoreanTaglinesWithRanks(ctx: JobContext<null>, ranks: TextTaskRanks): Promise<JobOutcome<null>> {
  const gptCallable = () => ranks.usable().length > 0;
  const early = ranks.earlyDegraded();
  if (early && !koreanTranslationQwenEnabled()) {
    ctx.log("tagline_ko.skipped", { reason: early.code });
    // 부를 길이 없으면 아무것도 하지 않는다 — 성공이 아니다(러너가 성공 시각을 옮기지 않고 조치할 일이 올린다)
    return { done: true, degraded: early };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Korean tagline worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = tickRemaining(ctx, JOB, startedAt);
    const knobs = runtimeSettings();
    const batchSize = jobKnob(knobs, JOB, "batch"), legacyMaxChars = jobKnob(knobs, JOB, "batchChars"), minCallMs = jobKnob(knobs, JOB, "minCallMs"),
      slowCallMs = jobKnob(knobs, JOB, "slowCallMs"), callMs = modelRouteTimeoutMs(JOB);
    let written = 0, failed = 0;
    const rejected: Record<string, number> = {}, cleaned: Record<string, number> = {};
    const counts = () => ({ written, failed, rejected, cleaned });
    const homeSlugs = await homeListSlugs();
    const visited = new Set<number>();
    const scheduled = new Map<number, symbol>(), pendingRequestIds = new Set<string>();
    const stopped = new Set<"gpt" | "qwen">();
    let recoverySelected = 0;

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const control = await readModelCapacityCallerControl();
      if (control.mode !== "disabled" && control.mode !== "open") {
        // 앞 바퀴에서 이미 적은 뒤 모드가 draining 으로 바뀌면 던지면 건수가 사라진다.
        const processed = written + failed + Object.values(rejected).reduce((sum, count) => sum + count, 0);
        if (processed >= 1) return deferredJob("model_capacity", processed);
        throw new ModelCapacityDeferredError("draining");
      }
      const legacy = control.mode === "disabled";
      const qwen = legacy && koreanTranslationQwenEnabled() && !stopped.has("qwen");
      // 용량 장부가 열려 있으면 GPT 순위만 부른다(Qwen 은 장부가 꺼졌을 때만) — 쓸 순위가 없으면 이 틱의 사정을 남긴다
      if (!legacy && !gptCallable()) {
        const processed = written + failed + Object.values(rejected).reduce((sum, count) => sum + count, 0);
        if (ranks.saturated()) return deferredJob("model_capacity", processed);
        return processed ? { done: true } : { done: true, degraded: ranks.degraded() };
      }
      const candidates = (await pendingKoreanTaglines(batchSize * 4, homeSlugs)).filter(task => !visited.has(task.productId));
      const gptBatches: KoreanTaglineTask[][] = [];
      const gptIds = new Set<number>();
      const concurrency = legacy ? 1 : modelRequestBudget(JOB).concurrency;
      if (gptCallable() && !stopped.has("gpt")) {
        for (let lane = 0; lane < concurrency; lane++) {
          const batch = packTaglineBatch(candidates.filter(task => !gptIds.has(task.productId)),
            legacy ? legacyMaxChars : KOREAN_TRANSLATION_NATIVE_MAX_CHARS);
          if (!batch.length) break;
          gptBatches.push(batch);
          batch.forEach(task => gptIds.add(task.productId));
        }
      }
      const qwenBatch = qwen ? packTaglineBatch(candidates.filter(task => !gptIds.has(task.productId)), legacyMaxChars) : [];
      const wantsRecovery = qwen && koreanTranslationQwenRecoveryEnabled() && !qwenBatch.length && recoverySelected < batchSize;
      let recoveryBatch = false, recoveryDeferred = wantsRecovery && remaining() < callMs + 1_000;
      if (wantsRecovery && !recoveryDeferred) {
        const exclude = [...visited, ...gptIds, ...qwenBatch.map(task => task.productId)];
        const recovery = await pendingKoreanTaglineRecovery(Math.min(batchSize - qwenBatch.length, batchSize - recoverySelected), homeSlugs, [...exclude]);
        let chars = qwenBatch.reduce((sum, task) => sum + task.tagline.length, 0);
        for (const task of recovery) {
          if (qwenBatch.length >= batchSize || recoverySelected >= batchSize) break;
          if (exclude.includes(task.productId) || chars + task.tagline.length > legacyMaxChars) continue;
          qwenBatch.push(task); exclude.push(task.productId); chars += task.tagline.length; recoverySelected++; recoveryBatch = true;
        }
      }
      const work = [
        // GPT 의 모델(장부 이름)은 순위가 정한다 — 부른 순위의 이름으로 아래에서 채운다
        ...gptBatches.map(batch => ({ backend: "gpt" as const, model: "", batch, recovery: false })),
        ...(qwenBatch.length ? [{ backend: "qwen" as const, model: scopedModel("korean-translation-direct", KOREAN_TRANSLATION_QWEN_MODEL), batch: qwenBatch, recovery: recoveryBatch }] : []),
      ];
      if (!work.length) {
        if (recoveryDeferred) { ctx.log("tagline_ko.budget_deferred", { ...counts(), backend: "qwen", recovery: true }); return { done: false }; }
        const maxChars = legacy ? legacyMaxChars : KOREAN_TRANSLATION_NATIVE_MAX_CHARS;
        if (candidates.some(task => task.tagline.length > maxChars)) {
          ctx.log("tagline_ko.input_too_large", { count: candidates.filter(task => task.tagline.length > maxChars).length, maxChars });
          return { done: true, degraded: { code: "input_too_large", detail: "한국어 번역 입력이 현재 묶음 상한을 넘습니다" } };
        }
        ctx.log("tagline_ko.done", { ...counts(), drained: true });
        return { done: true };
      }
      const calledAt = Date.now();
      const timeoutMs = Math.max(1_000, Math.min(callMs, remaining() - 1_000));
      // Selection can itself take time. Never start recovery with a shortened deadline.
      if (recoveryBatch && timeoutMs < callMs) {
        work.splice(work.findIndex(entry => entry.recovery), 1); recoveryDeferred = true;
        ctx.log("tagline_ko.budget_deferred", { ...counts(), backend: "qwen", recovery: true });
        if (!work.length) return { done: false };
      }
      work.forEach(({ batch }) => batch.forEach(task => visited.add(task.productId)));
      const lanes = work.map(entry => ({ entry, lane: Symbol("tagline-ko-lane") }));
      lanes.forEach(({ entry, lane }) => entry.batch.forEach(task => scheduled.set(task.productId, lane)));
      let skipped = false;
      const outcomes = await Promise.allSettled(lanes.map(async ({ entry, lane }) => {
        const pendingClaims = { requestIds: pendingRequestIds, claimBatch: (tasks: readonly KoreanTaglineTask[]) => {
          if (tasks.some(task => scheduled.has(task.productId) && scheduled.get(task.productId) !== lane)) return false;
          tasks.forEach(task => { scheduled.set(task.productId, lane); visited.add(task.productId); });
          return true;
        } };
        const items = entry.batch.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: taglineSource(task) }));
        let model = entry.model;
        let outcome: KoreanTaglineCapacityResult | { kind: "unusable" };
        if (entry.backend === "gpt") {
          const prefer = await pendingTextPoolModel(ranks, pendingRequestIds);
          // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 묶음을 다음 순위로(TextTaskRanks.run)
          const attempt = await ranks.run(binding => translateKoreanTaglinesWithModelCapacity(entry.batch, homeSlugs, lease, { timeoutMs, signal, pendingClaims, requireAdmission: concurrency > 1 })
            .then(value => ({ value, model: binding.identity })), { prefer });
          if (attempt.kind === "unusable") outcome = { kind: "unusable" };
          else { outcome = attempt.value.value; model = attempt.value.model; }
        } else outcome = { kind: "result" as const, result: await translateKoreanTaglinesWithQwen(items, { timeoutMs, signal }) };
        const completedBatch = outcome.kind === "result" ? outcome.batch ?? entry.batch : entry.batch;
        completedBatch.forEach(task => visited.add(task.productId));
        const completedItems = completedBatch.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: taglineSource(task) }));
        if (signal.aborted || !ctx.hasBudget()) { skipped = true; return; }
        const { backend, recovery } = entry;
        const batch = completedBatch, elapsedMs = Date.now() - calledAt;
        if (outcome.kind === "skipped") { skipped = true; return; }
        // GPT 의 모든 순위가 이 틱에 쉰다 — 이 묶음은 그대로 두고(호출·시도 기록 없음) GPT 는 이 틱에서 멈춘다
        if (outcome.kind === "unusable") { stopped.add(backend); return; }
        const result = outcome.result;
        // 틱 끝이라 짧아진 제한에 걸린 것은 소개 탓이 아니다 — 시도로 세지 않고 다음 틱에 다시
        if (!result.ok && result.error === "timeout" && timeoutMs < callMs && !recovery) {
          ctx.log("tagline_ko.budget_deferred", counts());
          skipped = true; stopped.add(backend); return;
        }
        const entries = batch.map((task, index): { task: KoreanTaglineTask; result: KoreanTaglineResult } => {
          if (!result.ok) return { task, result: { kind: "failure", model,
            error: batch.length === 1 && result.error === "invalid_output" ? SOLO_INVALID_OUTPUT : result.error } };
          // 너무 긺·이름 철자·여러 줄은 정해진 정리 뒤 같은 검사를 다시 받는다(checkKoreanTaglineOutput)
          const checked = checkKoreanTaglineOutput(result.outputs[index], completedItems[index]);
          if (checked.ok && checked.cleaned) cleaned[checked.cleaned] = (cleaned[checked.cleaned] ?? 0) + 1;
          return { task, result: checked.ok ? { kind: "success", line: checked.line, model }
            : { kind: "failure", error: `rejected:${checked.reason}`, model } };
        });
        const stored = outcome.expectation ? await recordKoreanTaglines(entries, lease, outcome.expectation) : await recordKoreanTaglines(entries, lease);
        if ("expectation" in outcome && outcome.expectation && stored !== entries.length) { skipped = true; return; }
        for (const { result: entry } of entries) {
          if (entry.kind === "success") written++;
          else if (entry.error.startsWith("rejected:")) rejected[entry.error.slice(9)] = (rejected[entry.error.slice(9)] ?? 0) + 1;
          else failed++;
        }
        // 엔진이 막혔거나 밀렸으면 이번 틱은 여기서 — 같은 실패를 되풀이하지 않고 심사에 자리를 준다. GPT 는 그 순위만 쉬고 다음 묶음은 다음 순위가 맡는다
        if (!result.ok || elapsedMs >= slowCallMs) {
          ctx.log("tagline_ko.gateway_blocked", { ...counts(), backend, model, error: result.ok ? "slow" : result.error });
          const binding = backend === "gpt" ? ranks.bindings().find(row => row.identity === model) : undefined;
          if (binding) ranks.pause(binding, result.ok ? "engine_slow" : "engine_failed");
          if (!binding || !gptCallable()) stopped.add(backend);
        }
      }));
      // Every dispatched lane settles and writes independently before waiting for its siblings.
      const errors: unknown[] = [];
      for (const settled of outcomes) {
        if (settled.status !== "rejected") continue;
        if (settled.reason instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerWork(settled.reason.reason)) {
          ctx.log("tagline_ko.passed", { reason: settled.reason.reason });
          continue;
        }
        errors.push(settled.reason);
      }
      if (errors.length) {
        // 미룸 사유(capacity·unmapped·dispatched…)를 남긴다 — 러너는 'model_capacity' 하나로만 적는다
        // A sibling's capacity wait must not hide a writer/ownership failure.
        const first = errors.find(error => !(error instanceof ModelCapacityDeferredError)) ?? errors[0];
        if (first instanceof ModelCapacityDeferredError) {
          ctx.log("tagline_ko.capacity_deferred", { ...counts(), reason: first.reason });
          const processed = written + failed + Object.values(rejected).reduce((sum, count) => sum + count, 0);
          if (processed >= 1) return deferredJob("model_capacity", processed);
        }
        throw first;
      }
      if (signal.aborted || !ctx.hasBudget()) return { done: false };
      if (skipped || recoveryDeferred) return { done: false };
      if (ranks.exhausted && !qwen) {
        // GPT 의 모든 순위가 이 틱에 쉰다(Qwen 도 돌지 않는다). 포화면 예전처럼 미루고, 아니면 일을 했을 때만 보통 틱 — 한 건도 못 했으면 까닭을 남긴다
        const processed = written + failed + Object.values(rejected).reduce((sum, count) => sum + count, 0);
        ctx.log("tagline_ko.all_ranks_unusable", counts());
        if (ranks.saturated()) return deferredJob("model_capacity", processed);
        return processed ? { done: true } : { done: true, degraded: ranks.degraded() };
      }
      if (stopped.has("gpt") && (!qwen || stopped.has("qwen"))) return { done: true };
    }
    ctx.log("tagline_ko.done", { ...counts(), drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
