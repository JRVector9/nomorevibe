import { assignmentTableEnabled } from "@/lib/llm/assignment-flag";
import type { AssignmentStage } from "@/lib/llm/capacity-helpers";
import { assignmentSource, ensureStageAssignments } from "@/lib/llm/stage-assignment-snapshot";

/**
 * 단계별 모델 읽기 출처 — 배정 표(table)인가 설정(legacy)인가. 3b-B 의 실제 함수(assignmentTableEnabled()·assignmentSource(stage))를 읽는다.
 * 3b-D 화면(/admin/models/assignments 상태 띠, 크롤 설정·단계별 모델 폼의 읽기 전용 여부)은 이 모듈의 작은 계약만 쓴다.
 *
 * 플래그는 **이 웹 프로세스의** MODEL_ASSIGNMENT_TABLE(lib/llm/assignment-flag.ts, 프로세스마다 한 번 읽는다) — 소비자 역할의 스위치는 그 앱의 env 라
 * 웹과 같게 맞춰 켠다. 꺼짐(기본)이면 설정 폼은 그대로 편집되고 화면은 「읽기: 설정(legacy)…」를 보인다. 여기서 env 를 직접 읽지 않는다.
 * 출처: 3b-B 의 'table' → table, 'legacy_empty_table'(켜졌지만 그 단계에 쓸 실전 행이 없어 설정으로 고른다) → table(화면이 실전 행 수 0 을 보고
 * 「표 비어 있음」으로 보인다), 'legacy' → legacy. 못 읽으면 꺼짐·legacy(아래 assignmentTableFlag·assignmentSources 가 지킨다).
 */
export type AssignmentReadSource = "table" | "legacy";
export type AssignmentSourceReader = Readonly<{
  assignmentTableEnabled(): boolean | Promise<boolean>;
  assignmentSource(stage: AssignmentStage): AssignmentReadSource | Promise<AssignmentReadSource>;
}>;

/** 3b-B 의 읽기 출처(PR 3b-B 합침). 출처를 묻기 전에 배정 표 스냅숏을 새로 받는다(스위치가 꺼졌으면 곧 돌아온다, 못 읽으면 legacy). */
const TABLE_SOURCE_READER: AssignmentSourceReader = Object.freeze({
  assignmentTableEnabled: () => assignmentTableEnabled(),
  assignmentSource: async (stage: AssignmentStage): Promise<AssignmentReadSource> => {
    await ensureStageAssignments();
    return assignmentSource(stage) === "legacy" ? "legacy" : "table";
  },
});

let readerForTest: AssignmentSourceReader | null = null;
/** 테스트 전용 — 플래그가 켜진 화면(설정 폼 읽기 전용·상태 띠)을 그려 보려고 끼운다. null 이면 3b-B 의 실제 출처 */
export function setAssignmentSourceReaderForTest(reader: AssignmentSourceReader | null): void { readerForTest = reader; }
const reader = (): AssignmentSourceReader => readerForTest ?? TABLE_SOURCE_READER;

/** 플래그 MODEL_ASSIGNMENT_TABLE 이 이 프로세스에서 켜졌나(3b-B). 못 읽으면 꺼짐으로 본다(설정 폼을 막지 않는다) */
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
