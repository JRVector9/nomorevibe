import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlSettings, jobs, products } from '@/lib/db/schema';
import { categorySourceHash, setManualCategory, holdClassification, classificationReadyPredicate } from '@/lib/operations/categories';
import { requestAdminJob } from '@/lib/operations/admin';
import { listCandidates } from '@/lib/crawl/repository';
import { saveSettings } from '@/lib/crawl/settings';
import { publishCandidate, prepareCandidateClassification } from '@/lib/crawl/publish';
import { runJob } from '@/lib/jobs/runner';
import { publishCandidates } from '@/lib/crawl/jobs/publish';
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from './setup';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { ClassificationAuthority } from '@/lib/operations/contracts';
import { randomUUID } from 'node:crypto';
const agent = vi.hoisted(() => ({ deferred: false, directNative: false, authority: undefined as ClassificationAuthority | undefined,
  classify: vi.fn(async (inputs: unknown[]) => inputs.map(() => null)) }));
vi.mock('@/lib/crawl/classify', async original => ({ ...await original<typeof import('@/lib/crawl/classify')>(), classifyCategories: agent.classify }));
vi.mock('@/lib/crawl/publication-classify-capacity', async original => ({ ...await original<typeof import('@/lib/crawl/publication-classify-capacity')>(),
  publicationClassificationPath: async () => agent.directNative ? 'native' : 'legacy',
  publicationClassificationAuthority: async (...args: Parameters<typeof import('@/lib/crawl/publication-classify-capacity').publicationClassificationAuthority>) =>
    agent.authority ?? (await original<typeof import('@/lib/crawl/publication-classify-capacity')>()).publicationClassificationAuthority(...args) }));
