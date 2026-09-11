import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { TRANSLATE_MODEL, translateToKorean } from "@/lib/crawl/translate";
import { pendingTranslations, recordTranslations } from "@/lib/crawl/translations";

/** 한 번에 옮기는 수 — 3건이 10~13초. 25초 틱에 한두 번 들어간다 */
const BATCH = 3;
/** 한 번 부르는 데 넉넉히 둘 시간. 이보다 덜 남았으면 다음 틱으로 넘긴다 */
const CALL_MS = 20_000;

/**
 * 사유 번역. 심사 화면의 영어 사유를 미리 한국어로 옮겨 둔다 — 느려도 매 틱 조금씩 이어 간다.
 *
 * 발행 워커에서 돈다. 발행은 5분에 한 번이라 워커가 대부분 비어 있고, 심사 워커에 두면
 * AI 심사·2차 심사와 차례를 나눠 쓰느라 둘 다 느려진다(워커는 잡을 하나씩 돈다).
 */
export async function translateReasons(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("translate.skipped", { reason: "no_key" });
    return { done: true };
  }
  const startedAt = Date.now();
  const remaining = () => 24_000 - (Date.now() - startedAt);
  let translated = 0, failed = 0;

  while (ctx.hasBudget() && remaining() > CALL_MS / 2) {
    const pending = await pendingTranslations(BATCH);
    if (!pending.length) {
      ctx.log("translate.done", { translated, failed, drained: true });
      return { done: true };
    }
    // 한 번 실패한 글은 따로 — 묶음 하나가 다른 글까지 끌고 실패하지 않게
    const batch = pending[0].attempts > 0 ? [pending[0]] : pending.filter((item) => item.attempts === 0);
    const result = await translateToKorean(batch.map((item) => item.body), Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000)));
    const rows = batch.map((item, index) => ({
      hash: item.hash,
      translated: result.ok ? result.translations[index] : null,
      error: result.ok ? undefined : result.error,
    }));
    await recordTranslations(rows, TRANSLATE_MODEL);
    translated += rows.filter((row) => row.translated !== null).length;
    failed += rows.filter((row) => row.translated === null).length;
    // 게이트웨이가 막혔으면 이번 틱은 여기서 — 같은 실패를 되풀이하지 않는다
    if (!result.ok) break;
  }

  ctx.log("translate.done", { translated, failed, drained: false });
  return { done: false };
}
