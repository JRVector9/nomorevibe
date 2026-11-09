import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiTaskSlotRevision, type AiTasksAdminView } from "@/lib/operations/admin-ai-tasks-repository";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";
import { readAuditCampaignRunning, readJobPauses, readRecheckRejectsOpen } from "@/lib/operations/llm-ops-read";
import { buildTaskAssignView, taskAssignDeviceLimits, withTaskReadiness } from "@/lib/operations/llm-task-assign-view";
import { TaskAssignBoard } from "./TaskAssignBoard";

/**
 * 작업 배정 표의 읽기 + 그리기(Suspense 안에서 기다린다, llm-ops-slots.tsx 와 같은 방식). page.tsx 는 Next 가 정한 것만 내보낼 수 있어 여기 둔다.
 * 연결·순위·준비 상태·실행 쪽 순위 사정은 화면이 이미 읽은 readAiTasksAdminView 를 받고, 여기서는 장부 관측·잡 멈춤·진행 중 감사 여부만 더 읽는다(읽기 전용).
 * 순위 편집기(서랍)의 줄은 운영 홈과 같은 builder 에 모든 작업을 넣어 만든다 — 저장은 서랍의 기존 순위 저장뿐이다.
 */
export async function TaskAssignSlot({ view, executions, readOnly }: { view: AiTasksAdminView; executions: readonly AiTaskExecutionAdminView[] | null; readOnly: boolean }) {
  const now = new Date();
  const [observation, jobs, auditRunning, recheckRejectsOpen] = await Promise.all([readAdminModelsObservation({ throughput: false }).catch(() => unavailableAdminModels()),
    readJobPauses(now.getTime()), readAuditCampaignRunning(), readRecheckRejectsOpen()]);
  const assign = buildTaskAssignView({ now: now.toISOString(), observation, connections: view.connections, slots: view.slots, executions, jobs,
    facts: { auditRunning, connectionsRead: !view.errors.connections, recheckRejectsOpen } });
  const editor = withTaskReadiness(buildTaskRankEditor(view.connections, view.rows, aiTaskSlotRevision, executions ?? []), view.slots);
  const lockReason = readOnly ? "읽기 전용 미리보기 — 여기서는 저장할 수 없습니다."
    : executions === null ? "실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다." : null;
  return <TaskAssignBoard view={assign} editor={editor} devices={taskAssignDeviceLimits(observation)} lockReason={lockReason} />;
}
