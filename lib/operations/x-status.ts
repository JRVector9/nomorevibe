import { createHmac } from "node:crypto";

/**
 * X 수집기(osaka-smoke)의 하루 보고 — 서명한 push 로 받아 관측 표(operations_observations)의 한 줄에 둔다(운영센터 v8 PR9).
 *
 * 받는 쪽은 app/api/ops/x-status/route.ts, 보내는 쪽 계약은 docs/operations/2026-10-18-x-status-report-runbook.md 다.
 * 받는 웹에 비밀이 없으면 주소는 404 이고(DB 를 보지 않는다) 조치에도 띄우지 않는다 — 배포만으로는 아무것도 바뀌지 않는다.
 * 본문은 정해진 칸뿐이다. 자유 글자는 짧은 오류 코드 하나이고, 게시물 본문·작성자·저장소 이름은 받지 않는다.
 */
export const X_STATUS_KEY = "x-status";
export const X_STATUS_SECRET_ENV = "X_STATUS_REPORT_SECRET";
/** 비밀 교체 동안만 둔다 — 수집기가 새 비밀로 보고한 것을 확인하면 지운다 */
export const X_STATUS_PREVIOUS_SECRET_ENV = "X_STATUS_REPORT_SECRET_PREVIOUS";
export const X_STATUS_MIN_SECRET_BYTES = 32;
export const X_STATUS_MAX_BODY_BYTES = 4_096;
/** 보낸 시각(서명에 묶인 머리)과 받는 웹 시계의 허용 차이 */
export const X_STATUS_CLOCK_WINDOW_SECONDS = 300;
/** 받은 보고 사이의 최소 간격(DB 시계) — 서명·단조를 지난 뒤의 속도 제한. 거절은 아무것도 쓰지 않는다 */
export const X_STATUS_MIN_INTERVAL_SECONDS = 60;
/** 하루 한 번(00:10 UTC) 오는 보고가 이만큼 없으면 끊김 */
export const X_STATUS_STALE_HOURS = 26;
export const X_STATUS_TIMESTAMP_HEADER = "x-nmv-timestamp";
export const X_STATUS_SIGNATURE_HEADER = "x-nmv-signature";
/** 서명 문자열의 머리 — 다른 용도의 HMAC 을 이 주소에 다시 쓸 수 없게 */
const SIGNING_PREFIX = "nomorevibe-x-status-v1";

export type XStatusMode = "live" | "dry-run" | "disabled";
export type XStatusReport = {
  v: 1;
  mode: XStatusMode;
  /** 오늘(UTC) 예약한 읽기 수와 하루 상한 */
  reads: { used: number; limit: number };
  candidates: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  /** 짧은 오류 코드(소문자·숫자·_ 48자까지). 정상·하루 한도 도달은 null */
  error: string | null;
};
export type XStatusSecretSlot = "current" | "previous";
/** 저장한 줄 — 보고 + 서명에 묶인 보낸 시각(유닉스 초) + 어느 비밀로 맞았는지 */
export type XStatusRecord = XStatusReport & { sentAt: number; signedWith: XStatusSecretSlot };

type Env = Readonly<Record<string, string | undefined>>;

/** 받는 웹의 비밀 — 지금 비밀이 32바이트 미만이면 꺼짐(null). 직전 비밀은 지금 것과 다르고 32바이트 이상일 때만 */
export function xStatusSecrets(env: Env = process.env): { current: string; previous: string | null } | null {
  const current = env[X_STATUS_SECRET_ENV], previous = env[X_STATUS_PREVIOUS_SECRET_ENV];
  if (!current || Buffer.byteLength(current) < X_STATUS_MIN_SECRET_BYTES) return null;
  const usable = !!previous && previous !== current && Buffer.byteLength(previous) >= X_STATUS_MIN_SECRET_BYTES;
  return { current, previous: usable ? previous : null };
}

export function xStatusConfigured(env: Env = process.env): boolean {
  return xStatusSecrets(env) !== null;
}

