import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ensureSchema } from './setup';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, githubDiscoveryPages } from '@/lib/db/schema';
import { sharedDiscoverySearch, enqueueDiscoveryBatch } from '@/lib/crawl/shared-discovery';
import { discoveryPageKey } from '@/lib/crawl/discovery-contract';
const identity={kind:'repositories' as const,query:'topic:ai is:public pushed:2026-01-01..2026-01-02',sort:'recent' as const,page:1,scope:'public-v1'};
const value=(repo:string)=>({items:[{full_name:repo,homepage:'https://example.com'}]});
const limits={maxNewPerHour:3000,maxReviewBacklog:1};
beforeAll(()=>ensureSchema());
beforeEach(async()=>{
  await db.delete(githubDiscoveryPages);await db.delete(crawlCandidates);await db.delete(crawlDocuments);await db.delete(crawlFrontier);
});
it('claims identical semantic pages once and reuses persisted facts across devices',async()=>{
  let started!:()=>void;const began=new Promise<void>(r=>{started=r;});
  let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
  const load=vi.fn(async()=>{started();await gate;return {ok:true as const,value:value('a/one')};});
  const first=sharedDiscoverySearch({...identity,ownerName:'m3'},load);await began;
  const racing=await sharedDiscoverySearch({...identity,ownerName:'oracle'},load);
  expect(racing).toMatchObject({ok:false,error:{kind:'discovery_busy'}});
  finish();expect((await first).ok).toBe(true);
  const reused=await sharedDiscoverySearch({...identity,ownerName:'oracle'},load);
  expect(reused).toMatchObject({ok:true,cached:true,value:value('a/one')});expect(load).toHaveBeenCalledTimes(1);
});
it('fences a stale owner after takeover and retains the replacement response',async()=>{
  let started!:()=>void;const began=new Promise<void>(r=>{started=r;});
  let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
  const old=sharedDiscoverySearch(identity,async()=>{started();await gate;return {ok:true,value:value('a/old')};});await began;
  await db.update(githubDiscoveryPages).set({leaseUntil:sql`clock_timestamp()-interval '1 second'`}).where(eq(githubDiscoveryPages.key,discoveryPageKey(identity)));
  expect(await sharedDiscoverySearch(identity,async()=>({ok:true,value:value('a/new')}))).toMatchObject({ok:true,cached:false});
  finish();expect(await old).toMatchObject({ok:false,error:{kind:'discovery_busy'}});
  expect(await sharedDiscoverySearch(identity,async()=>{throw Error('cache missing');})).toMatchObject({ok:true,cached:true,value:value('a/new')});
});
it('serializes two producers at the queue boundary without overspending one place',async()=>{
  const outcomes=await Promise.all(['a/m3','a/oracle'].map(repo=>enqueueDiscoveryBatch([{repo,signal:'test'}],limits)));
  expect(outcomes.reduce((sum,o)=>sum+o.added,0)).toBe(1);
  expect(await db.select().from(crawlFrontier)).toHaveLength(1);
  expect(outcomes.map(o=>o.processed).sort()).toEqual([0,1]);
});
it('does not charge a known downstream repository or overwrite a job after lease loss',async()=>{
  await db.insert(crawlDocuments).values({repo:'a/known',repoMeta:{}});
  const result=await enqueueDiscoveryBatch([{repo:'A/KNOWN',signal:'test'}],limits);
  expect(result).toMatchObject({added:0,processed:1});
  await expect(enqueueDiscoveryBatch([{repo:'a/new',signal:'test'}],{...limits,maxReviewBacklog:2},
    {name:'crawl-seed',token:'00000000-0000-4000-8000-000000000001',requestedVersion:1})).rejects.toThrow('job_lease_lost');
  expect(await db.select().from(crawlFrontier)).toHaveLength(0);
});
it('expires incomplete API responses for retry instead of asserting finished coverage',async()=>{
  const partial=vi.fn(async()=>({ok:true as const,value:{...value('a/partial'),incomplete_results:true}}));
  await sharedDiscoverySearch(identity,partial);
  expect(await sharedDiscoverySearch(identity,partial)).toMatchObject({ok:true,cached:true,value:{incomplete_results:true}});
  expect(partial).toHaveBeenCalledTimes(1);
  await db.update(githubDiscoveryPages).set({completedAt:sql`clock_timestamp()-interval '2 minutes'`});
  expect(await sharedDiscoverySearch(identity,async()=>({ok:true,value:value('a/final')}))).toMatchObject({ok:true,cached:false,value:value('a/final')});
});

it('shares the five-minute insertion budget across concurrent producers at its final place',async()=>{
  await db.execute(sql`insert into crawl_frontier(repo,signal,discovered_at)
    select 'rate-fixture/' || i::text,'test',now()-interval '1 minute' from generate_series(1,249) i`);
  const outcomes=await Promise.all(['rate/m3','rate/oracle'].map(repo=>enqueueDiscoveryBatch([{repo,signal:'test'}],{...limits,maxReviewBacklog:10000})));
  expect(outcomes.reduce((sum,o)=>sum+o.added,0)).toBe(1);
  expect(await db.select().from(crawlFrontier)).toHaveLength(250);
});
