/** 한 줄 높이의 빈 자리(2026-11-15 공개 HTML 이름·요약만) — 글자 없이 그 줄의 글자 크기·줄 높이만 차지한다(.fill-line, components/home/cards.css) */
export function FillLine({ width }: { width: string }) {
  return <span className="fill-line" aria-hidden="true" style={{ width }} />;
}
