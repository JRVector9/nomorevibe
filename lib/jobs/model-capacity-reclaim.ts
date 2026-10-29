import type { JobContext, JobOutcome } from "./runner";
import { autoReclaimPolicies } from "@/lib/operations/model-capacity-auto-reclaim";

const operator = () => `auto-reclaim:${(process.env.SERVICE_INSTANCE_ID ?? "worker").replace(/[^A-Za-z0-9._:-]/g, "-")}`.slice(0, 120);

/**
 * 미확인 점유 자동 해제(maintenance, 1분). 워커가 종료 증거(로컬 종료·프로세스 그룹 종료)를 기존 판정으로 다시 읽고,
 * 선언된 budget의 증거+기한이 충족된 행만 기존 장부 hook 으로 해제한다. 해제는 점유만 푼다(settled·사용량·업무 성공 아님).
 * 업무 재시도는 기존 시도 기록(최대 3회)과 재시도 시각을 따른다. 이 잡은 업무 결과를 쓰지 않는다.
 */
export async function reclaimEvidencedModelCapacity(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const { policies, rejected } = autoReclaimPolicies(process.env.MODEL_CAPACITY_AUTO_RECLAIM);
  if (rejected.length) {
    ctx.log("model_capacity.auto_reclaim_rejected", { rejected });
    return { done: true, degraded: { code: "auto_reclaim_declaration_invalid", detail: "MODEL_CAPACITY_AUTO_RECLAIM 선언을 확인해야 합니다" } };
  }
  if (!policies.size) return { done: true };
  const { releaseEvidencedDispatches } = await import("@/lib/operations/dr/reclaim");
  const { rows } = await releaseEvidencedDispatches({ policies, operator: operator(), onlyDeclaredBudgets: true }, true);
  const released = rows.filter(row => row.released);
  if (rows.length) ctx.log("model_capacity.auto_reclaim", { released: released.length, kept: rows.length - released.length,
    rows: rows.slice(0, 16).map(row => ({ requestId: row.requestId, released: row.released, reason: row.reason })) });
  return { done: true };
}
