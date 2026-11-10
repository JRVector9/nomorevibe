import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ModelCapacityState } from "./capacity";

/**
 * 장부 상태 묶음 — 점유·한도·재접수·정책 변경 판정은 이 상수만 쓴다(리터럴 목록 금지).
 *
 * 2026-10-30 소유자 결정: "타임아웃으로 '확인 못함'으로 남기고 슬롯을 점유하지 못하게 하고 해당 작업은 종료시킨다.
 * 다른 제품들 검토에 방해를 줄 수 없다. 미확인은 사람이 검토하면 된다."
 * - `indeterminate` 행은 event·근거와 함께 사람 검토용으로 남지만 살아 있는 행이 아니다: 같은 logical/work key·owner·배치의 재접수를 막지 않고,
 *   정책 변경(옛 세대 판정)을 미루지 않는다(DRAIN·회수 절차 불필요). 아래 상수 묶음(LIVE·OCCUPYING·IN_FLIGHT)에는 들지 않는다.
 * - 늦게 온 종료 근거는 여전히 그 행을 정산한다(각 kind 의 settle 은 dispatched|indeterminate 를 받는다). 회수 도구는 법의학용으로 남는다.
 *
 * 2026-11-10 소유자 결정(결과 미확정 점유)으로 위 "슬롯을 점유하지 못하게"를 고쳤다: 취소가 없는 엔진(M1 mlx-lm·supa)은 기한 뒤에도 생성을 계속해
 * 칸을 바로 풀면 다음 호출이 그 뒤에 줄을 서 또 미확정이 됐다. indeterminate 행은 보낸 시각부터 유지 시간(runtime_settings
 * `capacity.unknownHoldSeconds`, 기본 600초, 0 = 예전처럼 세지 않음) 동안 장비 칸·모델 상한·경로 몫·도우미 칸에 dispatched 처럼 센다.
 * 그 판정은 상수 목록이 아니라 lib/llm/capacity-unknown-hold.ts 의 SQL 조각(slotHoldingSql·heldUnknownSql)만 쓴다 — 시각이 드는 판정이라서다.
 */
export const MODEL_CAPACITY_LIVE_STATES = Object.freeze(["waiting", "reserved", "dispatched"] as const satisfies readonly ModelCapacityState[]);
export const MODEL_CAPACITY_OCCUPYING_STATES = Object.freeze(["reserved", "dispatched"] as const satisfies readonly ModelCapacityState[]);
/** 결과를 아직 모르는 실제 전송. 예전의 `('dispatched','indeterminate')` fence 는 이 하나다. */
export const MODEL_CAPACITY_IN_FLIGHT_STATE = "dispatched" as const satisfies ModelCapacityState;
/** 늦은 종료 근거·법의학 회수가 받는 상태(정산 입력). 점유·fence 판정에는 쓰지 않는다. */
export const MODEL_CAPACITY_UNSETTLED_DISPATCH_STATES = Object.freeze(["dispatched", "indeterminate"] as const satisfies readonly ModelCapacityState[]);
/** 같은 정확한 단계가 이미 전송·정산됐다(체인 정확성 fence). 미확인도 "전송됨"이다 — 같은 단계 ID 를 다시 보내지 않는다. */
export const MODEL_CAPACITY_SENT_STATES = Object.freeze(["dispatched", "indeterminate", "settled"] as const satisfies readonly ModelCapacityState[]);
/** 끝나지 않은 모든 행(관측·표시용). 점유가 아니다. */
export const MODEL_CAPACITY_OPEN_STATES = Object.freeze(["waiting", "reserved", "dispatched", "indeterminate"] as const satisfies readonly ModelCapacityState[]);
/** 사람 검토 대기 상태. */
export const MODEL_CAPACITY_REVIEW_STATE = "indeterminate" as const satisfies ModelCapacityState;

/** dispatch_indeterminate 의 reason 목록(CHECK·zod·마이그레이션이 같은 값을 쓴다). 뜻은 lib/llm/capacity.ts 의 ModelCapacityIndeterminateReason 주석. */
export const MODEL_CAPACITY_INDETERMINATE_REASONS = Object.freeze(["transport_unknown", "local_abort", "process_exit", "commit_unknown", "client_timeout"] as const);

export type ModelCapacityLiveState = (typeof MODEL_CAPACITY_LIVE_STATES)[number];
export type ModelCapacityOccupyingState = (typeof MODEL_CAPACITY_OCCUPYING_STATES)[number];

const list = (states: readonly string[]) => `(${states.map(state => `'${state}'`).join(",")})`;
/** 원문 SQL 문자열(sql.raw·unsafe·스크립트용). 예: `('waiting','reserved','dispatched')` */
export const MODEL_CAPACITY_LIVE_STATES_SQL = list(MODEL_CAPACITY_LIVE_STATES);
export const MODEL_CAPACITY_OCCUPYING_STATES_SQL = list(MODEL_CAPACITY_OCCUPYING_STATES);
export const MODEL_CAPACITY_UNSETTLED_DISPATCH_STATES_SQL = list(MODEL_CAPACITY_UNSETTLED_DISPATCH_STATES);
export const MODEL_CAPACITY_SENT_STATES_SQL = list(MODEL_CAPACITY_SENT_STATES);
export const MODEL_CAPACITY_OPEN_STATES_SQL = list(MODEL_CAPACITY_OPEN_STATES);

const column = (value: SQLWrapper | string): SQL => typeof value === "string" ? sql.raw(value) : sql`${value}`;
/** `state IN ('waiting','reserved','dispatched')` — 살아 있는 행(재접수·중복 작업·busy 대상 판정). */
export const liveStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} IN ${sql.raw(MODEL_CAPACITY_LIVE_STATES_SQL)}`;
/** `state IN ('reserved','dispatched')` — 정책 변경·옛 세대 판정. 장비·모델·경로·도우미 칸 판정은 유지 시간 안의 미확정까지 세는 slotHoldingSql(capacity-unknown-hold.ts)을 쓴다. */
export const occupyingStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} IN ${sql.raw(MODEL_CAPACITY_OCCUPYING_STATES_SQL)}`;
/** `state = 'dispatched'` — 결과 모르는 실제 전송 하나. */
export const inFlightStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} = ${sql.raw(`'${MODEL_CAPACITY_IN_FLIGHT_STATE}'`)}`;
/** `state IN ('dispatched','indeterminate')` — 늦은 근거·법의학 회수 입력. */
export const unsettledDispatchStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} IN ${sql.raw(MODEL_CAPACITY_UNSETTLED_DISPATCH_STATES_SQL)}`;
/** `state IN ('dispatched','indeterminate','settled')` — 체인 정확성(같은 단계 재전송 금지). */
export const sentStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} IN ${sql.raw(MODEL_CAPACITY_SENT_STATES_SQL)}`;
/** `state IN ('waiting','reserved','dispatched','indeterminate')` — 관측·표시 전용. */
export const openStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} IN ${sql.raw(MODEL_CAPACITY_OPEN_STATES_SQL)}`;
/** `state = 'indeterminate'` — 사람 검토 목록. */
export const reviewStateSql = (state: SQLWrapper | string = "state"): SQL => sql`${column(state)} = ${sql.raw(`'${MODEL_CAPACITY_REVIEW_STATE}'`)}`;
