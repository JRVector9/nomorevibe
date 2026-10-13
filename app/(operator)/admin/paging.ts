/**
 * 쪽 번호 줄. 처음·끝과 지금 쪽 앞뒤 둘을 보이고, 사이는 null(…)로 줄인다.
 * 쪽이 수십 개여도 한 줄에 들어간다 — 1 … 5 6 [7] 8 9 … 14
 */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const n of sorted) {
    const last = out.at(-1);
    // 한 쪽만 빠졌으면 줄임표 대신 그 쪽을 보인다 — "…"가 번호 하나보다 넓다
    if (typeof last === 'number' && n - last === 2) out.push(last + 1);
    else if (typeof last === 'number' && n - last > 2) out.push(null);
    out.push(n);
  }
  return out;
}
