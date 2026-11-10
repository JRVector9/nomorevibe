import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { MODEL_CAPACITY_OCCUPYING_STATES_SQL } from "./capacity-states";

/**
 * 결과 미확정 점유(소유자 결정 2026-11-10) — indeterminate 행이 유지 시간 동안 칸을 차지하는 규칙의 단일 출처.
 *
 * 왜: 취소가 없는 엔진(M1 mlx-lm `m1-gemma`, supa)은 클라이언트 기한이 지나도 생성을 계속한다. 10-30 규칙(미확정은 칸을 쥐지 않는다)으로는
 * 칸이 바로 풀려 다음 호출이 아직 도는 생성 뒤에 줄을 서고, 그 호출도 기한을 넘겨 미확정이 번졌다(11-09·10 운영: product-search-verify 약 1.5시간에
 * 0 → 17, reason-translate 0 → 7). PR #878 뒤 남은 미확정은 「보냈고 기한이 지났고 결과를 모른다」는 진짜 경우라 끝났다고 정산할 수도 없다.
 *
 * 규칙:
 * - indeterminate 행은 보낸 시각(dispatched_at, 없으면 미확정이 된 시각 = 그 행의 updated_at — 그 뒤로 상태를 바꾸지 않는 쓰기는 없다)부터
 *   유지 시간 동안 reserved·dispatched 와 똑같이 센다: 장비 칸(limit_slots·낮은 순위 합계·우선 역할 바쁨), 모델 상한(0170), 경로 몫(0169),
 *   도우미 배정 칸(0154), 정책 groupLimits 대체 한도. 입장(capacity-repository)과 관측(장비 상태·관리자 화면)이 같은 조각을 쓴다.
 * - 유지 시간이 지나면 세지 않는다. 행은 그대로 indeterminate 이고 사람 검토·재실행 목록에 지금처럼 남는다.
 * - 행의 상태·정산·종료 근거는 바꾸지 않는다(물리 종료를 꾸며내지 않는다). 닫힌 행(withdrawn·settled)은 당연히 쥐지 않는다.
 * - 유지 시간은 runtime_settings `capacity.unknownHoldSeconds`(관리자 「실시간 한도」)다. 0 이면 예전(10-30) 그대로 세지 않는다 — 그때 SQL 은 예전 글자 그대로다.
 * - 이 규칙과 무관한 것(10-30 그대로): 같은 작업 키·logical key 의 재접수 fence, 정책 변경(옛 세대) 판정·DRAIN, 회수(reclaim)·소유자 부재 판정.
 */
export const DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS = 600;
/** 상한 1시간 — 실시간 한도 화면의 다른 초 칸(호출 상한·틱 예산)과 같은 바닥·천장(초 칸에 ms 를 넣는 실수도 이 상한이 막는다). */
export const MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX = 3_600;
export const unknownHoldSecondsSchema = z.number().int().min(0).max(MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX);

/** 저장 문서의 `capacity.unknownHoldSeconds` 값 → 초. 없거나 읽을 수 없으면 기본값(resolveRuntimeSettings 와 같은 거르기). */
export function unknownHoldSecondsFromStored(raw: unknown): number {
  const parsed = unknownHoldSecondsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS;
}

/**
 * 지금의 유지 시간(ms)을 runtime_settings 행에서 바로 읽는다(30초 스냅숏이 아니다) — 입장 TX 는 control 잠금 아래에서 한 번 읽어 그 TX 의 모든 판정에 쓴다.
 * `whenReadable`: 관측 경로용. 이 표를 읽을 권한이 없는 계정(Oracle 감시자 nomorevibe_oracle_capacity_supervisor)은 TX 를 깨뜨리지 않고 기본값을 쓴다.
 */
