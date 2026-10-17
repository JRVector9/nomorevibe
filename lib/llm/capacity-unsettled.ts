import { logger } from "@/lib/observability/logger";
import type { ModelCapacityDispatch } from "./capacity";
import { markModelDispatchIndeterminate } from "./capacity-repository";

/**
 * 물리 종료(terminal·not_started) 정산 TX 가 실패했다(커밋 응답 모름 포함). 행이 dispatched 로 남지 않게 indeterminate(commit_unknown)로
 * 표시해 로컬 종료 증인·회수 경로에 둔다 — 이미 settled 로 커밋됐으면 바뀌지 않는다. 원 오류가 우선이라 이 표시의 실패는 남기고 삼킨다.
 */
export async function markUnsettledDispatch(dispatch: ModelCapacityDispatch): Promise<void> {
  try { await markModelDispatchIndeterminate(dispatch, "commit_unknown"); }
  catch (error) {
    logger.warn("model_capacity.unsettled_mark_failed", { requestId: dispatch.requestId,
      error: error instanceof Error ? error.message : String(error) });
  }
}
