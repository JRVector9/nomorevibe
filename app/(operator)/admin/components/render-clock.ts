/**
 * 화면(페이지)을 서버가 그린 시각 — 관리자 머리 갱신 줄의 "마지막 갱신"이 읽는다.
 *
 * 공유 레이아웃은 화면을 옮길 때 다시 그려지지 않는다. 그래서 페이지마다 PageStamp(서버가 그린 시각)를 두고, 그 값을 여기에 올린다 —
 * 화면 이동·주소의 거르기(?…)만 바뀐 이동·자동 갱신·새로고침 모두 페이지를 다시 그리므로 그때마다 바뀐다.
 * 뒤로 가기로 담아 둔 화면이 돌아오면 그 화면의 옛 시각이 그대로 보인다(그 뒤 곧바로 다시 읽는다).
 */
let latest: string | null = null;
const listeners = new Set<() => void>();

export function publishRenderedAt(at: string): void {
  if (latest === at || !Number.isFinite(Date.parse(at))) return;
  latest = at;
  for (const listener of listeners) listener();
}

export function subscribeRenderedAt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const renderedAtSnapshot = () => latest;
