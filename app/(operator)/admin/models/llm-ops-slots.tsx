import { readLlmOps, readModelsDashboard } from "@/lib/operations/llm-ops-read";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { ModelsDashboard } from "./ModelsDashboard";
import { LlmOpsList } from "./llm/LlmOpsList";
import { ModelsHistory } from "./history/ModelsHistory";

/**
 * 「LLM 운영」 화면마다의 읽기 + 그리기(Suspense 안에서 기다린다). page.tsx 는 Next 가 정한 것만 내보낼 수 있어 여기 둔다 —
 * 시험은 이 함수를 그대로 기다려 그린다(저장소 모듈만 바꿔 끼운다).
 */
export async function ModelsDashboardSlot({ readOnly }: { readOnly: boolean }) {
  const { view, opsStates } = await readModelsDashboard();
  return <ModelsDashboard view={view} opsStates={opsStates} readOnly={readOnly} />;
}

export async function LlmOpsSlot({ readOnly, editId, adding }: { readOnly: boolean; editId: string | null; adding: boolean }) {
  const { view, secretBox } = await readLlmOps();
  return <LlmOpsList view={view} secretBox={secretBox} readOnly={readOnly} editId={editId} adding={adding} />;
}

export async function ModelsHistorySlot() {
  return <ModelsHistory observation={await readAdminModelsObservation({ throughput: false })} />;
}
