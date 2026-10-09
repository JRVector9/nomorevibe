/** 구간 이름은 범위로만 쓴다('2천+') — '떠오르는'·'주목받는'이 '지금 뜨는'(스타 증가)과 헷갈렸다(2026-10-08 UX 감사 UX-35) */
export const STAR_TIERS = [
  { key: 'rising', label: '2천+', range: '2천–5천 미만', min: 2000, max: 5000 },
  { key: 'noticed', label: '5천+', range: '5천–1만 미만', min: 5000, max: 10000 },
  { key: 'popular', label: '1만+', range: '1만–3만 미만', min: 10000, max: 30000 },
  { key: 'large', label: '3만+', range: '3만–10만 미만', min: 30000, max: 100000 },
] as const;
export type StarTier = typeof STAR_TIERS[number]['key'];
/**
 * 스타 비교 구간의 최소 길이(시간). 저장소 확인(product-stars-refresh)은 하루에 한 번보다 조금 잦게(20시간마다) 돌고,
 * 지금 값이 이보다 오래됐을 때만 지금 값을 이전 값으로 넘긴다 — 그래서 두 관측 사이는 늘 20시간 이상이다.
 * 급상승의 하루 평균(repository.ts starGainPerDay)도 이 길이 아래로는 나누지 않는다.
 */
export const STARS_BASELINE_HOURS = 20;
export function starTier(stars: number): StarTier | null {
  return STAR_TIERS.find(t => stars >= t.min && stars < t.max)?.key ?? null;
}
export function parseRepositoryStats(meta: Record<string, unknown>): { stars: number; ownerType: 'User' | 'Organization' | null } | null {
  const stars = meta.stargazers_count;
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 0 || stars > 2147483647) return null;
  const type = meta.owner && typeof meta.owner === 'object' ? (meta.owner as {type?: unknown}).type : null;
  return { stars, ownerType: type === 'User' || type === 'Organization' ? type : null };
}
type Params = Record<string, string | string[] | undefined>;
export function parsePopularParams(params: Params): {tier: StarTier; personal: boolean; page: number} {
  const first = (value: Params[string]) => Array.isArray(value) ? value[0] : value;
  const tier = STAR_TIERS.find(t => t.key === first(params.tier))?.key ?? 'rising';
  const page = Number(first(params.page));
  return { tier, personal: first(params.personal) === '1', page: Number.isSafeInteger(page) && page >= 1 && page <= 10000 ? page : 1 };
}
export function popularHref(tier: StarTier, personal = false, page = 1) {
  const query = new URLSearchParams({tier});
  if (personal) query.set('personal','1');
  if (page > 1) query.set('page',String(page));
  return `/popular?${query}`;
}
