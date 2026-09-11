import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { TRANSLATE_MODEL, translateToKorean } from "@/lib/crawl/translate";
import { pendingTranslations, recordTranslations } from "@/lib/crawl/translations";

/**
 * 한 번에 옮기는 양 — 최대 4건, 1,600자까지.
 *
 * 2026-09-11 프로드: 영어 사유 2,395건, 중앙값 466자·상위 10% 678자·최장 1,239자. 한 번 부르는 데
 * 고정으로 6초쯤 들어(1건 7.6초, 2건 1,209자 7.4초) 묶을수록 낫지만, 3건 묶음은 15초에서 20초를 넘기도 했다.
 * 글자 수로 묶어 한 번이 15~25초에 들게 한다. 첫 글이 1,600자를 넘으면 그 글만 보낸다.
 */
const BATCH = 4;
const BATCH_CHARS = 1_600;
/** 한 번 부르는 데 둘 시간. 첫 배포 때 20초로 두었더니 4틱 연속 시간 초과였다 */
const CALL_MS = 45_000;
/** 틱 예산(worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 54_000;
/**
 * 이만큼 남아 있을 때만 새로 부른다. 묶음 하나가 15~25초라, 틱 끝에 남은 16초로 부르면 제한이
 * 16초로 줄어 거의 늘 시간 초과였다 — 프로드에서 틱마다 3건씩 헛실패가 났다(2026-09-11).
 */
const MIN_CALL_MS = 30_000;

/** 앞에서부터 글자 수 한도까지 — 순서(최근 것부터)를 지킨다 */
export function packBatch<T extends { body: string }>(items: T[]): T[] {
  const batch: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= BATCH || chars + item.body.length > BATCH_CHARS)) break;
    batch.push(item);
    chars += item.body.length;
  }
  return batch;
}

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
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  let translated = 0, failed = 0;

  while (ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
    const pending = await pendingTranslations(BATCH * 2);
    if (!pending.length) {
      ctx.log("translate.done", { translated, failed, drained: true });
      return { done: true };
    }
    // 한 번 실패한 글은 따로 — 묶음 하나가 다른 글까지 끌고 실패하지 않게
    const batch = pending[0].attempts > 0 ? [pending[0]] : packBatch(pending.filter((item) => item.attempts === 0));
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
