import { createHash } from 'node:crypto';
import { parseCommitAttributions } from '@/lib/domain/evidence/agents/commit-attribution';

export type DiscoverySearchIdentity = {
  kind: 'commits' | 'repositories'; query: string; sort: 'recent' | 'relevance';
  page: number; scope: string; generation?: string; ownerName?: string;
};

/** Deliberately do not rewrite query whitespace or qualifiers: quoted text has semantics. */
export function discoveryPageKey(input: DiscoverySearchIdentity): string {
  if (!['commits', 'repositories'].includes(input.kind) || !['recent', 'relevance'].includes(input.sort)
    || !Number.isInteger(input.page) || input.page < 1 || input.page > 10
    || !input.query || input.query.length > 2048 || !input.scope || input.scope.length > 120
    || (input.generation?.length ?? 0) > 120) throw new Error('invalid_discovery_identity');
  return createHash('sha256').update(JSON.stringify([
    'github-search-v1', input.kind, input.query, input.sort, input.page, 100,
    input.scope, input.generation ?? 'v1',
  ])).digest('hex');
}

/** Store only bounded public discovery facts; commit prose/emails never enter the cache.
 * The canonical trailer retains exactly the parser-validated attribution labels.
 */
export function projectDiscoverySearchValue(kind: DiscoverySearchIdentity['kind'], value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return value;
  const bounded = (v:unknown, max:number):string|null => typeof v === 'string' ? v.slice(0,max) : null;
  const items = value.items.slice(0,100).map(item => {
    if (!item || typeof item !== 'object' || item.private === true || item.repository?.private === true
      || (item.visibility && item.visibility !== 'public') || (item.repository?.visibility && item.repository.visibility !== 'public')) return null;
    if (kind === 'repositories') return {full_name:bounded(item.full_name,200),homepage:bounded(item.homepage,2048),
      description:bounded(item.description,2000),pushed_at:bounded(item.pushed_at,64)};
    const parsed = parseCommitAttributions(typeof item.commit?.message === 'string' ? item.commit.message : '');
    const labels = [...parsed.filter(a => a.client !== null),...parsed.filter(a => a.client === null)].slice(0,8);
    return { repository:{full_name:bounded(item.repository?.full_name,200),description:bounded(item.repository?.description,2000)},
      sha:bounded(item.sha,64), _discovery_attributionLimited:parsed.length>8,
      commit:{message:labels.length ? 'discovery attribution\n\n'+labels.map(a => `Co-authored-by: ${a.label} <redacted@invalid>`).join('\n') : ''} };
  });
  const source = value as {incomplete_results?:unknown;total_count?:unknown;items:unknown[]};
  return {items,incomplete_results:source.incomplete_results === true || source.items.length>100,
    ...(typeof source.total_count === 'number' && Number.isFinite(source.total_count) ? {total_count:Math.max(0,source.total_count)} : {})};
}
