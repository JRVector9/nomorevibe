/**
 * 시즌 열쇠를 사람이 읽는 이름으로(2026-10-08 UX 감사 UX-09·UX-39).
 *
 * 열쇠는 period.ts 가 만든다 — 주간 "2026-W41"(ISO 주), 월간 "2026-10", 주기가 바뀐 날 시작한 전환 시즌은 그 뒤에
 * "-transition-20261008"(한국 날짜)이 붙는다. 화면·제목은 "2026년 41주"처럼 쓴다. 모르는 꼴이면 열쇠를 그대로 돌려준다.
 *
 * @example
 * seasonLabel("2026-W41")                        // "2026년 41주"
 * seasonLabel("2026-10")                         // "2026년 10월"
 * seasonLabel("2026-W41-transition-20261008")    // "2026년 41주(10월 8일부터)"
 */
const SEASON_KEY = /^(\d{4})-(?:W(\d{2})|(\d{2}))(?:-transition-\d{4}(\d{2})(\d{2}))?$/;

export function seasonLabel(key: string): string {
  const match = SEASON_KEY.exec(key);
  if (!match) return key;
  const [, year, week, month, fromMonth, fromDay] = match;
  const period = week ? `${year}년 ${Number(week)}주` : `${year}년 ${Number(month)}월`;
  return fromMonth ? `${period}(${Number(fromMonth)}월 ${Number(fromDay)}일부터)` : period;
}
