import type { AssignmentStage } from "@/lib/llm/capacity-helpers";

/**
 * 단계별 모델 읽기 출처 — 배정 표(table)인가 설정(legacy)인가. **3b-B 가 실제 함수(assignmentTableEnabled()·assignmentSource(stage))를 넣는다.**
 * 3b-D 화면(/admin/models/assignments 상태 띠, 크롤 설정·단계별 모델 폼의 읽기 전용 여부)은 이 모듈의 작은 계약만 쓴다.
 *
 * 자리표: 플래그는 늘 꺼짐, 모든 단계는 'legacy'. 그래서 기본값에서는 설정 폼이 그대로 편집 가능하고, 화면은
 * 「읽기: 설정(legacy). 플래그 MODEL_ASSIGNMENT_TABLE 켜면 표를 읽습니다」를 보인다. 여기서 env 를 직접 읽지 않는다 — 읽는 쪽(hot path)이
 * 아직 설정을 읽는데 화면만 표를 가리키면 운영자가 설정을 못 바꾸게 되므로, 플래그 해석은 3b-B 한 곳에만 둔다.
 */
export type AssignmentReadSource = "table" | "legacy";
export type AssignmentSourceReader = Readonly<{
  assignmentTableEnabled(): boolean | Promise<boolean>;
  assignmentSource(stage: AssignmentStage): AssignmentReadSource | Promise<AssignmentReadSource>;
}>;

// 3b-B: wire assignmentSource() — 이 자리표를 3b-B 의 assignmentTableEnabled()·assignmentSource(stage) 로 바꾼다(형은 위 AssignmentSourceReader).
const LEGACY_SOURCE_READER: AssignmentSourceReader = Object.freeze({
  assignmentTableEnabled: () => false,
  assignmentSource: () => "legacy" as const,
});

let readerForTest: AssignmentSourceReader | null = null;
/** 테스트 전용 — 플래그가 켜진 화면(설정 폼 읽기 전용·상태 띠)을 그려 보려고 끼운다. null 이면 자리표 */
export function setAssignmentSourceReaderForTest(reader: AssignmentSourceReader | null): void { readerForTest = reader; }
const reader = (): AssignmentSourceReader => readerForTest ?? LEGACY_SOURCE_READER;

/** 플래그 MODEL_ASSIGNMENT_TABLE 이 켜졌나(3b-B). 못 읽으면 꺼짐으로 본다(설정 폼을 막지 않는다) */
export async function assignmentTableFlag(): Promise<boolean> {
  try { return (await reader().assignmentTableEnabled()) === true; } catch { return false; }
}

/** 단계마다의 읽기 출처. 못 읽은 단계는 'legacy'(설정)로 본다 */
export async function assignmentSources(stages: readonly AssignmentStage[]): Promise<Record<AssignmentStage, AssignmentReadSource>> {
  const entries = await Promise.all(stages.map(async stage => {
    try { return [stage, (await reader().assignmentSource(stage)) === "table" ? "table" : "legacy"] as const; }
    catch { return [stage, "legacy"] as const; }
  }));
  return Object.fromEntries(entries) as Record<AssignmentStage, AssignmentReadSource>;
}
