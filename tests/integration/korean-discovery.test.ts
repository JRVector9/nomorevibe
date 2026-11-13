import {beforeAll,beforeEach,afterEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {DEFAULT_CRAWL_SETTINGS} from '@/lib/crawl/settings-schema';
import {claimKoreanQuery,deferKoreanQuery,stageKoreanPage,synchronizeKoreanQueries,importSharedKoreanCandidates} from '@/lib/crawl/korean-discovery/repository';
import {m3DiscoveryQueries,KOREAN_STAGING_MAX_PENDING} from '@/lib/crawl/korean-discovery/contracts';
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
it('never gives Korean searches to M3; Oracle owns them only after explicit enable and transfer',async()=>{
  expect(m3DiscoveryQueries(settings.discover.queries).map(q=>q.label)).toEqual(['일반']);
  await synchronizeKoreanQueries(settings);
  expect(await claimKoreanQuery(3)).toBeNull();
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries(settings);
  const [saved] = await db.execute<{cursor: {window: {from: string; to: string}}}>(sql`SELECT cursor FROM github_ko_discovery_queries WHERE label='기존 한글'`);
  expect(saved.cursor.window).toEqual({from:'2026-01-01T00:00:00Z',to:'2026-01-04T00:00:00Z'});
  // Disabling Oracle pauses Korean search; it does not hand it back to M3.
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false WHERE id=1`);
  expect(m3DiscoveryQueries(settings.discover.queries).map(q=>q.label)).toEqual(['일반']);
  expect(await claimKoreanQuery(3)).toBeNull();
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
  // Old control epoch cannot release or defer its claim. Expiry permits the next owner.
  await db.execute(sql`UPDATE github_ko_discovery_queries SET lease_until=now()-interval '1 second' WHERE label=${claim.label}`);
  const current=(await claimKoreanQuery(3))!;
  expect(await stageKoreanPage(current,[{repo:'test/korean',signal:current.label,priority:60,description:null}],current.cursor)).toBe(true);
  expect(await stageKoreanPage(current,[{repo:'test/late',signal:current.label,priority:60,description:null}],current.cursor)).toBe(false);
  expect((await db.execute(sql`SELECT repo FROM github_ko_discovery_staging`)).map(r=>r.repo)).toEqual(['test/korean']);
});
it('persists retry deadlines and completed-cycle waits without making the query claimable early',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries(settings);
  const claim=(await claimKoreanQuery(3))!;
  const retryAt=new Date('2099-01-01T01:02:03.456Z');
  await deferKoreanQuery(claim,retryAt,'rate_limited');
  expect(await claimKoreanQuery(3)).toBeNull();
  const [retry]=await db.execute<{due_ms:number;token:string|null;last_error:string}>(sql`
    SELECT (extract(epoch FROM due_at)*1000)::double precision AS due_ms,token,last_error
    FROM github_ko_discovery_queries WHERE label=${claim.label}`);
  expect(retry).toEqual({due_ms:retryAt.getTime(),token:null,last_error:'rate_limited'});
  await db.execute(sql`UPDATE github_ko_discovery_queries SET due_at=now()-interval '1 second' WHERE label=${claim.label}`);
  const resumed=(await claimKoreanQuery(3))!;
  const cursor={...resumed.cursor,waitingUntil:'2099-01-02T04:05:06.789Z'};
  expect(await stageKoreanPage(resumed,[],cursor)).toBe(true);
  await synchronizeKoreanQueries(settings);
  expect(await claimKoreanQuery(3)).toBeNull();
  const [waiting]=await db.execute<{due_ms:number;cursor:unknown}>(sql`
    SELECT (extract(epoch FROM due_at)*1000)::double precision AS due_ms,cursor
    FROM github_ko_discovery_queries WHERE label=${claim.label}`);
  expect(waiting).toEqual({due_ms:Date.parse(cursor.waitingUntil),cursor});
});
it('reuses a bounded stored public repository page without network and preserves a cursor',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  // Shared-page import must continue above the previous 10k staging limit too.
  await db.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority)
    SELECT 'fixture/old-'||n,'capacity fixture',50 FROM generate_series(1,10000) n`);
  const key='b'.repeat(64), completedAt='2099-10-01 00:00:00.123456';
  await db.execute(sql`UPDATE github_ko_discovery_control SET shared_cursor=${JSON.stringify({at:'2099-10-01 00:00:00.123000',key:''})}::jsonb WHERE id=1`);
  await db.execute(sql`INSERT INTO github_discovery_pages (key,kind,query,sort,page,scope,generation,state,owner,owner_name,lease_until,result,completed_at)
    VALUES (${key},'repositories','테스트 is:public pushed:2026-01-01..2026-01-02','recent',1,'public-v1','v1','complete',
      '00000000-0000-4000-8000-000000000001','fixture',now(),
      '{"items":[{"full_name":"test/shared-ko","description":"한국어 일정 관리 서비스입니다"},{"full_name":"test/shared-en","description":"An English app"}]}'::jsonb,${completedAt})
    ON CONFLICT (key) DO UPDATE SET completed_at=excluded.completed_at`);
  try {
    expect(await importSharedKoreanCandidates()).toBe(1);
    expect((await db.execute(sql`SELECT repo FROM github_ko_discovery_staging WHERE repo LIKE 'test/shared-%'`)).map(r=>r.repo)).toEqual(['test/shared-ko']);
    expect(await importSharedKoreanCandidates()).toBe(0);
    const [saved]=await db.execute<{shared_cursor:{at:string}}>(sql`SELECT shared_cursor FROM github_ko_discovery_control WHERE id=1`);
    expect(saved.shared_cursor.at).toBe(completedAt);
  } finally {await db.execute(sql`DELETE FROM github_discovery_pages WHERE key=${key}`);}
});

