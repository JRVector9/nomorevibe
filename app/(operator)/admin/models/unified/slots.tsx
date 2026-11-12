import { aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { buildModelUnifiedFixture, MODEL_UNIFIED_FIXTURE_RECENT } from "@/lib/operations/model-unified-fixture";
import { readModelUnified } from "@/lib/operations/model-unified-read";
import { UnifiedModelsWorkspace } from "./UnifiedModelsWorkspace";
import { UnifiedOperations } from "./UnifiedOperations";

/** 인증은 page가 먼저 확인한다. 고정 자료는 환경의 읽기 전용 잠금이 켜졌을 때만 읽고 운영 조회를 생략한다. */
export async function UnifiedModelsSlot({ selected, readOnly, fixture = false, importPlan = false }: {
  selected: string | null; readOnly: boolean; fixture?: boolean; importPlan?: boolean;
}) {
  const isFixture = fixture && readOnly;
  const data = isFixture ? buildModelUnifiedFixture() : await readModelUnified({ readOnly, importPlan });
  return <>
    {isFixture && <p role="status" className="mu-preview-note">고정 데이터 미리보기 · 저장과 모델 호출을 사용할 수 없습니다.</p>}
    {Object.entries(data.tasks.errors).map(([key, error]) => <p key={key} role="alert" className="notice">작업 설정 {key}을(를) 읽지 못했습니다({aiTaskIssueMessage(error)}).</p>)}
    <UnifiedModelsWorkspace data={{ models: data.models, assignments: data.assignments, editor: data.editor, devices: data.devices,
      poolHelp: data.poolHelp, lockReason: data.lockReason, taskUses: data.taskUses, ranksReadable: data.ranksReadable }} selected={selected} readOnly={readOnly}>
      <UnifiedOperations data={data} readOnly={readOnly} recent={isFixture ? MODEL_UNIFIED_FIXTURE_RECENT : undefined} />
    </UnifiedModelsWorkspace>
  </>;
}
