export type SearchWindow = { from: string; to: string };

/** GitHub date ranges are inclusive, so adjacent windows differ by one second. */
export function splitSearchWindow(window: SearchWindow): [SearchWindow, SearchWindow] | null {
  const from = Math.floor(Date.parse(window.from) / 1000);
  const to = Math.floor(Date.parse(window.to) / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const middle = Math.floor((from + to) / 2);
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
  return [{from:iso(from),to:iso(middle)}, {from:iso(middle + 1),to:iso(to)}];
}
