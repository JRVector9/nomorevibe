import { modelTimeoutMs, scopedModel } from "@/lib/llm/model-registry";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { translateReasonsWithModelCapacity } from '@/lib/crawl/reason-translation-model-capacity';
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { recordWorkerTranslations, retryableTranslations, untriedTranslations } from "@/lib/crawl/translations";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { jobKnob, type RuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { TEXT_ROUTE_BLOCK_DETAIL, textRouteBlock } from "@/lib/llm/serving-contract-store";

const JOB = "reason-translate";
/**
 * 묶음 손잡이 — 틱마다 runtime_settings jobs.reason-translate 에서 읽는다(관리자 실시간 한도, 재배포 없이 다음 틱에 반영).
 *
 * batch 4·batchChars 1,600: 한 번에 옮기는 양 — 최대 4건, 1,600자까지. 2026-09-11 프로드: 영어 사유 2,395건, 중앙값 466자·상위 10% 678자·
 * 최장 1,239자. 한 번 부르는 데 고정으로 6초쯤 들어(1건 7.6초, 2건 1,209자 7.4초) 묶을수록 낫지만, 3건 묶음은 15초에서 20초를 넘기도 했다.
 * 글자 수로 묶어 한 번이 15~25초에 들게 한다. 첫 글이 1,600자를 넘으면 그 글만 보낸다.
 *
 * minCallMs 30초: 이만큼 남아 있을 때만 새로 부른다. 묶음 하나가 15~25초라, 틱 끝에 남은 16초로 부르면 제한이 16초로 줄어 거의 늘
 * 시간 초과였다 — 프로드에서 틱마다 3건씩 헛실패가 났다(2026-09-11).
 *
 * soloAttempts 3: 이만큼 실패한 글은 묶지 않고 혼자 보낸다. 밀린 실패는 대부분 묶음이 통째로 시간 초과된 것이라(프로드 1,871건 중
 * 1,854건이 시도 1회) 다시 묶어 보내는 것이 맞다. 여러 번 되풀이해 실패한 글만 따로 떼어, 그것 하나가 옆의 멀쩡한 글까지 끌고 실패하지 않게 한다.
 *
 * 한 번 부르는 데 둘 시간은 등록부 경로 reason-translate(routes.limits.reason-translate.timeoutMs — 첫 배포 때 20초로 두었더니 4틱 연속
 * 시간 초과였다)에서, 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 읽는다 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 */
export type ReasonTranslateKnobs = { batch: number; batchChars: number; minCallMs: number; soloAttempts: number };
export function reasonTranslateKnobs(settings: RuntimeSettings = runtimeSettings()): ReasonTranslateKnobs {
  return { batch: jobKnob(settings, JOB, "batch"), batchChars: jobKnob(settings, JOB, "batchChars"),
    minCallMs: jobKnob(settings, JOB, "minCallMs"), soloAttempts: jobKnob(settings, JOB, "soloAttempts") };
}

/**
 * 다음에 먼저 볼 줄 — 틱을 넘어 이어 간다.
 *
 * 틱마다 '밀린 실패'부터 다시 시작했더니, 실패 묶음이 또 실패해 틱을 접으면(아래 break) 처음 보는 글은 그 틱에 차례를
 * 얻지 못했다. 늘 실패하는 글이 하나라도 재시도 시각에 서 있으면 새 사유가 영영 밀린다. 한 프로세스 안에서는 번갈아 가는
 * 차례를 틱이 바뀌어도 잇는다(재시작하면 실패부터 — 예전과 같다).
 */
let takeRetryFirst = true;

/** 앞에서부터 글자 수 한도까지 — 순서(최근 것부터)를 지킨다. 손잡이는 부를 때의 판(기본은 지금 runtime_settings)이다 */
export function packBatch<T extends { body: string; attempts?: number }>(items: T[], knobs: Pick<ReasonTranslateKnobs, "batch" | "batchChars" | "soloAttempts"> = reasonTranslateKnobs()): T[] {
  const batch: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length && ((item.attempts ?? 0) >= knobs.soloAttempts || (batch[0].attempts ?? 0) >= knobs.soloAttempts
      || batch.length >= knobs.batch || chars + item.body.length > knobs.batchChars)) break;
    batch.push(item);
    chars += item.body.length;
  }
  return batch;
}