it('continues direct search staging above the previous 10k limit',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries(settings);
  await db.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority)
    SELECT 'fixture/old-'||n,'capacity fixture',50 FROM generate_series(1,10000) n`);
  const claim=(await claimKoreanQuery(3))!;
  expect(await stageKoreanPage(claim,[{repo:'test/above-old-limit',signal:claim.label,priority:60,description:null}],claim.cursor)).toBe(true);
});

it('serializes competing pages at 50k and preserves the rejected page; duplicates need no new capacity',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01' WHERE id=1`);
  await synchronizeKoreanQueries({...settings,discover:{...settings.discover,queries:[...settings.discover.queries,
    {...settings.discover.queries[0],label:'두번째 한글',query:'합니다 in:readme'}]}});
  await db.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority)
    SELECT 'fixture/full-'||n,'capacity fixture',50 FROM generate_series(1,${KOREAN_STAGING_MAX_PENDING-1}) n`);
  const claims=[(await claimKoreanQuery(3))!,(await claimKoreanQuery(3))!];
  const outcomes=await Promise.all(claims.map((claim,i)=>stageKoreanPage(claim,
    [{repo:'test/race-'+i,signal:claim.label,priority:60,description:null}],{...claim.cursor,page:2})));
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const [count]=await db.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM github_ko_discovery_staging WHERE state='pending'`);
  expect(count.n).toBe(KOREAN_STAGING_MAX_PENDING);
  const rejected=claims[outcomes.indexOf(false)];
  const [saved]=await db.execute<{cursor:unknown;token:string}>(sql`SELECT cursor,token FROM github_ko_discovery_queries WHERE label=${rejected.label}`);
  expect(saved).toEqual({cursor:rejected.cursor,token:rejected.token});
  expect(await stageKoreanPage(rejected,[{repo:'fixture/full-1',signal:rejected.label,priority:60,description:null}],rejected.cursor)).toBe(true);
});

it('reserves room for a full shared page and leaves its cursor untouched when capacity is unavailable',async()=>{
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01',
    shared_cursor='{"at":"2099-10-01 00:00:00","key":""}'::jsonb WHERE id=1`);
  await db.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority)
    SELECT 'fixture/full-'||n,'capacity fixture',50 FROM generate_series(1,${KOREAN_STAGING_MAX_PENDING-100}) n`);
  const key='c'.repeat(64),at='2099-10-01 00:00:01';
  const result={items:Array.from({length:100},(_,i)=>({full_name:'test/shared-'+i,description:'한국어 서비스입니다'}))};
  await db.execute(sql`INSERT INTO github_discovery_pages (key,kind,query,sort,page,scope,generation,state,owner,owner_name,lease_until,result,completed_at)
    VALUES (${key},'repositories','capacity is:public','recent',1,'public-v1','v1','complete',
      '00000000-0000-4000-8000-000000000001','fixture',now(),${JSON.stringify(result)}::jsonb,${at})`);
  try {
    expect(await importSharedKoreanCandidates()).toBe(100);
    await db.execute(sql`UPDATE github_discovery_pages SET completed_at='2099-10-01 00:00:02' WHERE key=${key}`);
    expect(await importSharedKoreanCandidates()).toBe(0);
    const [saved]=await db.execute<{shared_cursor:{at:string}}>(sql`SELECT shared_cursor FROM github_ko_discovery_control WHERE id=1`);
    expect(saved.shared_cursor.at).toBe(at);
    const [count]=await db.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM github_ko_discovery_staging WHERE state='pending'`);
    expect(count.n).toBe(KOREAN_STAGING_MAX_PENDING);
  } finally {await db.execute(sql`DELETE FROM github_discovery_pages WHERE key=${key}`);}
});
