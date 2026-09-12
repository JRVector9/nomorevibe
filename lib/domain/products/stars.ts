export const STAR_TIERS = [
  { key: 'rising', label: '떠오르는', range: '2천–5천 미만', min: 2000, max: 5000 },
  { key: 'noticed', label: '주목받는', range: '5천–1만 미만', min: 5000, max: 10000 },
  { key: 'popular', label: '인기', range: '1만–3만 미만', min: 10000, max: 30000 },
  { key: 'large', label: '대형', range: '3만–10만 미만', min: 30000, max: 100000 },
] as const;
export type StarTier = typeof STAR_TIERS[number]['key'];
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