/** HMAC-SHA256(비밀, "nomorevibe-x-status-v1\n<보낸 시각>\n" + 본문 바이트) */
export function xStatusDigest(secret: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${SIGNING_PREFIX}\n${timestamp}\n`).update(body).digest();
}

/** 서명 머리 값 — 보내는 쪽과 테스트가 같은 식을 쓴다 */
export function signXStatus(secret: string, timestamp: number, body: string | Uint8Array): string {
  return `v1=${xStatusDigest(secret, timestamp, body).toString("hex")}`;
}

const MODES: readonly string[] = ["live", "dry-run", "disabled"];
const REPORT_KEYS = ["v", "mode", "reads", "candidates", "lastRunAt", "lastSuccessAt", "error"];
const ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_COUNT = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const countUpTo = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** UTC ISO 시각 — null 은 없음, undefined 는 틀림. 보낸 시각보다 뒤일 수 없고, 없는 날짜(2월 30일)는 틀림 */
function instant(value: unknown, notAfterMs: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > notAfterMs) return undefined;
  const normalized = new Date(ms).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : undefined;
}

/** 받은 본문의 엄격한 형식 — 칸이 더 있거나 빠지거나 범위를 벗어나면 null */
export function parseXStatusReport(value: unknown, sentAt: number): XStatusReport | null {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS) || value.v !== 1) return null;
  const { mode, reads, candidates, error } = value;
  if (typeof mode !== "string" || !MODES.includes(mode)) return null;
  if (!isRecord(reads) || !hasExactKeys(reads, ["used", "limit"])) return null;
  const { used, limit } = reads;
  if (!countUpTo(limit, MAX_COUNT) || !countUpTo(used, limit) || !countUpTo(candidates, MAX_COUNT)) return null;
  const notAfterMs = (sentAt + 1) * 1_000;
  const lastRunAt = instant(value.lastRunAt, notAfterMs), lastSuccessAt = instant(value.lastSuccessAt, notAfterMs);
  if (lastRunAt === undefined || lastSuccessAt === undefined) return null;
  // 성공도 한 번의 실행이다 — 실행 없이 성공이 있거나 마지막 실행보다 뒤일 수 없다
  if (lastSuccessAt !== null && (lastRunAt === null || Date.parse(lastSuccessAt) > Date.parse(lastRunAt))) return null;
  if (error !== null && (typeof error !== "string" || !ERROR_CODE.test(error))) return null;
  return { v: 1, mode: mode as XStatusMode, reads: { used, limit }, candidates, lastRunAt, lastSuccessAt, error: error as string | null };
}

/** 저장한 줄을 읽는다 — 같은 형식 검사에 sentAt·signedWith 까지 */
export function parseXStatusRecord(value: unknown): XStatusRecord | null {
  if (!isRecord(value)) return null;
  const { sentAt, signedWith, ...rest } = value;
  if (!Number.isSafeInteger(sentAt) || (sentAt as number) <= 0 || (signedWith !== "current" && signedWith !== "previous")) return null;
  const report = parseXStatusReport(rest, sentAt as number);
  return report && { ...report, sentAt: sentAt as number, signedWith };
}

/**
 * - unconfigured: 받는 웹에 비밀이 없다(남은 줄은 화면용으로만 읽는다) · missing: 켜졌지만 아직 받은 보고가 없다(연결 전)
 * - invalid: 저장된 줄의 모양이 어긋남 · disabled: 마지막 보고가 꺼짐 · stale: 26시간 넘게 새 보고 없음 · error: 오류 코드 · ok
 */
export type XStatusState = "unconfigured" | "missing" | "invalid" | "disabled" | "ok" | "stale" | "error";
export type XStatusView = {
  state: XStatusState;
  report: XStatusRecord | null;
  /** DB 가 보고를 받은 시각(observed_at, DB 시계) — 수집기가 적은 시각이 아니다 */
  receivedAt: string | null;
  ageMs: number | null;
  stale: boolean;
};

/**
 * 이미 읽은 관측 줄(operationsData().observations)에서 x-status 를 꺼낸다 — 새 쿼리가 없다.
 * 나이는 화면을 그리는 시각(now)과 DB 가 받은 시각의 차이다.
 */
export function readXStatus(observations: readonly { key: string; value: unknown; observedAt: string | Date }[], now: string | Date,
  configured = xStatusConfigured()): XStatusView {
  const row = observations.find((item) => item.key === X_STATUS_KEY);
  const receivedMs = row ? new Date(row.observedAt).getTime() : Number.NaN;
  const receivedAt = Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : null;
  const ageMs = receivedAt ? new Date(now).getTime() - receivedMs : null;
  const stale = ageMs !== null && ageMs > X_STATUS_STALE_HOURS * 3_600_000;
  const report = row ? parseXStatusRecord(row.value) : null;
  const state: XStatusState = !configured ? "unconfigured" : !row ? "missing" : !report || !receivedAt ? "invalid"
    : report.mode === "disabled" ? "disabled" : stale ? "stale" : report.error ? "error" : "ok";
  return { state, report, receivedAt, ageMs, stale };
}
