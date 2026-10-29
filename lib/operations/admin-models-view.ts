export const modelIdentityKey = (row: { routeId: string; provider: string; model: string }) => JSON.stringify([row.routeId, row.provider, row.model]);

export function elapsedModelTime(at: string, observedAt: string | null): string {
  if (!observedAt) return "미확인";
  const seconds = Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds}초` : seconds < 3600 ? `${Math.floor(seconds / 60)}분` : `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`;
}
