import type { ReviewCliRun } from "@/lib/crawl/agent-review";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { profileEvidence } from "@/lib/domain/products/search-profile";
import { pendingVerifications, recordVerificationResult, type VerificationResult } from "@/lib/domain/products/search-profiles";
import { VERIFY_BATCH, VERIFY_MODEL, verifyKeywords } from "@/lib/domain/products/search-verify";

/**
 * 검색 키워드 검수 — 지은 키워드를 Sonnet 이 근거와 대조해 뒷받침되지 않는 것을 뺀다(search-verify.ts).
 *
 * reviewer 워커에서 돈다 — 구독 토큰(claude-cli)이 거기에만 있다. 2차 심사의 Sonnet 표와 한도를 같이 쓰므로
 * 한 번에 하나(10건 묶음)씩만 부른다. 한 번에 11~21초라 틱마다 40~90건쯤 본다.
 */

/** 틱 예산(worker.ts jobRunOptions 110초)보다 조금 짧게 */
const TICK_MS = 105_000;
/** 한 번(10건)에 둘 시간 — 시범에서 평소 11~21초 */
const CALL_MS = 90_000;
/** 이만큼 남아 있을 때만 새로 부른다 */
const MIN_CALL_MS = 40_000;
/** 제품 탓이 아닌 실패 — 이번 틱을 접는다. 한도에 걸린 것은 30분 쉬게 적힌다(recordVerificationResult) */
const STOP = new Set(["rate_limited", "auth", "missing_cli", "not_configured", "timeout", "cli_error", "budget", "cancelled"]);

export async function verifySearchKeywords(ctx: JobContext<null>, run?: ReviewCliRun): Promise<JobOutcome<null>> {
  const lease = ctx.lease;
  if (!lease) throw new Error("Search keyword verification requires a job lease");
  const startedAt = Date.now();
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  let verified = 0, removed = 0, failed = 0;

  while (ctx.hasBudget() && !ctx.signal?.aborted && remaining() >= MIN_CALL_MS) {
    const tasks = await pendingVerifications(VERIFY_BATCH);
    if (tasks.length === 0) {
      ctx.log("search_verify.done", { verified, removed, failed, drained: true });
      return { done: true };
    }
    const items = tasks.map((task) => ({
      slug: task.product.slug,
      evidence: profileEvidence(task.product, task.reviewerNote),
      keywords: [...task.profile!.keywordsEn, ...task.profile!.keywordsKo],
    }));
    const result = await verifyKeywords(items, { timeoutMs: Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000)), run, signal: ctx.signal });
    if (!result.ok) {
      for (const task of tasks) if (await recordVerificationResult(task, lease, { kind: "failure", error: result.error })) failed++;
      if (STOP.has(result.error)) {
        ctx.log("search_verify.blocked", { verified, removed, failed });
        return { done: true };
      }
      continue;
    }
    for (const task of tasks) {
      const unsupported = result.unsupported.get(task.product.slug);
      // 답이 빠진 제품은 검수하지 않은 것으로 남긴다 — 다음에 다시 본다
      const outcome: VerificationResult = unsupported
        ? { kind: "success", removed: unsupported, model: VERIFY_MODEL }
        : { kind: "failure", error: "missing_result" };
      if (!await recordVerificationResult(task, lease, outcome)) continue;
      if (unsupported) { verified++; removed += unsupported.length; } else failed++;
    }
  }
  ctx.log("search_verify.done", { verified, removed, failed, drained: false });
  return { done: false };
}
