import Link from "next/link";
import { getSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { ADMIN_MODEL_STAGES, type AdminModelStage } from "@/lib/llm/admin-model-stages";
import { withAdminModelStage, withAdminStagePools } from "@/lib/llm/admin-model-pools";
import { modelForPurpose, modelRequestName, readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { readModelAssignments } from "@/lib/llm/capacity-helpers-repository";
import { listModelCapacityDevices } from "@/lib/llm/capacity-devices-repository";
import { assignmentSourceFor } from "@/lib/llm/stage-assignments";
import { assignmentFormOptions } from "@/lib/operations/admin-model-assignments";
import { assignmentFlagState } from "@/lib/operations/admin-assignment-source";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { logger } from "@/lib/observability/logger";
import { StageModelPoolsForm } from "../models/StageModelPoolsForm";
import { AssignmentForm, type AssignmentFormValues } from "../models/assignments/AssignmentForm";

const HUMAN_STAGES: readonly AdminModelStage[] = ["human-review", "split-confirm", "split-tiebreak", "held-review-retry"];

/** Reuses the existing settings CAS and registry; no model probe, new writer or task-rank migration. */
async function readHumanModelSettings() {
  try {
    const [settings, assignment] = await Promise.all([getSettings(), assignmentFlagState(), ensureServingContracts(0)]);
    const defaults = Object.fromEntries(ADMIN_MODEL_STAGES.filter(stage => HUMAN_STAGES.includes(stage.id)).map(stage => {
      try { return [stage.id, withAdminStagePools(settings.stageModelPools ?? {}, "flow-human-settings", () =>
        withAdminModelStage(stage.id, () => modelRequestName(modelForPurpose(stage.purpose))))]; }
      catch { return [stage.id, "기본 모델 미확인"]; }
    }));
    const models = readModelRegistry().models;
    const [assignments, devices] = assignment.enabled ? await Promise.all([readModelAssignments({ stage: "human" }), listModelCapacityDevices()]) : [[], []];
    const options = assignmentFormOptions(models, devices);
    options.stages = options.stages.filter(stage => stage.id === "human");
    return { pools: settings.stageModelPools ?? {}, models, defaults, assignments, options,
      humanUsesTable: assignmentSourceFor("human", assignment.enabled, assignments) === "table",
      version: settingsFormVersion(settings), unknown: assignment.source === "unread", tableOn: assignment.enabled };

  } catch (error) {
    logger.warn("flow.human_model_settings_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

export async function HumanModelSettings() {
  const data = await readHumanModelSettings();
  if (!data) return <p className="small muted">AI 보조 모델 설정을 읽지 못했습니다. <Link href="/admin/models?advanced=1#model-settings">실행 모델 설정 →</Link></p>;
  const readOnly = adminWorkspaceReadOnly() || data.unknown;
  return <div className="flow-human-model-settings">
    <p className="small muted">AI 위임·갈림 재확인·보류 재심사에 쓰는 기존 실행 설정입니다. 저장은 이후 작업부터 반영하며, 사람의 승인·반려 권한은 바뀌지 않습니다.</p>
    {data.unknown && <p role="alert" className="small muted">배정 출처를 읽지 못해 여기서는 저장할 수 없습니다. <Link href="/admin/models/assignments">배정 상태 확인 →</Link></p>}
    {data.tableOn && <section className="flow-human-assignment">
      <h4>사람 몫 AI 위임 · 실행 배정 표</h4>
      <p className="small muted">실전 배정을 다음 업무부터 읽습니다. 연결·계약·공유 한도를 통과해야 실제 호출합니다.</p>
      {!data.humanUsesTable && data.assignments.length > 0 && <p className="small muted">실전 배정이 없어 현재는 아래 기존 단계 모델을 사용합니다.</p>}
      {data.assignments.length ? data.assignments.map(row => {
        const initial: AssignmentFormValues = { assignmentId: row.assignmentId, version: row.version, stage: row.stage, deviceId: row.deviceId,
          registryKey: row.registryKey, transport: row.transport, rank: row.rank, vote: row.vote,
          mode: row.mode === "live" ? "live" : "off", maxSlots: row.maxSlots, note: row.note };
        return <details key={row.assignmentId} className="flow-human-assignment-row"><summary>
          {row.rank}순위 · {row.deviceId} · {row.model} · {row.mode === "live" ? "실전 배정" : "꺼짐"} · 편집</summary>
          <AssignmentForm options={data.options} initial={initial} readOnly={readOnly} />
        </details>;
      }) : <p className="small muted">배정 표에 사람 위임 모델이 없습니다. 현재는 기존 단계 설정을 사용합니다.</p>}
      <details className="flow-human-assignment-row"><summary className="text-button">사람 위임 모델 배정 추가</summary>
        <AssignmentForm options={data.options} initial={null} prefill={{ stage: "human" }} readOnly={readOnly} /></details>
    </section>}
    <StageModelPoolsForm pools={data.pools} models={data.models} defaults={data.defaults} version={data.version}
      stageIds={data.humanUsesTable ? HUMAN_STAGES.filter(stage => stage !== "human-review") : HUMAN_STAGES} readOnly={readOnly} />
  </div>;
}
