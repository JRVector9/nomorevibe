import {expect,it} from 'vitest';
import {parseKoreanDiscoveryArgs,runKoreanDiscoveryProcess} from '@/scripts/github-ko-discovery-consumer';
import {ORACLE_CONSUMER_DB_PROFILES} from '@/lib/runtime/oracle-db-profile';
import {consumerSpec} from '@/lib/runtime/consumer-registry';
it('is disabled before opening a DB or network connection unless the exact opt-in is set',async()=>{
  expect(await runKoreanDiscoveryProcess([],{})).toEqual({state:'disabled'});
  await expect(runKoreanDiscoveryProcess([],{GITHUB_KO_DISCOVERY_VERSION:'2'})).rejects.toThrow('invalid_korean_discovery_version');
  expect(parseKoreanDiscoveryArgs(['--once'])).toEqual({once:true});expect(()=>parseKoreanDiscoveryArgs(['--once','--once'])).toThrow('Usage');
});
it('registers a separate staging principal without frontier, candidate, job, model or role authority',()=>{
  const profile=ORACLE_CONSUMER_DB_PROFILES['github-ko-discovery']!;
  expect(profile.principal).toBe('nomorevibe_oracle_github_ko');
  for(const table of ['crawl_frontier','crawl_candidates','jobs','role_leases','pipeline_item_leases','github_collector_accounts','model_capacity_requests']) expect(profile.profile.tables[table]).toBeUndefined();
  expect(profile.profile.tables.github_ko_discovery_staging.update).not.toContain('state');
  expect(profile.profile.tables.github_ko_discovery_control.update).toEqual(['id','shared_cursor']);
  expect(consumerSpec('github-ko-discovery')?.role).toBe('crawler');
});
