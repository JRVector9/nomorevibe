import { sharedDiscoverySearch } from '@/lib/crawl/shared-discovery';
import { searchRepositories, type RepositorySearchResult } from '@/lib/crawl/github';
import { getSettings } from '@/lib/crawl/settings';
import { observe } from '@/lib/operations/observations';
import { recordDiscoveryProgress } from '@/lib/crawl/discovery-progress';
import { claimKoreanQuery, deferKoreanQuery, koreanDiscoveryEnabled, importSharedKoreanCandidates, koreanLanguageBatch, saveKoreanLanguage, stageKoreanPage } from './repository';
import { inspectKoreanProject } from './language';
import { koreanSearchQuery, nextKoreanCursor } from './contracts';

/** One bounded page plus a bounded language batch. No writes to frontier/candidates/jobs from Oracle. */
export async function koreanDiscoveryTick(options: { instanceId: string; signal?: AbortSignal; deadlineAt?: number }) {
  const settings = await getSettings();
  if (!settings.enabled || options.signal?.aborted || !await koreanDiscoveryEnabled()) return { state: 'idle' as const, searched: 0, checked: 0 };
  const deadlineAt = options.deadlineAt ?? Date.now() + 45_000;
  await importSharedKoreanCandidates();
  const claim = await claimKoreanQuery(settings.discover.windowDays);
  let searched = 0, checked = 0;
  if (claim) {
    try {
      const query = koreanSearchQuery(claim.query, claim.cursor.window);
      let requested = false;
      const result = await sharedDiscoverySearch<RepositorySearchResult>({ kind: 'repositories', query, sort: 'recent', page: claim.cursor.page,
        scope: 'public-v1' }, () => { requested = true; return searchRepositories({ query, page: claim.cursor.page, sort: 'recent' }); });
      searched = Number(requested);
      if (!result.ok) {
        const dueAt = result.error.kind === 'discovery_busy' ? result.error.retryAt
          : (result.error.kind === 'rate_limited' || result.error.kind === 'auth_unavailable') && result.error.resetAt
            ? result.error.resetAt : new Date(Date.now() + 60_000);
        await deferKoreanQuery(claim, dueAt, result.error.kind);
      } else {
        const page = result.value;
        if (!Array.isArray(page.items)) throw new Error('invalid_korean_search_page');
        const repositories = [...new Map(page.items.filter(item => item && typeof item.full_name === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.full_name) && !item.full_name.split('/').some(part=>part==='.' || part==='..'))
          .map(item => [item.full_name.toLowerCase(), { repo: item.full_name.toLowerCase(), signal: claim.label, priority: claim.priority,
            description: typeof (item as { description?: unknown }).description === 'string' ? (item as { description: string }).description : null }])).values()];
        const next = nextKoreanCursor(claim.cursor, { length: page.items.length, total: page.total_count, incomplete: page.incomplete_results }, claim.windowDays, new Date());
        const staged = await stageKoreanPage(claim, repositories, next);
        if (!staged) await deferKoreanQuery(claim, new Date(Date.now()+60_000), 'staging_capacity_or_lease');
        if (staged) await recordDiscoveryProgress({ worker: options.instanceId, lane: 'korean', signal: claim.label, window: claim.cursor.window, page: claim.cursor.page,
          counts: { searchRequests: searched, cacheHits: Number(!requested), pagesVisited: 1, returned: page.items.length, examined: repositories.length,
            incomplete: Number(Boolean(page.incomplete_results || next.unresolved)) } });
      }
    } catch {
      await deferKoreanQuery(claim, new Date(Date.now() + 60_000), 'search_or_stage_failed');
    }
  }
  for (const row of await koreanLanguageBatch()) {
    if (options.signal?.aborted || Date.now() >= deadlineAt) break;
    const language = await inspectKoreanProject(row.repo, row.description, { signal: options.signal, deadlineAt });
    await saveKoreanLanguage(row.repo, language); checked++;
    await recordDiscoveryProgress({ worker: options.instanceId, lane: 'korean', signal: row.signal,
      counts: { koreanYes: Number(language.language === 'yes'), koreanNo: Number(language.language === 'no'), koreanUnknown: Number(language.language === 'unknown') } });
  }
  await observe(`github-ko-discovery:${options.instanceId}`, { searched, checked, at: new Date().toISOString() });
  return { state: claim ? 'worked' as const : 'idle' as const, searched, checked };
}
