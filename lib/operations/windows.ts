import { sql, type SQL } from "drizzle-orm";

/**
 * 관리자 숫자의 창 — "최근 1시간"·"오늘(한국 시각 0시부터)"·"최근 24시간".
 *
 * 7일·24시간처럼 굴러가는 창의 합계는 처리량이 고르면 늘 비슷한 수라 화면이 멈춘 것처럼 보였다. 그 옆에 짧은 창(1시간)과
 * 날짜로 끊는 창(오늘)을 함께 단다 — 같은 쿼리에서 FILTER 로 센다(따로 훑지 않는다).
 *
 * 시각 열은 시간대 없는 timestamp(UTC 벽시계)다. 한국 0시도 같은 모양(UTC 벽시계 timestamp)으로 돌려줘야
 * 열과 바로 견줄 수 있다 — 세션 시간대(TimeZone)에 기대지 않게 시간대를 모두 적는다.
 */
export function kstDayStart(end: SQL): SQL {
  return sql`(((date_trunc('day', ((${end}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')) AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC')`;
}

/** 짧은 창 둘 — 1시간·오늘. 합계 옆에 "최근 1시간 +N · 오늘(0시부터) N"으로 단다 */
export type FreshWindows = { hour: number; today: number };

export const WINDOW_TITLE = "최근 1시간은 60분 전부터 지금까지, 오늘은 한국 시각(KST) 0시부터 지금까지입니다.";

const fmt = (value: number) => value.toLocaleString("ko-KR");

/** 순증감처럼 부호가 뜻이 있는 수 — 0 이상이면 +를 붙인다(기존 "24h 발행 +N"과 같은 모양) */
export function signed(value: number): string {
  return value < 0 ? `-${fmt(-value)}` : `+${fmt(value)}`;
}

/** "최근 1시간 +3 · 오늘(0시부터) 41" — 1시간은 늘어난 수라 +를 붙이고, 오늘은 그날의 합이라 붙이지 않는다 */
export function freshWindowsLabel(windows: FreshWindows, options: { signedToday?: boolean } = {}): string {
  return `최근 1시간 ${signed(windows.hour)} · 오늘(0시부터) ${options.signedToday ? signed(windows.today) : fmt(windows.today)}`;
}