export async function readModelCapacityUnknownHoldMs(executor: Pick<ProductTransaction, "execute">,
  options: { whenReadable?: boolean } = {}): Promise<number> {
  if (options.whenReadable) {
    const [grant] = await executor.execute<{ readable: boolean }>(sql`SELECT CASE WHEN to_regclass('public.runtime_settings') IS NULL THEN false
      ELSE has_table_privilege('public.runtime_settings', 'SELECT') END AS readable`);
    if (!grant?.readable) return DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS * 1000;
  }
  const [row] = await executor.execute<{ hold: unknown }>(sql`SELECT rs."values"->'capacity'->'unknownHoldSeconds' AS hold FROM runtime_settings rs WHERE rs.id = 1`);
  return unknownHoldSecondsFromStored(row?.hold) * 1000;
}

/**
 * 같은 값을 관측 한 문장 안에서 읽는 SQL 식(ms, integer) — 문장 수를 늘리지 않는 읽기(관리자 모델 관측의 control 읽기, 상태 화면 한 문장)용.
 * 거르기는 unknownHoldSecondsFromStored 와 같다(0~3600 정수 숫자만, 아니면 기본값). runtime_settings SELECT 권한이 있는 계정만 쓴다.
 */
export const storedUnknownHoldMsSql: SQL = sql`(SELECT CASE WHEN jsonb_typeof(h.v) = 'number' AND (h.v #>> '{}') ~ '^(0|[1-9][0-9]{0,3})$'
    AND (h.v #>> '{}')::integer <= ${sql.raw(String(MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX))}
  THEN (h.v #>> '{}')::integer ELSE ${sql.raw(String(DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS))} END * 1000
  FROM (SELECT (SELECT rs."values"->'capacity'->'unknownHoldSeconds' FROM runtime_settings rs WHERE rs.id = 1) AS v) h)`;

const SQL_ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;
function checkedHoldMs(unknownHoldMs: number): number {
  if (!Number.isSafeInteger(unknownHoldMs) || unknownHoldMs < 0 || unknownHoldMs > MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX * 1000)
    throw new Error("model_capacity_unknown_hold_invalid");
  return unknownHoldMs;
}
function checkedAlias(alias: string): SQL {
  if (!SQL_ALIAS.test(alias)) throw new Error("model_capacity_unknown_hold_alias");
  return sql.raw(alias);
}

/**
 * 장부 행 `alias` 가 유지 시간 안의 미확정 행인가. 0 이면 `false`. `unknownHoldMs` 는 ms 수(bind 값) 또는 같은 문장 안의 SQL 식(storedUnknownHoldMsSql).
 * 기준 시각은 스칼라 부분질의(InitPlan, 문장마다 한 번)라
 * 부분 색인 model_capacity_requests_unknown_hold_idx(0172: group_id, coalesce(dispatched_at, updated_at) WHERE state = 'indeterminate')의 범위 조건이 된다 —
 * 식 글자를 바꾸면 그 색인을 타지 않는다.
 */
export function heldUnknownSql(alias: string, unknownHoldMs: number | SQL): SQL {
  const r = checkedAlias(alias);
  if (typeof unknownHoldMs === "number" && checkedHoldMs(unknownHoldMs) === 0) return sql`false`;
  const hold = typeof unknownHoldMs === "number" ? sql`${unknownHoldMs}::integer` : sql`(${unknownHoldMs})::integer`;
  return sql`(${r}.state = 'indeterminate' AND coalesce(${r}.dispatched_at, ${r}.updated_at) > (SELECT clock_timestamp() - ${hold} * interval '1 millisecond'))`;
}

/** 장부 행 `alias` 가 칸을 쥐는가: reserved·dispatched, 또는 유지 시간 안의 indeterminate. 0 이면 `alias.state IN ('reserved','dispatched')`(예전 글자) 그대로다. */
export function slotHoldingSql(alias: string, unknownHoldMs: number): SQL {
  const r = checkedAlias(alias);
  const occupying = sql`${r}.state IN ${sql.raw(MODEL_CAPACITY_OCCUPYING_STATES_SQL)}`;
  return checkedHoldMs(unknownHoldMs) === 0 ? occupying : sql`(${occupying} OR ${heldUnknownSql(alias, unknownHoldMs)})`;
}
