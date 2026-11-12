import "server-only";
import { isRetiredAiTask, RETIRED_AI_TASKS } from "@/lib/llm/ai-tasks";
import { withReadOnlyAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { unavailableAdminModels } from "./admin-models-observation";
import { readAdminModelsObservation } from "./admin-models-repository";
import { readAiTaskExecutionAdminViews } from "./admin-ai-task-execution";
import { aiTaskSlotRevision, previewAiTaskImport, readAiTasksAdminView } from "./admin-ai-tasks-repository";
import { JOB_CONCURRENCY_CONTROL, readSettingsControl } from "./admin-runtime-settings";
import { buildTaskRankEditor } from "./flow-rank-editor";
import { buildTaskAssignView, taskAssignDeviceLimits, withTaskReadiness } from "./llm-task-assign-view";
import { assistTasksOff, readAssistControls } from "./llm-assist-controls";
import { readAuditCampaignRunning, readJobPauses, readLlmChangeLog, readRecheckOff, readRecheckRejectsOpen } from "./llm-ops-read";
import { readModelConsole } from "./model-console-read";
import { readPoolHelpContext } from "./pool-help-read";
import { unifiedModelTaskUses } from "./model-unified-view";

/**
 * 통합 모델 화면의 조회만 모은다. 기존 작업 조회의 키 자동 채움도 명시적으로 끈다.
 * 순위·실행 방식·도움말·관측·보강 제어·실시간 한도·기록은 기존 조회를 사용하고, 렌더 중 저장·프로브·정책 변경은 하지 않는다.
 */
export async function readModelUnified({ readOnly, importPlan = false }: { readOnly: boolean; importPlan?: boolean }) {
  return withReadOnlyAiTaskModels(() => readModelUnifiedSnapshot({ readOnly, importPlan }));
}

async function readModelUnifiedSnapshot({ readOnly, importPlan }: { readOnly: boolean; importPlan: boolean }) {
  const now = new Date();
  const [models, tasks, executions, observation, jobs, auditRunning, recheckRejectsOpen, recheckOff, assist, concurrency, poolHelp, importPreview, changes] = await Promise.all([
    readModelConsole(), readAiTasksAdminView({ readOnly: true }), readAiTaskExecutionAdminViews().catch(() => null),
    readAdminModelsObservation({ throughput: false }).catch(() => unavailableAdminModels()), readJobPauses(now.getTime()),
    readAuditCampaignRunning(), readRecheckRejectsOpen(), readRecheckOff(), readAssistControls(), readSettingsControl(JOB_CONCURRENCY_CONTROL),
    readPoolHelpContext().catch(() => null), importPlan ? previewAiTaskImport() : Promise.resolve(null),
    readLlmChangeLog({ kind: null, failedOnly: false, before: null }, 3),
  ]);
  const assignments = buildTaskAssignView({ now: now.toISOString(), observation, connections: tasks.connections, slots: tasks.slots, executions, jobs,
    facts: { auditRunning, connectionsRead: !tasks.errors.connections, recheckRejectsOpen, recheckOff,
      assistOff: assistTasksOff(assist.error ? null : assist.controls) } });
  const editor = withTaskReadiness(buildTaskRankEditor(tasks.connections, tasks.rows, aiTaskSlotRevision, executions ?? []), tasks.slots);
  const retired = [...new Set(tasks.rows.filter(row => isRetiredAiTask(row.task)).map(row => `${row.task}#${row.slot}`))].map(key => {
    const [task, slot] = key.split("#");
    const rows = tasks.rows.filter(row => row.task === task && row.slot === Number(slot));
    return { task, slot: Number(slot), count: rows.length, revision: aiTaskSlotRevision(rows), label: RETIRED_AI_TASKS[task] ?? task };
  });
  return { now: now.toISOString(), models, assignments, editor, devices: taskAssignDeviceLimits(observation), poolHelp, tasks, assist, concurrency,
    importPreview, retired, changes, taskUses: unifiedModelTaskUses(assignments), ranksReadable: !tasks.errors.rows && !tasks.errors.connections && executions !== null,
    taskUsesReadable: executions !== null && ["rows", "connections", "current", "readiness"].every(key => !tasks.errors[key]),
    retiredReadable: !tasks.errors.rows, retiredError: tasks.errors.rows || null,
    lockReason: readOnly ? "읽기 전용 미리보기 — 여기서는 저장할 수 없습니다."
      : executions === null ? "실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다."
        : tasks.errors.rows || tasks.errors.connections || tasks.errors.readiness ? "작업 순위·연결·준비 상태를 읽지 못했습니다 — 확인할 때까지 저장할 수 없습니다." : null };
}

export type ModelUnifiedRead = Awaited<ReturnType<typeof readModelUnified>>;
