import type { JobContext, JobOutcome } from "./runner";
import { autoReclaimPolicies } from "@/lib/operations/model-capacity-auto-reclaim";
import type { ModelCapacityReclaimCursor } from "@/lib/operations/model-capacity-owner-gone";

const operator = () => `auto-reclaim:${(process.env.SERVICE_INSTANCE_ID ?? "worker").replace(/[^A-Za-z0-9._:-]/g, "-")}`.slice(0, 120);

/**
 * 미확인 점유 자동 해제(maintenance, 1분). 워커가 종료 증거(로컬 종료·프로세스 그룹 종료)를 기존 판정으로 다시 읽고,
 * 선언된 budget의 증거+기한이 충족된 행만 기존 장부 hook 으로 해제한다. 해제는 점유만 푼다(settled·사용량·업무 성공 아님).
 * 별도로, 소유자가 실제로 사라진 dispatched 는 기존 owner-gone 판정으로 미확정 검토 대기에 둔다(해제/성공 아님).
 * 선언이 없어도 이 bounded scan 은 돈다. 업무 재시도는 기존 시도 기록과 재시도 시각을 따르며 이 잡은 업무 결과를 쓰지 않는다.
 */
export async function reclaimEvidencedModelCapacity(ctx: JobContext<ModelCapacityReclaimCursor>): Promise<JobOutcome<ModelCapacityReclaimCursor>> {
  let cursor = ctx.cursor ?? null;
  if (ctx.lease && ctx.hasBudget() && !ctx.signal?.aborted) {
    const { markAutomaticOwnerGone } = await import("@/lib/operations/model-capacity-owner-gone");
    cursor = await markAutomaticOwnerGone(ctx, operator());
  }
  // Explicit cursor survives done:true so long-lived valid owners cannot keep
  // every scan at the head of the queue. No candidate means the old null cursor.
  const complete = (): { done: true; cursor?: ModelCapacityReclaimCursor } => cursor ? { done: true, cursor } : { done: true };
  const { policies, rejected } = autoReclaimPolicies(process.env.MODEL_CAPACITY_AUTO_RECLAIM);
  if (rejected.length) {
    ctx.log("model_capacity.auto_reclaim_rejected", { rejected });
    return { ...complete(), degraded: { code: "auto_reclaim_declaration_invalid", detail: "MODEL_CAPACITY_AUTO_RECLAIM 선언을 확인해야 합니다" } };
  }
  if (!policies.size || ctx.lease && (!ctx.hasBudget() || ctx.signal?.aborted)) return complete();
  const { runModelOpsRunner } = await import("@/lib/operations/ops-runner/runner");
  const { rows } = await runModelOpsRunner({ automatic: true, policies, operator: operator(), audit: (event, detail) => ctx.log(event, detail) });
  const released = rows.filter(row => row.released);
  if (rows.length) ctx.log("model_capacity.auto_reclaim", { released: released.length, kept: rows.length - released.length,
    rows: rows.slice(0, 16).map(row => ({ requestId: row.requestId, released: row.released, reason: row.reason })) });
  return complete();
}