vi.mock('@/lib/domain/products/og',()=>({cacheOgImage:async()=>null}));
vi.mock('@/lib/operations/agent-client',()=>({agentRequest:async()=>{if(agent.deferred)throw new ModelCapacityDeferredError('capacity');throw new Error('disconnected');}}));
beforeAll(ensureSchema);
let floor=0;
beforeEach(async()=>{await resetTables();for(const t of [categoryDecisions,crawlCandidates,crawlDocuments,crawlSettings,jobs])await db.delete(t);await saveSettings({enabled:true},'test');floor=await auditFloor();});
afterEach(()=>{vi.unstubAllEnvs();agent.deferred=false;agent.directNative=false;agent.authority=undefined;agent.classify.mockClear();});
async function seed(){const repo='operations/sample',url='https://operations.example';const [document]=await db.insert(crawlDocuments).values({repo,productUrl:url,repoMeta:{description:'A calendar to plan team tasks'},pageStatus:200,pageMeta:{title:'Calendar',description:'Plan tasks'}}).returning();const [candidate]=await db.insert(crawlCandidates).values({repo,productUrl:url,state:'approved',reason:'passed'}).returning();return {candidate,document,sourceHash:categorySourceHash(candidate,document)};}
it('coalesces simultaneous job requests and audits one request',async()=>{await Promise.all(Array.from({length:8},()=>requestAdminJob('crawl-seed','admin')));const [j]=await db.select().from(jobs).where(eq(jobs.name,'crawl-seed'));expect(j.requestedVersion).toBe(1);expect(await auditRowsAfter(floor,'request-job')).toHaveLength(1);await expect(requestAdminJob('heartbeat','admin')).rejects.toThrow();});
// The hold uses the DB clock; model a later document on that same clock, not the host's.
it('holds failed classification before LIMIT and releases source changes',async()=>{const {candidate,document}=await seed();await holdClassification(candidate,document);expect(await listCandidates(['approved'],10,classificationReadyPredicate())).toHaveLength(0);await db.update(crawlDocuments).set({fetchedAt:sql`clock_timestamp() + interval '1 second'`}).where(eq(crawlDocuments.id,document.id));expect(await listCandidates(['approved'],10,classificationReadyPredicate())).toHaveLength(1);});
it.each([false, true])('rejects a classification hold on a fenced site (worker=%s)', async worker => {
  const { candidate, document } = await seed();
  const lease = { name: 'crawl-publish', token: randomUUID(), requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: sql`clock_timestamp()` as unknown as Date,
    requestedVersion: 1 });
  const [before] = await db.execute<{ state: string; reason: string | null; fenced_db: unknown }>(sql`
    SELECT state, reason, fenced_db FROM dr_writer_fence WHERE id=1`);
  try {
    await db.execute(sql`UPDATE dr_writer_fence SET state='fenced', reason='operator_fence',
      fenced_db='{"systemIdentifier":"1","databaseOid":"1","databaseName":"fixture"}'::jsonb WHERE id=1`);
    await expect(holdClassification(candidate, document, worker ? lease : undefined)).rejects.toThrow('dr_writer_site_fenced');
    expect(await db.select().from(categoryDecisions)).toEqual([]);
    expect((await db.select().from(crawlCandidates))[0]).toEqual(candidate);
  } finally {
    await db.execute(sql`UPDATE dr_writer_fence SET state=${before.state}, reason=${before.reason},
      fenced_db=${before.fenced_db === null ? null : JSON.stringify(before.fenced_db)}::text::jsonb WHERE id=1`);
  }
});
it('rejects stale or no-longer-approved manual decisions',async()=>{const {candidate,sourceHash}=await seed();await expect(setManualCategory({repo:candidate.repo,sourceHash:'old',category:'Games',reason:'Playable game',actor:'admin'})).rejects.toThrow();await db.update(crawlCandidates).set({state:'rejected'}).where(eq(crawlCandidates.id,candidate.id));await expect(setManualCategory({repo:candidate.repo,sourceHash,category:'Games',reason:'Playable game',actor:'admin'})).rejects.toThrow();expect(await db.select().from(categoryDecisions)).toHaveLength(0);});
it('publishes a manually classified candidate when AI is disconnected',async()=>{vi.stubEnv('CONNECT_AGENT_URL','http://internal');const {candidate,sourceHash}=await seed();await setManualCategory({repo:candidate.repo,sourceHash,category:'Productivity',reason:'Shared calendar tasks',actor:'admin'});await runJob('crawl-publish',publishCandidates);expect(await db.select().from(products)).toMatchObject([{category:'Productivity',source:'crawler'}]);});
it('does not publish stale manual classification when the administrator changes it',async()=>{const {candidate,sourceHash}=await seed();await setManualCategory({repo:candidate.repo,sourceHash,category:'Productivity',reason:'Shared calendar tasks',actor:'admin'});const prepared=await prepareCandidateClassification(candidate);const [decision]=await db.select().from(categoryDecisions);await setManualCategory({repo:candidate.repo,sourceHash,category:'Business',reason:'Business operations',actor:'admin'});expect(await publishCandidate(candidate,undefined,{category:'Productivity',snapshot:prepared!.snapshot,decision:{revision:decision.revision,sourceHash}})).toMatchObject({ok:false,reason:'publication_state_changed'});expect(await db.select().from(products)).toHaveLength(0);});
it('keeps unclassified candidates approved without a rule fallback',async()=>{vi.stubEnv('CONNECT_AGENT_URL','http://internal');await seed();await runJob('crawl-publish',publishCandidates);expect(await db.select().from(products)).toHaveLength(0);expect(await db.select().from(crawlCandidates)).toMatchObject([{state:'approved'}]);expect(await db.select().from(categoryDecisions)).toMatchObject([{category:null}]);});
it('preserves the candidate and manual-decision row on capacity deferral',async()=>{
  vi.stubEnv('CONNECT_AGENT_URL','http://internal');agent.deferred=true;const {candidate}=await seed();
  await runJob('crawl-publish',publishCandidates);
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(categoryDecisions)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toEqual([candidate]);
  const [job]=await db.select().from(jobs).where(eq(jobs.name,'crawl-publish'));
  expect(job.lastError).toBeNull();
});
it('never invokes the direct CLI fallback when capacity is open and ConnectAgent is absent',async()=>{
  vi.stubEnv('CONNECT_AGENT_URL',undefined);agent.directNative=true;const {candidate}=await seed();
  await runJob('crawl-publish',publishCandidates);
  expect(agent.classify).not.toHaveBeenCalled();
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(categoryDecisions)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toEqual([candidate]);
});
it('preserves candidate and decision state when the native RPC response is lost',async()=>{
  vi.stubEnv('CONNECT_AGENT_URL','http://internal');const {candidate}=await seed(),sha='a'.repeat(64);
  agent.authority={version:1,members:[{candidateId:candidate.id,repo:candidate.repo,sourceHash:sha}],payloadHash:sha,definitionsHash:sha,configHash:sha,
    generation:3,configVersion:4,job:{name:'crawl-publish',token:randomUUID(),requestedVersion:1},
    publisherRole:{role:'publisher',instanceId:'publisher-test',bootId:randomUUID(),release:'test',epoch:1,kind:'primary'}};
  await runJob('crawl-publish',publishCandidates);
  expect(await db.select().from(products)).toHaveLength(0);expect(await db.select().from(categoryDecisions)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toEqual([candidate]);
  const [job]=await db.select().from(jobs).where(eq(jobs.name,'crawl-publish'));expect(job.lastError).toBeNull();
});
