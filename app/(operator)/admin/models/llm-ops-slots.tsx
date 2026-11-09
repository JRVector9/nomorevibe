import { readLlmHistory, readLlmOps, readModelsDashboard } from "@/lib/operations/llm-ops-read";
import { buildRetryView, type LlmHistoryFilter } from "@/lib/operations/llm-ops-history";
import { canRequeueUnknownRoute } from "@/lib/operations/model-capacity-requeue";
import type { LlmFixField } from "@/lib/operations/llm-ops-links";
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

export async function LlmOpsSlot({ readOnly, editId, fix = null, adding }: { readOnly: boolean; editId: string | null; fix?: LlmFixField | null; adding: boolean }) {
  const { view, secretBox } = await readLlmOps();
  return <LlmOpsList view={view} secretBox={secretBox} readOnly={readOnly} editId={editId} fix={fix} adding={adding} />;
}

/** 서버가 그리기 시작한 시각 — 변경 기록의 「몇 분 전」. 구성 요소 밖에서 읽는다(렌더 순수성 규칙). */
const renderClock = () => new Date();

export async function ModelsHistorySlot({ filter, readOnly }: { filter: LlmHistoryFilter; readOnly: boolean }) {
  const { queue, observation, changes, preview } = await readLlmHistory(filter);
  return <ModelsHistory retry={buildRetryView(queue, canRequeueUnknownRoute, preview)} observation={observation} changes={changes} filter={filter} now={renderClock()} readOnly={readOnly} />;
}
