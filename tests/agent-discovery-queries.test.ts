import { expect, it } from 'vitest';
import { ADDITIONAL_AGENT_DISCOVERY_QUERIES, DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema, mergeAdditionalAgentDiscoveryQueries } from '@/lib/crawl/settings-schema';
import { mergeWithDefaults } from '@/lib/crawl/settings';

it('adds provider and AI-authorship discovery hints without asserting a development tool or model', () => {
  expect(ADDITIONAL_AGENT_DISCOVERY_QUERIES).toHaveLength(9);
  expect(ADDITIONAL_AGENT_DISCOVERY_QUERIES.map(query => query.kind)).toEqual(['commits','commits',...Array(7).fill('repositories')]);
  for (const query of ADDITIONAL_AGENT_DISCOVERY_QUERIES) {
    expect(query.builder).toBeNull();
    expect(query.enabled).toBe(true);
    expect(query.priority).toBeLessThan(80);
    expect(DEFAULT_CRAWL_SETTINGS.discover.queries).toContainEqual(query);
  }
  expect(crawlSettingsSchema.safeParse(DEFAULT_CRAWL_SETTINGS).success).toBe(true);
});
it('explicit rollout preserves disabled custom queries and deduplicates by label or normalized search', () => {
  const custom = [{...ADDITIONAL_AGENT_DISCOVERY_QUERIES[0],query:'custom:do-not-change',enabled:false,priority:999},
    {...ADDITIONAL_AGENT_DISCOVERY_QUERIES[2],label:'Maker configured GLM',query:'  TOPIC:GLM  ',enabled:false,priority:1}];
  const before = structuredClone(custom);
  const merged = mergeAdditionalAgentDiscoveryQueries(custom);
  expect(custom).toEqual(before);
  expect(merged.slice(0,2)).toEqual(before);
  expect(merged).toHaveLength(9);
  expect(mergeAdditionalAgentDiscoveryQueries(merged)).toEqual(merged);
});
it('reading persisted settings never implicitly merges the new discovery queries', () => {
  const queries = [{label:'User query',kind:'repositories' as const,query:'topic:private-choice',enabled:false,priority:1,builder:null}];
  expect(mergeWithDefaults({discover:{queries}}).discover.queries).toEqual(queries);
});

/**
 * 프로드에 저장된 판정 설정은 placeholderTitles·blockedHomepageDomains 를 갖고 있어 기본값에
 * 더한 항목이 닿지 않는다. 새 규칙은 새 항목으로 두었고, 저장값에 없으면 기본값이 채워져야 한다.
 */
it('저장된 판정 설정에 없는 새 규칙 목록은 기본값으로 채워진다', () => {
  const merged = mergeWithDefaults({ judge: { placeholderTitles: ['create next app'], blockedHomepageDomains: ['github.com'] } });
  expect(merged.judge.placeholderTitles).toEqual(['create next app']);
  expect(merged.judge.stubPageTitles).toEqual(DEFAULT_CRAWL_SETTINGS.judge.stubPageTitles);
  expect(merged.judge.thirdPartyHosts).toEqual(DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts);
});
