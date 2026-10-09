/**
 * 공개 화면의 수 — 천 단위 쉼표 하나로(2026-10-08 UX 감사 UX-27). 같은 화면에 '2,126개'와 '2126개'가 함께 나오지 않게
 * 수는 모두 이것을 지나서 그린다. 단위("개"·"건")는 부르는 쪽이 붙인다.
 */

const EMPTY = "—";
const COUNT = new Intl.NumberFormat("ko-KR");

/** 셀 수 없는 값(null·undefined·NaN·무한)이면 empty */
function countable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 36155 → "36,155". 비었으면 "—"(바꿀 수 있다) */
export function formatCount(value: number | null | undefined, empty = EMPTY): string {
  return countable(value) ? COUNT.format(value) : empty;
}

/**
 * 정확하지 않은 수 — 유효숫자 두 자리로 반올림하고 "약"을 붙인다. 1779 → "약 1,800", 36155 → "약 36,000".
 * 의미 검색처럼 꼬리까지 세어 정확한 수처럼 보이면 안 되는 자리에 쓴다(UX-24 '약 n개'). 0 이하는 그대로 쓴다.
 */
export function formatApprox(value: number | null | undefined, empty = EMPTY): string {
  if (!countable(value)) return empty;
  if (value <= 0) return COUNT.format(value);
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
  return `약 ${COUNT.format(Math.round(value / unit) * unit)}`;
}
