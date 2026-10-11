import { CATEGORIES, type Category } from './categories';

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

/** /popular 정렬 — 스타 많은 순(기본), 요즘 많이 는 순(하루 평균 증가, 홈 '지금 뜨는'과 같은 식) */
export const POPULAR_SORTS = ['stars', 'rising'] as const;
export type PopularSort = typeof POPULAR_SORTS[number];
/** /popular 보기 — 목록(기본) · 카드(/c 분야 화면과 같은 카드) */
export const POPULAR_VIEWS = ['list', 'cards'] as const;
export type PopularView = typeof POPULAR_VIEWS[number];

/**
 * /popular 주소의 상태 — 구간·개인 계정·AI로 제작·분야·정렬·보기·쪽.
 * AI·분야는 홈 거르기와 같은 주소 말(?ai=made, 분야는 소문자 slug)을 쓴다(browse-state.ts).
 */
export type PopularState = {
  tier: StarTier;
  personal: boolean;
  ai: boolean;
  category: Category | null;
  sort: PopularSort;
  view: PopularView;
  page: number;
};

export function parsePopularParams(params: Params): PopularState {
  const first = (value: Params[string]) => Array.isArray(value) ? value[0] : value;
  const tier = STAR_TIERS.find(t => t.key === first(params.tier))?.key ?? 'rising';
  const page = Number(first(params.page));
  const category = first(params.category)?.trim().toLowerCase();
  const sort = POPULAR_SORTS.find(s => s === first(params.sort)) ?? 'stars';
  const view = POPULAR_VIEWS.find(v => v === first(params.view)) ?? 'list';
  return {
    tier,
    personal: first(params.personal) === '1',
    ai: first(params.ai) === 'made',
    category: category ? CATEGORIES.find(c => c.toLowerCase() === category) ?? null : null,
    sort,
    view,
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10000 ? page : 1,
  };
}

/** 지금 상태에서 몇 가지만 바꾼 /popular 주소 — 거르기·정렬·구간을 바꾸면 첫 쪽으로 간다(쪽을 함께 넘기지 않으면) */
export function popularStateHref(state: PopularState, patch: Partial<PopularState> = {}): string {
  const next = { ...state, ...patch };
  if (!('page' in patch) && ['tier', 'personal', 'ai', 'category', 'sort'].some(key => key in patch)) next.page = 1;
  const query = new URLSearchParams({ tier: next.tier });
  if (next.personal) query.set('personal', '1');
  if (next.ai) query.set('ai', 'made');
  if (next.category) query.set('category', next.category.toLowerCase());
  if (next.sort !== 'stars') query.set('sort', next.sort);
  if (next.view !== 'list') query.set('view', next.view);
  if (next.page > 1) query.set('page', String(next.page));
  return `/popular?${query}`;
}

export function popularHref(tier: StarTier, personal = false, page = 1) {
  return popularStateHref({ tier, personal, ai: false, category: null, sort: 'stars', view: 'list', page });
}