/**
 * 사유 번역. 심사 화면의 영어 사유를 미리 한국어로 옮겨 둔다 — 느려도 매 틱 조금씩 이어 간다.
 *
 * 전용 text 워커에서 번역·소개 생성이 차례로 돈다. 발행 워커는 이 호출을 기다리지 않는다.
 */
export async function translateReasons(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  // 이 경로의 직접 연결 계약(관리자 엔진 연결, 엔진에 바로 — 키 없이도 부른다)이 있어야 부를 수 있다. 다른 text 잡과 같은 관문이다
  // (PR 3b-C textRouteCallable 과 같은 판정 textRouteAccess) — 게이트웨이는 2026-10-30 제거됐다
  const blocked = textRouteBlock(JOB, scopedModel(JOB, TRANSLATE_MODEL));
  if (blocked) {
    ctx.log("translate.skipped", { reason: blocked });
    return { done: true, degraded: { code: blocked, detail: TEXT_ROUTE_BLOCK_DETAIL[blocked] } };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("Translation worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = tickRemaining(ctx, JOB, startedAt);
    const knobs = reasonTranslateKnobs(), callMs = modelTimeoutMs(JOB);
    let translated = 0, failed = 0;

    /**
     * 밀린 실패와 처음 보는 글을 번갈아 가져간다.
     *
     * 한쪽만 보면 다른 쪽이 굶는다 — 최근 것만 보면 실패가 엿새를 기다리고, 실패만 보면
     * 심사 화면의 새 사유가 그동안 영어로 남는다.
     */
    while (!signal.aborted && ctx.hasBudget() && remaining() >= knobs.minCallMs) {
      const takeRetry = takeRetryFirst;
      const preferred = takeRetry ? await retryableTranslations(knobs.batch) : await untriedTranslations(knobs.batch * 2);
      const pending = preferred.length
        ? preferred
        : takeRetry ? await untriedTranslations(knobs.batch * 2) : await retryableTranslations(knobs.batch);
      takeRetryFirst = !takeRetry;
      if (!pending.length) {
        ctx.log("translate.done", { translated, failed, drained: true });
        return { done: true };
      }
      const batch = pending[0].attempts >= knobs.soloAttempts ? [pending[0]] : packBatch(pending, knobs);
      let prepared: Awaited<ReturnType<typeof translateReasonsWithModelCapacity>>;
      try {
        prepared = await translateReasonsWithModelCapacity(batch, lease,
          { timeoutMs: Math.max(1_000, Math.min(callMs, remaining() - 1_000)), signal });
      } catch (error) {
        // 미룸 사유(capacity·dispatched·unmapped…)를 남긴다 — 러너는 'model_capacity' 하나로만 적는다
        if (error instanceof ModelCapacityDeferredError) {
          ctx.log("translate.capacity_deferred", { translated, failed, reason: error.reason });
          const processed = translated + failed;
          if (processed >= 1) return deferredJob("model_capacity", processed);
        }
        throw error;
      }
      if (prepared.kind === 'skipped') return { done: false };
      const result = prepared.result;
      if (signal.aborted) return { done: false };
      const rows = (prepared.kind === 'ready' ? prepared.batch : batch).map((item, index) => ({
        hash: item.hash,
        translated: result.ok ? result.translations[index] : null,
        error: result.ok ? undefined : result.error,
      }));
      if (prepared.kind === 'ready') {
        const stored = await recordWorkerTranslations(rows, scopedModel("reason-translate", TRANSLATE_MODEL), lease, prepared.expectation);
        if (stored === 0) return { done: false };
      } else await recordWorkerTranslations(rows, scopedModel("reason-translate", TRANSLATE_MODEL), lease);
      translated += rows.filter((row) => row.translated !== null).length;
      failed += rows.filter((row) => row.translated === null).length;
      // 게이트웨이가 막혔으면 이번 틱은 여기서 — 같은 실패를 되풀이하지 않는다
      if (!result.ok || prepared.kind === 'ready' && prepared.unknown) break;
    }

    ctx.log("translate.done", { translated, failed, drained: false });
    return { done: false };
  } finally { clearInterval(ownershipPoll); }
}
