import type { ReviewCliRun } from "@/lib/crawl/agent-review";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { checkIntros, INTRO_CHECK_BATCH, INTRO_CHECK_MODEL, introEvidence } from "@/lib/domain/products/intro-check";
import { pendingIntroChecks, recordIntroCheck, type IntroCheckRecord } from "@/lib/domain/products/intro-checks";

/**
 * 소개 검수 — 주인 없는 수집 제품의 AI 소개와 쓸모없어 보이는 메이커 소개를 Sonnet 이 근거와 대조한다
 * (intro-check.ts). 틀리거나 쓸모없으면 고쳐 쓴 줄로 바꾸고, 알 수 없으면 관리자가 본다.
 *
 * reviewer 워커에서 돈다 — 구독 토큰(claude-cli)이 거기에만 있다. 키워드 검수(동시 2)·2차 심사와 한도를
 * 같이 쓰므로 한 번에 하나만 부른다. 처음 쌓인 약 970건은 30분쯤이면 끝나고, 그 뒤로는 새로 발행되는 것만 온다.
 */

/** 틱 예산(worker.ts jobRunOptions 110초)보다 조금 짧게 */
const TICK_MS = 105_000;
/** 한 번(10건)에 둘 시간 — 표본에서 평소 13초 */
const CALL_MS = 90_000;
/** 이만큼 남아 있을 때만 새로 부른다 */
const MIN_CALL_MS = 40_000;
/** 제품 탓이 아닌 실패 — 이번 틱을 접는다. 한도에 걸린 것은 30분 쉬게 적힌다(recordIntroCheck) */
const STOP = new Set(["rate_limited", "auth", "missing_cli", "not_configured", "timeout", "cli_error", "budget", "cancelled"]);

export async function checkProductIntros(ctx: JobContext<null>, run?: ReviewCliRun): Promise<JobOutcome<null>> {
  const lease = ctx.lease;
  if (!lease) throw new Error("Intro check requires a job lease");
  const startedAt = Date.now();
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  const counts = { kept: 0, replaced: 0, needs_editor: 0, failed: 0 };

  while (ctx.hasBudget() && !ctx.signal?.aborted && remaining() >= MIN_CALL_MS) {
    const tasks = await pendingIntroChecks(INTRO_CHECK_BATCH);
    if (tasks.length === 0) {
      ctx.log("intro_check.done", { ...counts, drained: true });
      return { done: true };
    }
    const result = await checkIntros(tasks.map((task) => ({
      slug: task.product.slug, intro: task.product.tagline, evidence: introEvidence(task.product),
    })), { timeoutMs: Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000)), run, signal: ctx.signal });
    for (const task of tasks) {
      const judgement = result.ok ? result.judgements.get(task.product.slug) : undefined;
      // 답이 빠진 제품은 실패로 적는다 — 다음에 다시 본다
      const outcome: IntroCheckRecord = judgement ? { kind: "success", judgement, model: INTRO_CHECK_MODEL }
        : { kind: "failure", error: result.ok ? "missing_result" : result.error };
      const recorded = await recordIntroCheck(task, lease, outcome);
      if (recorded) counts[recorded]++;
    }
    if (!result.ok && STOP.has(result.error)) {
      ctx.log("intro_check.blocked", { ...counts, error: result.error });
      return { done: true };
    }
  }
  ctx.log("intro_check.done", { ...counts, drained: false });
  return { done: false };
}
