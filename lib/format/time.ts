/**
 * 관리자 화면의 시각 표기 — 여기 하나로 모은다(2026-10-08 UX 감사 ADM-26).
 * 공개 화면의 날짜("10월 8일")는 아래 formatPublicDate·formatPublicDateTime 이다(UX-28).
 *
 * - 목록: 오늘이면 "13:38 (3분 전)", 오늘이 아니면 "10/7 21:15", 해가 다르면 "2025/10/7 21:15"
 * - 상세: "2026-10-08 13:38:13 KST"
 * - 시간대는 늘 Asia/Seoul 이다. 서버(UTC 컨테이너)와 브라우저(KST)가 같은 글자를 내야 hydration 이 어긋나지 않는다.
 *   그래서 로케일 문장(toLocaleString)을 쓰지 않고 숫자 조각만 받아 직접 잇는다 — ICU 판이 달라도 결과가 같다.
 * - "지금"에 따라 글자가 바뀌는 함수는 now 를 받는다. 서버가 읽은 시각(예: fetchedAt)을 화면까지 넘기면
 *   서버 그리기와 브라우저 그리기가 같은 글자를 낸다.
 *
 * 입력: drizzle 의 timestamp 열(시간대 없음)은 drizzle 이 "+0000"을 붙여 읽으므로 이미 맞는 Date 다.
 * 원시 SQL 결과나 JSON 으로 건너온 "2026-10-08 04:38:13"처럼 시간대 표시가 없는 글자는 UTC 벽시계로 읽는다 —
 * DB 시각 열이 그렇게 저장되기 때문이다(그냥 new Date 로 읽으면 KST 맥에서 9시간 밀린다).
 */

export const ADMIN_TIME_ZONE = "Asia/Seoul";

/** 시각으로 받을 수 있는 것 — 비었거나 읽을 수 없으면 빈 표시("—")를 낸다 */
export type TimeInput = Date | string | number | null | undefined;

const EMPTY = "—";
/** 시간대 표시가 없는 날짜+시각 글자("2026-10-08 04:38:13", "2026-10-08T04:38:13.123") */
const NO_OFFSET = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** 입력을 Date 로. 시간대 없는 글자는 UTC 로 읽는다. 비었거나 읽을 수 없으면 null */
export function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "string" && NO_OFFSET.test(value.trim())) date = new Date(`${value.trim().replace(" ", "T")}Z`);
  else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 한국 시각의 조각 — 시·분·초는 두 자리 글자 */
function kst(date: Date) {
  const part: Record<string, string> = {};
  for (const { type, value } of PARTS.formatToParts(date)) part[type] = value;
  return { year: Number(part.year), month: Number(part.month), day: Number(part.day), hour: part.hour, minute: part.minute, second: part.second };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 한국 날짜 "2026-10-08" — 날짜만 보이는 칸과 하루 단위 묶기에 */
export function formatDay(value: TimeInput, empty = EMPTY): string {
  const date = toDate(value);
  if (!date) return empty;
  const at = kst(date);
  return `${at.year}-${pad(at.month)}-${pad(at.day)}`;
}

/**
 * 지금과의 차이 "방금"·"3분 전"·"2시간 전"·"5일 전". 앞날이면 "3분 후".
 * 단위는 내림한다(3분 59초 → 3분). 1분이 안 되면 앞뒤 없이 "방금".
 */
export function formatAgo(value: TimeInput, now: Date | string | number, empty = EMPTY): string {
  const date = toDate(value);
  const base = toDate(now);
  if (!date || !base) return empty;
  const seconds = Math.trunc((base.getTime() - date.getTime()) / 1000);
  const size = Math.abs(seconds);
  if (size < 60) return "방금";
  const suffix = seconds > 0 ? "전" : "후";
  if (size < 3_600) return `${Math.floor(size / 60)}분 ${suffix}`;
  if (size < 86_400) return `${Math.floor(size / 3_600)}시간 ${suffix}`;
  return `${Math.floor(size / 86_400)}일 ${suffix}`;
}

/**
 * 목록 칸의 시각. 한국 날짜로 오늘이면 "13:38 (3분 전)", 아니면 "10/7 21:15", 해가 다르면 "2025/10/7 21:15".
 * now 는 서버가 읽은 시각을 넘긴다 — 서버와 브라우저가 같은 글자를 내게.
 */
export function formatListTime(value: TimeInput, now: Date | string | number, empty = EMPTY): string {
  const date = toDate(value);
  const base = toDate(now);
  if (!date || !base) return empty;
  const at = kst(date);
  const today = kst(base);
  const clock = `${at.hour}:${at.minute}`;
  if (at.year === today.year && at.month === today.month && at.day === today.day) return `${clock} (${formatAgo(date, base)})`;
  const day = `${at.month}/${at.day}`;
  return at.year === today.year ? `${day} ${clock}` : `${at.year}/${day} ${clock}`;
}

/** 상세 칸의 시각 "2026-10-08 13:38:13 KST" — 지금과 무관하다 */
export function formatDetailTime(value: TimeInput, empty = EMPTY): string {
  const date = toDate(value);
  if (!date) return empty;
  const at = kst(date);
  return `${at.year}-${pad(at.month)}-${pad(at.day)} ${at.hour}:${at.minute}:${at.second} KST`;
}

/**
 * 공개 화면의 날짜 — 하나의 형식으로(2026-10-08 UX 감사 UX-28). 올해면 "10월 8일", 해가 다르면 "2025년 10월 8일".
 * 한국 날짜로 가른다 — UTC 로는 12/31 이어도 한국으로 1/1 이면 새해다. 'KST' 는 붙이지 않는다(집계 기준 창에서 한 번만 밝힌다).
 * now 는 "올해"를 정하는 시각이다 — 서버가 읽은 시각을 넘겨야 연말에 서버와 브라우저가 같은 글자를 낸다.
 */
export function formatPublicDate(value: TimeInput, now: Date | string | number, empty = EMPTY): string {
  const date = toDate(value);
  const base = toDate(now);
  if (!date || !base) return empty;
  const at = kst(date);
  const day = `${at.month}월 ${at.day}일`;
  return at.year === kst(base).year ? day : `${at.year}년 ${day}`;
}

/** 공개 화면의 날짜와 시각 — "10월 8일 22:28", 해가 다르면 "2025년 10월 8일 22:28"(24시간제, 한국 시각) */
export function formatPublicDateTime(value: TimeInput, now: Date | string | number, empty = EMPTY): string {
  const date = toDate(value);
  const day = formatPublicDate(date, now, "");
  if (!date || !day) return empty;
  const at = kst(date);
  return `${day} ${at.hour}:${at.minute}`;
}
