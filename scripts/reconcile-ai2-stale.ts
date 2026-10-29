/**
 * 오래된 AI2(2차 검수) 대기 정합 도구 — docs/operations/2026-10-27-ai2-stale-reconcile.md
 *
 *   node --import tsx scripts/reconcile-ai2-stale.ts [--limit N] [--after CANDIDATE_ID]
 *   node --import tsx scripts/reconcile-ai2-stale.ts --apply --actor NAME [--limit N] [--after CANDIDATE_ID]
 *
 * 기본은 dry-run(READ ONLY 트랜잭션, 쓰기·잠금 없음). --apply 일 때만 second-review 잡의 실제 lease 를 잡고
 * 잡과 같은 잠금 경로로 쓴다 — 잡이 돌고 있으면 lease 를 얻지 못해 아무것도 쓰지 않고 끝난다(종료 코드 3).
 * 한 번에 보는 후보는 --limit(기본 25, 최대 200)이다. 출력의 nextAfterCandidateId 를 --after 로 넘겨 다음 묶음을 본다.
 */
import { runJob } from "@/lib/jobs/runner";
import { applyStaleSecondReviews, previewStaleSecondReviews, STALE_RECONCILE_TOOL_MAX } from "@/lib/crawl/second-review";
import { parseStaleReconcileArgs } from "@/lib/crawl/second-review-stale";

async function main(): Promise<number> {
  const args = parseStaleReconcileArgs(process.argv.slice(2), STALE_RECONCILE_TOOL_MAX);
  if (!args.apply) {
    console.log(JSON.stringify(await previewStaleSecondReviews({ afterCandidateId: args.after, limit: args.limit })));
    return 0;
  }
  let result: Awaited<ReturnType<typeof applyStaleSecondReviews>> | undefined;
  const run = await runJob<Record<string, unknown>>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("second_review_lease_missing");
    result = await applyStaleSecondReviews({ lease: ctx.lease, actor: args.actor!, afterCandidateId: args.after, limit: args.limit });
    // 잡 커서(staleReviewAfterCandidateId 등)는 그대로 두고, 잡의 원래 일(검수·등록)은 바로 다음 틱에 이어 한다
    return { done: false, continuation: "ready", cursor: ctx.cursor };
  });
  if (!result) {
    console.error(JSON.stringify({ mode: "apply", written: false, job: run }));
    return 3;
  }
  console.log(JSON.stringify({ ...result, job: { status: run.status } }));
  return 0;
}

main().then(code => process.exit(code)).catch(error => {
  console.error(error instanceof Error ? error.message : "ai2_stale_reconcile_failed");
  process.exit(1);
});
