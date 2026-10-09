import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { TRANSLATE_MODEL, translateTaglinesToKorean } from "@/lib/crawl/translate";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { checkKoreanTagline } from "@/lib/domain/products/korean-tagline";
import { homeListSlugs, pendingKoreanTaglines, recordKoreanTaglines, type KoreanTaglineResult, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";

/**
 * 한국어 한 줄 소개 짓기(UX-13) — 공개 제품의 지금 소개를 한국어 한 줄로 옮긴다. 새 제품·홈에 보이는 제품부터, 나머지는 스타 순.
 *
 * text 워커에서 사유 번역·소개 짓기·검색 키워드와 차례로 돈다. 같은 게이트웨이의 gpt-oss-120b 를 쓰는 1차 심사에 자리를
 * 양보한다 — 한 번이 SLOW_CALL_MS 를 넘거나 게이트웨이가 실패하면 이번 틱을 접는다(search-profile.ts 와 같은 까닭).
 * 모델이 준 줄은 코드 검사를 통과한 것만 남기고, 버린 것은 사유를 적어 센다(korean-taglines.ts koreanTaglineProgress).
 */

/**
 * 한 번에 옮기는 양 — 8건, 1,200자까지. 소개는 200자 안쪽이라 사유(4건·1,600자, translate-reasons.ts)보다 많이 묶는다.
 * 호출 한 번에 고정 6초쯤 들어 묶을수록 낫지만, 출력이 한글이라 길어지면 20초를 넘는다.
 */
const BATCH = 8;
const BATCH_CHARS = 1_200;
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

/** 앞에서부터 개수·글자 수 한도까지 — 차례(새 제품·홈 먼저)를 지킨다 */
export function packTaglineBatch(tasks: KoreanTaglineTask[]): KoreanTaglineTask[] {
  if (tasks[0] && tasks[0].attempts >= SOLO_ATTEMPTS) return [tasks[0]];
  const batch: KoreanTaglineTask[] = [];
  let chars = 0;
  for (const task of tasks) {
    if (task.attempts >= SOLO_ATTEMPTS) continue;
    if (batch.length && (batch.length >= BATCH || chars + task.tagline.length > BATCH_CHARS)) break;
    batch.push(task);
    chars += task.tagline.length;
  }
  return batch;
}

export async function writeKoreanTaglines(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("tagline_ko.skipped", { reason: "no_key" });
    return { done: true };
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

    while (!signal.aborted && ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
      const batch = packTaglineBatch(await pendingKoreanTaglines(BATCH * 2, homeSlugs));
      if (!batch.length) {
        ctx.log("tagline_ko.done", { ...counts(), drained: true });
        return { done: true };
      }
      const calledAt = Date.now();
      const timeoutMs = Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000));
      const items = batch.map((task) => ({ name: displayProjectName(task.name, task.repoUrl), tagline: task.tagline }));
      const result = await translateTaglinesToKorean(items, timeoutMs, undefined, signal);
      if (signal.aborted) return { done: false };
      // 틱 끝이라 짧아진 제한에 걸린 것은 소개 탓이 아니다 — 시도로 세지 않고 다음 틱에 다시
      if (!result.ok && result.error === "timeout" && timeoutMs < CALL_MS) {
        ctx.log("tagline_ko.budget_deferred", counts());
        return { done: false };
      }
      const entries = batch.map((task, index): { task: KoreanTaglineTask; result: KoreanTaglineResult } => {
        if (!result.ok) return { task, result: { kind: "failure", error: result.error, model: TRANSLATE_MODEL } };
        const checked = checkKoreanTagline(result.outputs[index], items[index]);
        return { task, result: checked.ok ? { kind: "success", line: checked.line, model: TRANSLATE_MODEL }
          : { kind: "failure", error: `rejected:${checked.reason}`, model: TRANSLATE_MODEL } };
      });
      await recordKoreanTaglines(entries, lease);
      for (const { result: entry } of entries) {
        if (entry.kind === "success") written++;
        else if (entry.error.startsWith("rejected:")) rejected[entry.error.slice(9)] = (rejected[entry.error.slice(9)] ?? 0) + 1;
        else failed++;
      }
      // 게이트웨이가 막혔거나 밀렸으면 이번 틱은 여기서 — 같은 실패를 되풀이하지 않고 심사에 자리를 준다
      if (!result.ok || Date.now() - calledAt >= SLOW_CALL_MS) {
        ctx.log("tagline_ko.gateway_blocked", { ...counts(), error: result.ok ? "slow" : result.error });
        return { done: true };
      }
    }
    ctx.log("tagline_ko.done", { ...counts(), drained: false });
    return { done: false };
  } finally {
    clearInterval(ownershipPoll);
  }
}
