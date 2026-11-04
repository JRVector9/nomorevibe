import "server-only";
import { logger } from "@/lib/observability/logger";
import { aiTaskSlotRevision, listAiConnections, listAiTaskRows } from "./admin-ai-tasks-repository";
import { buildFlowRankEditor, type FlowRankEditor } from "./flow-rank-editor";

/**
 * 전체 흐름 「바꾸기」 서랍의 읽기 — 읽기만 한다. 「작업 ↔ AI 모델」 화면과 같은 목록(listAiConnections·listAiTaskRows)과 같은 줄 판(aiTaskSlotRevision)이다.
 * 그 화면의 읽기(readAiTasksAdminView)는 부르지 않는다 — 리뷰 순위 스냅숏 맞추기·키 자동 채움 같은 쓰기가 섞여 있어서다(전체 흐름은 읽기만 한다).
 * 못 읽으면 null — 서랍은 「순위를 읽지 못해 여기서 바꿀 수 없음」으로 보이고 「작업 ↔ AI 모델」로 보낸다.
 */
export async function readFlowRankEditor(): Promise<FlowRankEditor | null> {
  try {
    const [connections, rows] = await Promise.all([listAiConnections(), listAiTaskRows()]);
    return buildFlowRankEditor(connections, rows, aiTaskSlotRevision);
  } catch (error) {
    logger.warn("flow.rank_editor_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
