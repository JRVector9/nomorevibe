import { logger } from "@/lib/observability/logger";

/**
 * 배정 표 읽기 스위치(PR 3b-B). 역할(Dokploy 앱)마다 env 로 켜고, 프로세스가 처음 물을 때 한 번만 읽는다
 * (PIPELINE_BACKGROUND_CONSUMER_VERSION 처럼 재시작해야 바뀐다).
 *
 * - `MODEL_ASSIGNMENT_TABLE=1` → 켬: 단계별 모델 고르기가 배정 표(model_helper_assignments role 'primary', mode 'live')를 먼저 본다.
 *   그 단계에 쓸 수 있는 live 행이 없으면 예전 설정(crawl_settings·stageModelPools·env)을 그대로 쓴다.
 * - 없음 · "" · "0" → 끔(기본): 오늘과 같은 경로. 배정 표를 읽는 SELECT 도 없다.
 * - 그 밖의 값 → 끔으로 보고 한 번 남긴다(`model_assignment_table.invalid`). 잘못 쓴 값이 고르기를 바꾸지 않는다.
 *
 * runtime_settings 키로 재배포 없이 켜는 길은 이 PR 에 없다 — 문서(model-helpers-admin.md 「읽기 전환」)에 이유를 적었다.
 */
export const MODEL_ASSIGNMENT_TABLE_ENV = "MODEL_ASSIGNMENT_TABLE";

export type AssignmentTableFlag = Readonly<{ enabled: boolean; invalid: boolean }>;
export function parseAssignmentTableFlag(value: string | undefined): AssignmentTableFlag {
  const raw = value?.trim() ?? "";
  if (raw === "" || raw === "0") return { enabled: false, invalid: false };
  if (raw === "1") return { enabled: true, invalid: false };
  return { enabled: false, invalid: true };
}

const holder = globalThis as unknown as { __nmvAssignmentTableFlag?: { value: boolean | null; override: boolean | null } };
const state = () => (holder.__nmvAssignmentTableFlag ??= { value: null, override: null });

/** 이 프로세스에서 배정 표 읽기가 켜졌나. 첫 호출에서 env 를 읽어 고정한다. */
export function assignmentTableEnabled(): boolean {
  const current = state();
  if (current.override !== null) return current.override;
  if (current.value === null) {
    const parsed = parseAssignmentTableFlag(process.env[MODEL_ASSIGNMENT_TABLE_ENV]);
    if (parsed.invalid) logger.warn("model_assignment_table.invalid", { env: MODEL_ASSIGNMENT_TABLE_ENV });
    current.value = parsed.enabled;
  }
  return current.value;
}

/** 시험: 스위치를 고정한다(null = 고정을 풀고 다음 호출에서 env 를 다시 읽는다). */
export function setAssignmentTableEnabledForTest(value: boolean | null): void {
  const current = state();
  current.override = value;
  current.value = null;
}
