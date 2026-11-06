import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { flowModelTaskHref } from "@/lib/operations/flow-model-catalog";

export type AiTaskEditTarget = Readonly<{ href: string; label: string }>;

/**
 * 실행 쪽이 순위를 읽지 않는 작업의 실제 적용 설정 위치 — 순위 저장 화면 대신 이곳으로 보낸다.
 * 실행 쪽이 순위를 읽는 작업(live)은 null: 「작업 ↔ AI 모델」 순위 편집기가 실제 설정이다.
 * 위치는 flow-model-catalog 의 공용 편집 지도가 정한다.
 */
export function aiTaskEditTarget(id: string): AiTaskEditTarget | null {
  if (isAiLiveTask(id)) return null;
  const task = aiTask(id);
  return Object.freeze({ href: flowModelTaskHref(id), label: task?.group === "audit" ? "감사 실행 기록" : "실제 적용 모델 설정" });
}
