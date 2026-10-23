import { translateKoreanTaglinesWithModelCapacity, type KoreanTaglineCapacityResult } from "@/lib/domain/products/korean-tagline-model-capacity";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { checkKoreanTagline } from "@/lib/domain/products/korean-tagline";
import { homeListSlugs, pendingKoreanTaglines, pendingKoreanTaglineRecovery, recordKoreanTaglines, koreanTaglineSource as taglineSource, type KoreanTaglineResult, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { translateKoreanTaglinesWithQwen } from "@/lib/crawl/korean-translation-qwen";
import { KOREAN_TRANSLATION_LEGACY_MAX_CHARS, KOREAN_TRANSLATION_NATIVE_MAX_CHARS,
  KOREAN_TRANSLATION_QWEN_MODEL, koreanTranslationQwenEnabled, koreanTranslationQwenRecoveryEnabled } from "@/lib/crawl/korean-translation-config";

/**
 * 한국어 한 줄 소개 짓기(UX-13) — 공개 제품의 지금 소개를 한국어 한 줄로 옮긴다. 새 제품·홈에 보이는 제품부터, 나머지는 스타 순.
 *
 * legacy text 워커의 한국어 전용 줄에서 단일 잡 lease로 돈다. 서로 다른 묶음을 GPT와 GPU Qwen에 나누며,
 * 각 backend는 한 번만 동시에 부른다. 느리거나 실패한 backend는 이번 틱에서 쉬고 다른 backend의 결과는 남긴다.
 * 모델이 준 줄은 코드 검사를 통과한 것만 남기고, 버린 것은 사유를 적어 센다(korean-taglines.ts koreanTaglineProgress).
 */

/**
 * 한 번에 옮기는 양 — legacy 8건·3,600자. 예약 증명을 쓰는 native 경로는 원래 1,200자·요청 형식을 유지한다.
 * 호출 한 번에 고정 6초쯤 들어 묶을수록 낫지만, 출력이 한글이라 길어지면 20초를 넘는다.
 */
const BATCH = 8;
/** 한 번 부르는 데 둘 시간 */
const CALL_MS = 45_000;
/** 틱 예산(scripts/worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 54_000;
/** 이만큼 남아 있을 때만 새로 부른다 — 묶음 하나가 15~25초라 틱 끝에 부르면 제한이 짧아져 헛실패가 난다 */
const MIN_CALL_MS = 25_000;
/** 한 묶음이 이보다 오래 걸리면 게이트웨이가 밀린 것이다 — 이번 틱을 접고 심사에 자리를 준다 */
const SLOW_CALL_MS = 35_000;
/** 이만큼 실패·버림이 쌓인 소개는 혼자 보낸다 — 그것 하나가 옆의 멀쩡한 소개까지 끌고 실패하지 않게 */
const SOLO_ATTEMPTS = 2;

export { taglineSource };

/** 앞에서부터 개수·글자 수 한도까지 — 차례(새 제품·홈 먼저)를 지킨다 */
export function packTaglineBatch(tasks: KoreanTaglineTask[], maxChars = KOREAN_TRANSLATION_LEGACY_MAX_CHARS): KoreanTaglineTask[] {
  const fitting = tasks.filter(task => task.tagline.length <= maxChars);
  if (fitting[0] && fitting[0].attempts >= SOLO_ATTEMPTS) return [fitting[0]];
  const batch: KoreanTaglineTask[] = [];
  let chars = 0;
  for (const task of fitting) {
    if (task.attempts >= SOLO_ATTEMPTS) continue;
    if (batch.length && (batch.length >= BATCH || chars + task.tagline.length > maxChars)) break;
    batch.push(task);
    chars += task.tagline.length;
  }
  return batch;
}

export async function writeKoreanTaglines(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim() && !koreanTranslationQwenEnabled()) {
    ctx.log("tagline_ko.skipped", { reason: "no_key" });
    // 키가 없으면 아무것도 하지 않는다 — 성공이 아니다(러너가 성공 시각을 옮기지 않고 조치할 일이 올린다)
    return { done: true, degraded: { code: "no_key", detail: "text 워커에 ABCLLM_API_KEY 가 없습니다" } };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Korean tagline worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = () => TICK_MS - (Date.now() - startedAt);
    let written = 0, failed = 0;
    const rejected: Record<string, number> = {};
    const counts = () => ({ written, failed, rejected });
    const homeSlugs = await homeListSlugs();
    const visited = new Set<number>();
    const stopped = new Set<"gpt" | "qwen">();
    let recoverySelected = 0;

    while (!signal.aborted && ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
      const control = await readModelCapacityCallerControl();
      if (control.mode !== "disabled" && control.mode !== "open") throw new ModelCapacityDeferredError("draining");
      const legacy = control.mode === "disabled";
      const qwen = legacy && koreanTranslationQwenEnabled() && !stopped.has("qwen");
      if (!legacy && !process.env.ABCLLM_API_KEY?.trim()) return { done: true,
        degraded: { code: "no_key", detail: "native 한국어 번역에 필요한 ABCLLM_API_KEY 가 없습니다" } };
      const candidates = (await pendingKoreanTaglines(BATCH * 4, homeSlugs)).filter(task => !visited.has(task.productId));
      const gptBatch = process.env.ABCLLM_API_KEY?.trim() && !stopped.has("gpt")
        ? packTaglineBatch(candidates, legacy ? KOREAN_TRANSLATION_LEGACY_MAX_CHARS : KOREAN_TRANSLATION_NATIVE_MAX_CHARS) : [];
      const gptIds = new Set(gptBatch.map(task => task.productId));
      const qwenBatch = qwen ? packTaglineBatch(candidates.filter(task => !gptIds.has(task.productId))) : [];
      const wantsRecovery = qwen && koreanTranslationQwenRecoveryEnabled() && !qwenBatch.length && recoverySelected < BATCH;
      let recoveryBatch = false, recoveryDeferred = wantsRecovery && remaining() < CALL_MS + 1_000;
      if (wantsRecovery && !recoveryDeferred) {
        const exclude = [...visited, ...gptIds, ...qwenBatch.map(task => task.productId)];
        const recovery = await pendingKoreanTaglineRecovery(Math.min(BATCH - qwenBatch.length, BATCH - recoverySelected), homeSlugs, [...exclude]);
        let chars = qwenBatch.reduce((sum, task) => sum + task.tagline.length, 0);
        for (const task of recovery) {
          if (qwenBatch.length >= BATCH || recoverySelected >= BATCH) break;
          if (exclude.includes(task.productId) || chars + task.tagline.length > KOREAN_TRANSLATION_LEGACY_MAX_CHARS) continue;
          qwenBatch.push(task); exclude.push(task.productId); chars += task.tagline.length; recoverySelected++; recoveryBatch = true;
        }
      }
      const work = [
        ...(gptBatch.length ? [{ backend: "gpt" as const, model: TRANSLATE_MODEL, batch: gptBatch, recovery: false }] : []),
        ...(qwenBatch.length ? [{ backend: "qwen" as const, model: KOREAN_TRANSLATION_QWEN_MODEL, batch: qwenBatch, recovery: recoveryBatch }] : []),
      ];
      if (!work.length) {
        if (recoveryDeferred) { ctx.log("tagline_ko.budget_deferred", { ...counts(), backend: "qwen", recovery: true }); return { done: false }; }
        const maxChars = legacy ? KOREAN_TRANSLATION_LEGACY_MAX_CHARS : KOREAN_TRANSLATION_NATIVE_MAX_CHARS;
        if (candidates.some(task => task.tagline.length > maxChars)) {
          ctx.log("tagline_ko.input_too_large", { count: candidates.filter(task => task.tagline.length > maxChars).length, maxChars });
          return { done: true, degraded: { code: "input_too_large", detail: "한국어 번역 입력이 현재 묶음 상한을 넘습니다" } };
        }
        ctx.log("tagline_ko.done", { ...counts(), drained: true });
        return { done: true };
      }
      const calledAt = Date.now();
      const timeoutMs = Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000));
      // Selection can itself take time. Never start recovery with a shortened deadline.
      if (recoveryBatch && timeoutMs < CALL_MS) {
        work.splice(work.findIndex(entry => entry.recovery), 1); recoveryDeferred = true;
        ctx.log("tagline_ko.budget_deferred", { ...counts(), backend: "qwen", recovery: true });
        if (!work.length) return { done: false };
      }
      work.forEach(({ batch }) => batch.forEach(task => visited.add(task.productId)));
      const outcomes = await Promise.allSettled(work.map(async entry => {
        const items = entry.batch.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: taglineSource(task) }));
        const outcome: KoreanTaglineCapacityResult = entry.backend === "gpt"
          ? await translateKoreanTaglinesWithModelCapacity(entry.batch, homeSlugs, lease, { timeoutMs, signal })
          : { kind: "result" as const, result: await translateKoreanTaglinesWithQwen(items, { timeoutMs, signal }) };
        return { ...entry, items, outcome, elapsedMs: Date.now() - calledAt };
      }));
      if (signal.aborted || !ctx.hasBudget()) return { done: false };
      let skipped = false;
      const errors: unknown[] = [];
      for (const settled of outcomes) {
        if (signal.aborted || !ctx.hasBudget()) return { done: false };
        if (settled.status === "rejected") { errors.push(settled.reason); continue; }
        const { batch, backend, model, items, outcome, elapsedMs, recovery } = settled.value;
        if (outcome.kind === "skipped") { skipped = true; continue; }
        const result = outcome.result;
        // 틱 끝이라 짧아진 제한에 걸린 것은 소개 탓이 아니다 — 시도로 세지 않고 다음 틱에 다시
        if (!result.ok && result.error === "timeout" && timeoutMs < CALL_MS && !recovery) {
          ctx.log("tagline_ko.budget_deferred", counts());
          skipped = true; stopped.add(backend); continue;
        }
        const entries = batch.map((task, index): { task: KoreanTaglineTask; result: KoreanTaglineResult } => {
          if (!result.ok) return { task, result: { kind: "failure", error: result.error, model } };
          const checked = checkKoreanTagline(result.outputs[index], items[index]);
          return { task, result: checked.ok ? { kind: "success", line: checked.line, model }
            : { kind: "failure", error: `rejected:${checked.reason}`, model } };
        });
        const stored = outcome.expectation ? await recordKoreanTaglines(entries, lease, outcome.expectation) : await recordKoreanTaglines(entries, lease);
        if ("expectation" in outcome && outcome.expectation && stored !== entries.length) { skipped = true; continue; }
        for (const { result: entry } of entries) {
          if (entry.kind === "success") written++;
          else if (entry.error.startsWith("rejected:")) rejected[entry.error.slice(9)] = (rejected[entry.error.slice(9)] ?? 0) + 1;
          else failed++;
        }
        // 게이트웨이가 막혔거나 밀렸으면 이번 틱은 여기서 — 같은 실패를 되풀이하지 않고 심사에 자리를 준다
        if (!result.ok || elapsedMs >= SLOW_CALL_MS) {
          ctx.log("tagline_ko.gateway_blocked", { ...counts(), backend, model, error: result.ok ? "slow" : result.error });
          stopped.add(backend);
        }
      }
      if (errors.length) throw errors[0];
      if (skipped || recoveryDeferred) return { done: false };
      if (stopped.has("gpt") && (!qwen || stopped.has("qwen"))) return { done: true };
    }
    ctx.log("tagline_ko.done", { ...counts(), drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
