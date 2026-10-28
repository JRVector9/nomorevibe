import {beforeAll,beforeEach,afterEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {DEFAULT_CRAWL_SETTINGS} from '@/lib/crawl/settings-schema';
import {claimKoreanQuery,deferKoreanQuery,m3DiscoveryQueries,stageKoreanPage,synchronizeKoreanQueries,importSharedKoreanCandidates} from '@/lib/crawl/korean-discovery/repository';
import {ensureSchema} from './setup';
const settings={...DEFAULT_CRAWL_SETTINGS,enabled:true,discover:{...DEFAULT_CRAWL_SETTINGS.discover,queries:[
  {label:'기존 한글',kind:'repositories' as const,query:'있습니다 in:readme',enabled:true,priority:60,builder:null,requireEvidence:true},
  {label:'일반',kind:'repositories' as const,query:'topic:vibe-coding',enabled:true,priority:60,builder:null}
]}};
beforeAll(()=>ensureSchema());
beforeEach(async()=>{
  await db.execute(sql`TRUNCATE github_ko_discovery_queries,github_ko_discovery_staging`);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false,start_at=NULL,shared_cursor=NULL,queries='[]'::jsonb WHERE id=1`);
});
afterEach(async()=>{
  await db.execute(sql`TRUNCATE github_ko_discovery_queries,github_ko_discovery_staging`);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false,start_at=NULL,shared_cursor=NULL WHERE id=1`);
});
it('keeps M3 ownership until explicitly enabled and exactly transferred; disable restores it',async()=>{
  await synchronizeKoreanQueries(settings);
  expect(await m3DiscoveryQueries(settings)).toEqual(settings.discover.queries);
  expect(await claimKoreanQuery(3)).toBeNull();
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries(settings);
  expect((await m3DiscoveryQueries(settings)).map(q=>q.label)).toEqual(['일반']);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false WHERE id=1`);
  expect(await m3DiscoveryQueries(settings)).toEqual(settings.discover.queries);
});
it('permits one query owner and fences a lease after disable/re-enable; page staging is idempotent',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries(settings);
  const [first,other]=await Promise.all([claimKoreanQuery(3),claimKoreanQuery(3)]);
  expect(Number(first!==null)+Number(other!==null)).toBe(1);
  const claim=(first??other)!;
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false WHERE id=1`);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true WHERE id=1`);
  expect(await stageKoreanPage(claim,[{repo:'test/korean',signal:claim.label,priority:60,description:null}],claim.cursor)).toBe(false);
  await deferKoreanQuery(claim,new Date(0),'retry');
  const current=(await claimKoreanQuery(3))!;
  expect(await stageKoreanPage(current,[{repo:'test/korean',signal:current.label,priority:60,description:null}],current.cursor)).toBe(true);
  expect(await stageKoreanPage(current,[{repo:'test/late',signal:current.label,priority:60,description:null}],current.cursor)).toBe(false);
  expect((await db.execute(sql`SELECT repo FROM github_ko_discovery_staging`)).map(r=>r.repo)).toEqual(['test/korean']);
});
it('reuses a bounded stored public repository page without network and preserves a cursor',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  const key='b'.repeat(64), completedAt=new Date(Date.now()+3600000);
  await db.execute(sql`UPDATE github_ko_discovery_control SET shared_cursor=${JSON.stringify({at:new Date(completedAt.getTime()-1).toISOString(),key:''})}::jsonb WHERE id=1`);
  await db.execute(sql`INSERT INTO github_discovery_pages (key,kind,query,sort,page,scope,generation,state,owner,owner_name,lease_until,result,completed_at)
    VALUES (${key},'repositories','테스트 is:public pushed:2026-01-01..2026-01-02','recent',1,'public-v1','v1','complete',
      '00000000-0000-4000-8000-000000000001','fixture',now(),
      '{"items":[{"full_name":"test/shared-ko","description":"한국어 일정 관리 서비스입니다"},{"full_name":"test/shared-en","description":"An English app"}]}'::jsonb,${completedAt})
    ON CONFLICT (key) DO UPDATE SET completed_at=excluded.completed_at`);
  try {
    expect(await importSharedKoreanCandidates()).toBe(1);
    expect((await db.execute(sql`SELECT repo FROM github_ko_discovery_staging WHERE repo LIKE 'test/shared-%'`)).map(r=>r.repo)).toEqual(['test/shared-ko']);
    expect(await importSharedKoreanCandidates()).toBe(0);
  } finally {await db.execute(sql`DELETE FROM github_discovery_pages WHERE key=${key}`);}
});
