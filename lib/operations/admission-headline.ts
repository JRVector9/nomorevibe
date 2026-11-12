import { ADMISSION_HREF, CONSOLE_TASK_LIMITS, formatDuration, formatKst, formatKstTime } from "./console-tasks";

/**
 * 머리줄의 접수 표시(운영 콘솔 개편 조각 4b) — 순수 함수. 읽기는 admission-status.ts, 그리기는 AdminShell.
 * 상태는 점 하나 + 짧은 말: 열림(초록) · 중단(30분 전 주황, 넘으면 빨강 — 홈 할 일 「멈춤」과 같은 기준) · 꺼짐(회색) · 셀 수 없음(회색).
 */
export type AdmissionMode = "open" | "draining" | "disabled";
export type AdmissionStatus = { mode: AdmissionMode; since: string | null; actor: string | null };

const MODES: readonly string[] = ["open", "draining", "disabled"];
const iso = (value: unknown): string | null => value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : null)
  : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/**
 * DB 한 줄 → 상태. 접수를 바꾼 마지막 작업 로그 줄의 모드가 지금 모드와 같을 때만 그 줄의 때·사람을 쓴다
 * (다르면 — 기록 없이 바뀌었거나 옛 줄 — 행이 바뀐 때만 쓰고 사람은 모름). 모르는 모드는 null.
 */
export function admissionStatusFrom(row: { mode?: unknown; updated_at?: unknown; actor?: unknown; at?: unknown; last_mode?: unknown } | null): AdmissionStatus | null {
  if (!row || typeof row.mode !== "string" || !MODES.includes(row.mode)) return null;
  const matched = row.last_mode === row.mode;
  return { mode: row.mode as AdmissionMode, since: (matched ? iso(row.at) : null) ?? iso(row.updated_at),
    actor: matched && typeof row.actor === "string" && row.actor.trim() ? row.actor.trim().slice(0, 60) : null };
}

export type AdmissionHeadline = { mode: AdmissionMode | null; tone: "ok" | "warn" | "bad" | "off"; label: string;
  /** 누르면 가는 곳 — 기존 접수 칸(ADMISSION_HREF) */
  href: string;
  /** 「08:08부터 · JR · 18분」 — 모르면 null */
  detail: string | null;
  /** 마우스를 올리면 보이는 한 줄 */
  title: string };

const WORD: Record<AdmissionMode, string> = { open: "열림", draining: "중단", disabled: "꺼짐" };

export function admissionHeadline(status: AdmissionStatus | null, nowMs: number): AdmissionHeadline {
  if (!status) return { mode: null, tone: "off", label: "접수 셀 수 없음", href: ADMISSION_HREF, detail: null, title: "모델 접수 상태를 읽지 못했습니다 — 누르면 접수 칸으로 갑니다" };
  const since = status.since ? Date.parse(status.since) : NaN;
  const minutes = Number.isFinite(since) ? Math.max(0, (nowMs - since) / 60_000) : null;
  // 하루 가까이 지난 때는 날짜까지
  const when = Number.isFinite(since) ? `${nowMs - since > 20 * 3_600_000 ? formatKst(since) : formatKstTime(since)}부터` : null;
  const detail = [when, status.actor, status.mode === "draining" && minutes !== null ? formatDuration(minutes) : null].filter(Boolean).join(" · ") || null;
  const tone = status.mode === "open" ? "ok" : status.mode === "disabled" ? "off"
    : minutes !== null && minutes * 60_000 > CONSOLE_TASK_LIMITS.admissionPausedMs ? "bad" : "warn";
  const label = `접수 ${WORD[status.mode]}`;
  return { mode: status.mode, tone, label, detail, href: ADMISSION_HREF,
    title: `${label}${detail ? ` · ${detail}` : ""} — 누르면 접수 칸(모델 › 고급 설정 › 대시보드)으로 갑니다. 멈추고 여는 데는 사유가 필요합니다.` };
}
