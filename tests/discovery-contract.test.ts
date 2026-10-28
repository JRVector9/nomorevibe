import { expect, it } from 'vitest';
import { discoveryPageKey, type DiscoverySearchIdentity } from '@/lib/crawl/discovery-contract';
const base: DiscoverySearchIdentity = { kind:'repositories',query:'topic:ai is:public pushed:2026-01-01..2026-01-02',sort:'recent',page:1,scope:'public-v1' };
it('shares exact semantics across devices without conflating visibility or search generations', () => {
  expect(discoveryPageKey({...base,ownerName:'m3'})).toBe(discoveryPageKey({...base,ownerName:'oracle'}));
  for (const changed of [{scope:'other'},{generation:'v2'},{page:2},{kind:'commits'},{sort:'relevance'},{query:base.query+' stars:>0'}])
    expect(discoveryPageKey({...base,...changed} as DiscoverySearchIdentity)).not.toBe(discoveryPageKey(base));
});
it('preserves quoted whitespace and rejects unsafe page identities', () => {
  expect(discoveryPageKey({...base,query:'"a  b"'})).not.toBe(discoveryPageKey({...base,query:'"a b"'}));
  expect(() => discoveryPageKey({...base,page:11})).toThrow('invalid_discovery_identity');
  expect(() => discoveryPageKey({...base,scope:''})).toThrow('invalid_discovery_identity');
});

import { projectDiscoverySearchValue } from '@/lib/crawl/discovery-contract';
import { parseCommitAttributions } from '@/lib/domain/evidence/agents/commit-attribution';
it('retains attribution facts while discarding commit prose and personal emails', () => {
  const message='private prose example\n\nCo-authored-by: Codex <person@example.com>\nCo-authored-by: Claude <other@example.com>';
  const projected=projectDiscoverySearchValue('commits',{items:[{repository:{full_name:'a/b'},sha:'a'.repeat(40),commit:{message}}]}) as {items:{commit:{message:string}}[]};
  expect(parseCommitAttributions(projected.items[0].commit.message)).toEqual(parseCommitAttributions(message));
  expect(JSON.stringify(projected)).not.toContain('person@example');
  expect(JSON.stringify(projected)).not.toContain('private prose');
});
it('bounds cached page facts and preserves incomplete response status', () => {
  const result=projectDiscoverySearchValue('repositories',{items:Array.from({length:101},()=>({full_name:'a/b',description:'x'.repeat(10_000)}))}) as {items:{description:string}[];incomplete_results:boolean};
  expect(result.items).toHaveLength(100);
  expect(result.items[0].description.length).toBe(2000);
  expect(result.incomplete_results).toBe(true);
});
