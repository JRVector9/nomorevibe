import { logger } from "@/lib/observability/logger";
import { runtimeSettingsSnapshot } from "@/lib/operations/runtime-settings-store";

/**
 * 배정 표 읽기 스위치 — PR 3b-E 부터 runtime_settings 토글(`assignments.tableReads`: 'off' | 'on')을 읽는다.
 *
 * - 토글은 관리자(/admin/models/assignments 「배정 표 읽기」, /admin/models/limits 같은 묶음)가 저장하고, 모든 역할(웹·reviewer·text·소비자)이
 *   runtime_settings 의 30초 프로세스 스냅숏(lib/operations/runtime-settings-store, serving-contract-store 의 같은 reload)으로 읽는다 —
 *   재배포·재시작 없이 저장 즉시(30초 안) 바뀌고, 웹 배너·AI1·AI2·단계 풀·등록부·pipeline-control 스냅숏이 모두 이 한 함수를 읽어 어긋나지 않는다.
 *   잡 틱 안(withRuntimeSettings)에서는 그 틱이 고정한 판의 값이다 — 한 틱 안에서 출처가 바뀌지 않는다.
 * - env `MODEL_ASSIGNMENT_TABLE` 은 **비상 강제(override)** 로만 남는다: `1` = 토글과 무관하게 켬, `0` = 토글과 무관하게 끔(이 프로세스).
 *   없음·"" = 토글을 따른다(기본). 그 밖의 값 → 토글을 따르고 한 번 남긴다(`model_assignment_table.invalid`). env 는 프로세스 시작 때 한 번 읽는다.
 * - 토글을 아직 읽지 못했으면(`source: 'unread'` — 스냅숏이 DB 에서 온 적이 없다) 동기 고르기는 꺼짐(legacy)으로 본다. 비동기 길목
 *   (`requireStageAssignments`)은 DB 를 읽을 수 있는 프로세스에서 `assignments_unavailable` 로 미룬다 — 운영자가 켠 토글을 모른 채 예전 설정으로 고르지 않는다.
 *   DB 읽기 스위치가 꺼진 프로세스(MODEL_SERVING_CONTRACTS_DB=0·DATABASE_URL 없음)는 언제나 legacy 다.
 * - 리플레이는 토글·표를 읽지 않고 언제나 legacy 며 미루지도 않는다: replay DB 범위(`currentReplayDb()`, stage-assignment-snapshot 이 관문 앞단에서 가른다)와
 *   고정 입력 실행이 틱에 고정한 `source: 'replay'` 판(runtime-settings-store `replayRuntimeSettingsSnapshot`) — 그 판은 「아직 못 읽음」(unread)이 아니라
 *   그 실행이 정한 꺼짐이다(`assignmentTableReplayPinned()`).
 */
export const MODEL_ASSIGNMENT_TABLE_ENV = "MODEL_ASSIGNMENT_TABLE";

export type AssignmentTableOverride = "on" | "off";
export type AssignmentTableOverrideParse = Readonly<{ override: AssignmentTableOverride | null; invalid: boolean }>;
/** env 값 → 강제 켬/끔/없음. "1" 켬 · "0" 끔 · 없음·"" 없음 · 그 밖 없음 + invalid(잘못 쓴 값이 고르기를 바꾸지 않는다). */
export function parseAssignmentTableOverride(value: string | undefined): AssignmentTableOverrideParse {
  const raw = value?.trim() ?? "";
  if (raw === "") return { override: null, invalid: false };
  if (raw === "1") return { override: "on", invalid: false };
  if (raw === "0") return { override: "off", invalid: false };
  return { override: null, invalid: true };
}

/** 'env' = 강제(또는 시험 고정), 'runtime' = runtime_settings 토글, 'unread' = 토글을 아직 읽지 못했다(→ 꺼짐으로 본다) */
export type AssignmentFlagSource = "env" | "runtime" | "unread";
export type AssignmentFlag = Readonly<{ enabled: boolean; source: AssignmentFlagSource; override: AssignmentTableOverride | null }>;

const holder = globalThis as unknown as { __nmvAssignmentTableFlag?: { env: AssignmentTableOverride | null | undefined; override: boolean | null } };
const state = () => (holder.__nmvAssignmentTableFlag ??= { env: undefined, override: null });

function envOverride(): AssignmentTableOverride | null {
  const current = state();
  if (current.env === undefined) {
    const parsed = parseAssignmentTableOverride(process.env[MODEL_ASSIGNMENT_TABLE_ENV]);
    if (parsed.invalid) logger.warn("model_assignment_table.invalid", { env: MODEL_ASSIGNMENT_TABLE_ENV });
    current.env = parsed.override;
  }
  return current.env;
}

/** 지금 이 프로세스(또는 이 틱)의 스위치와 그 출처. 동기이며 던지지 않고 DB 를 읽지 않는다(스냅숏만). */
export function assignmentFlag(): AssignmentFlag {
  const current = state();
  if (current.override !== null) return { enabled: current.override, source: "env", override: current.override ? "on" : "off" };
  const env = envOverride();
  if (env) return { enabled: env === "on", source: "env", override: env };
  const snapshot = runtimeSettingsSnapshot();
  // 리플레이가 틱에 고정한 판: 토글을 읽지 않는 것이 그 실행의 결정이다 — 언제나 꺼짐(legacy), unread 로 미루지 않는다.
  if (snapshot.source === "replay") return { enabled: false, source: "runtime", override: null };
  if (snapshot.source !== "db") return { enabled: false, source: "unread", override: null };
  return { enabled: snapshot.settings.assignments.tableReads === "on", source: "runtime", override: null };
}

/** 지금 이 틱이 리플레이(고정 입력 실행)가 고정한 `source: 'replay'` 판에 묶였나 — 배정 표 관문은 이 틱에서 토글·표를 읽지 않고 미루지 않는다. */
export function assignmentTableReplayPinned(): boolean {
  return runtimeSettingsSnapshot().source === "replay";
}

/** 배정 표 읽기가 켜졌나(강제 → 토글 → 못 읽었으면 꺼짐). */
export function assignmentTableEnabled(): boolean {
  return assignmentFlag().enabled;
}

/** 시험: 스위치를 고정한다(null = 고정을 풀고 env 캐시도 지운다 — 다음 호출에서 env·토글을 다시 읽는다). */
export function setAssignmentTableEnabledForTest(value: boolean | null): void {
  const current = state();
  current.override = value;
  current.env = undefined;
}
