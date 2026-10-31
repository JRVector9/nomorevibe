import type { AssignmentFlag } from "@/lib/llm/assignment-flag";
import type { AssignmentStage } from "@/lib/llm/capacity-helpers";
import { assignmentReadFlag, assignmentSource, ensureStageAssignments } from "@/lib/llm/stage-assignment-snapshot";

/**
 * 단계별 모델 읽기 출처 — 배정 표(table)인가 설정(legacy)인가. 3b-B 의 실제 함수(assignmentReadFlag()·assignmentSource(stage))를 읽는다.
 * 3b-D 화면(/admin/models/assignments 상태 띠, 크롤 설정·단계별 모델 폼의 읽기 전용 여부)은 이 모듈의 작은 계약만 쓴다.
 *
 * 스위치(PR 3b-E)는 runtime_settings 토글 `assignments.tableReads` 다 — 웹과 소비자 역할이 **같은 행**을 30초 스냅숏으로 읽으므로 웹이 「표」라 하면 소비자도
 * 30초 안에 표를 읽는다(역할마다 env 를 맞출 일이 없다). env MODEL_ASSIGNMENT_TABLE 은 이 프로세스의 강제(1 켬·0 끔)이고 띠가 「env 강제」로 드러낸다.
 * 출처를 묻기 전에 토글·배정 표 스냅숏을 새로 받는다(maxAge 0 — 관리자가 저장하고 새로고침하면 바로 보인다).
 * 'table' → table, 'legacy_empty_table'(켜졌지만 그 단계에 쓸 실전 행이 없어 설정으로 고른다) → table(화면이 실전 행 수 0 을 보고 「표 비어 있음」), 'legacy' → legacy.
 * 못 읽으면 꺼짐(unread)·legacy(아래 assignmentFlagState·assignmentSources 가 지킨다).
 */
export type AssignmentReadSource = "table" | "legacy";
export type AssignmentSourceReader = Readonly<{
  assignmentFlag(): AssignmentFlag | Promise<AssignmentFlag>;
  assignmentSource(stage: AssignmentStage): AssignmentReadSource | Promise<AssignmentReadSource>;
}>;

const UNREAD: AssignmentFlag = Object.freeze({ enabled: false, source: "unread", override: null });

/** 3b-B 의 읽기 출처(PR 3b-B 합침). 묻기 전에 토글·배정 표 스냅숏을 새로 받는다(DB 를 못 읽는 프로세스면 곧 돌아온다, 못 읽으면 legacy). */
const TABLE_SOURCE_READER: AssignmentSourceReader = Object.freeze({
  assignmentFlag: async (): Promise<AssignmentFlag> => {
    await ensureStageAssignments(0);
    return assignmentReadFlag();
  },
  assignmentSource: async (stage: AssignmentStage): Promise<AssignmentReadSource> => {
    await ensureStageAssignments(0);
    return assignmentSource(stage) === "legacy" ? "legacy" : "table";
  },
});

let readerForTest: AssignmentSourceReader | null = null;
/** 테스트 전용 — 스위치가 켜진 화면(설정 폼 읽기 전용·상태 띠)을 그려 보려고 끼운다. null 이면 3b-B 의 실제 출처 */
export function setAssignmentSourceReaderForTest(reader: AssignmentSourceReader | null): void { readerForTest = reader; }
const reader = (): AssignmentSourceReader => readerForTest ?? TABLE_SOURCE_READER;

/** 지금 스위치와 출처(runtime 토글·env 강제·아직 못 읽음). 못 읽으면 꺼짐·unread 로 본다(설정 폼을 막지 않는다) */
export async function assignmentFlagState(): Promise<AssignmentFlag> {
  try {
    const flag = await reader().assignmentFlag();
    return { enabled: flag.enabled === true, source: flag.source, override: flag.override ?? null };
  } catch { return UNREAD; }
}

/** 배정 표 읽기가 이 프로세스에서 켜졌나(3b-B). 못 읽으면 꺼짐으로 본다(설정 폼을 막지 않는다) */
export async function assignmentTableFlag(): Promise<boolean> {
  return (await assignmentFlagState()).enabled;
}

/** 단계마다의 읽기 출처. 못 읽은 단계는 'legacy'(설정)로 본다 */
export async function assignmentSources(stages: readonly AssignmentStage[]): Promise<Record<AssignmentStage, AssignmentReadSource>> {
  const entries = await Promise.all(stages.map(async stage => {
    try { return [stage, (await reader().assignmentSource(stage)) === "table" ? "table" : "legacy"] as const; }
    catch { return [stage, "legacy"] as const; }
  }));
  return Object.fromEntries(entries) as Record<AssignmentStage, AssignmentReadSource>;
}
