import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs } from "@/lib/db/schema";
import { getSettings, saveSettings, changeReviewMode } from "@/lib/crawl/settings";
import { loadReviewInput, claimAgentReview, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { guardPublication } from "@/lib/crawl/publication-guard";
import { saveRepositoryAgentScan } from "@/lib/domain/evidence/agents/repository";
import { lockRepositoryAgentEvidence } from "@/lib/domain/evidence/agents/lock";
import type { CollectResult } from "@/lib/domain/evidence/agents/collect";
import { ensureSchema } from "./setup";

const repo = "scan-lock/app";
const scanned = (sha: string): CollectResult => ({ repositoryKey:repo,repositoryId:"987654321",commitSha:sha,
  scope:"",state:"complete",cursor:null,observations:[],requestCount:1,fileCount:0,errorCode:null,retryAt:null });
function latch() {
  let resolve!: () => void;
  return { promise:new Promise<void>(done=>{resolve=done;}), release:()=>resolve() };
}
async function waitForAdvisoryWaiter() {
  for (let i=0; i<100; i++) {
    const rows = await db.execute(sql`select exists (
      select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where l.locktype='advisory' and not l.granted and a.datname=current_database()
    ) as waiting`);
    if (rows[0].waiting) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error("expected an advisory lock waiter");
}
beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);await db.delete(crawlCandidates);await db.delete(crawlDocuments);
  await db.delete(crawlSettings);await db.delete(jobs);await db.delete(agentRepositoryScans);
});
async function fixture() {
  await saveSettings({enabled:true},"test");
  vi.stubEnv("CRAWL_REVIEW_READY","true");
  expect(await changeReviewMode({mode:"enforce",expectedMode:"off",actor:"test",reason:"scan lock test"})).toMatchObject({ok:true});
  vi.unstubAllEnvs();
  const now = new Date(Date.now()-2000), productUrl="https://scan-lock.example";
  const scan = (await saveRepositoryAgentScan(scanned("a".repeat(40)),now))!;
  const [document] = await db.insert(crawlDocuments).values({repo,productUrl,pageStatus:200,fetchedAt:now,
    repoMeta:{description:"A usable app"},pageMeta:{title:"App",description:"A usable app",repositoryKeys:[repo]}}).returning();
  const [candidate] = await db.insert(crawlCandidates).values({repo,productUrl,state:"approved",reason:"passed",decidedBy:"auto",judgedAt:now}).returning();
  const settings = await getSettings();
  const lease = {name:"crawl-agent-review",token:"scan-lock-review",requestedVersion:1};
  await db.insert(jobs).values({name:lease.name,leaseToken:lease.token,lockedAt:new Date()});
  const context = {candidate,document,settings,lease,input:await loadReviewInput(candidate,document,settings)};
  const claim = await claimAgentReview({...context,provider:"claude-cli",model:"test"});
  if (claim.kind==="skipped") throw new Error(claim.reason);
  await recordAgentReview({...context,attempt:claim.attempt,outcome:{decision:"approve",reason:"Deployed app",evidenceIds:["product"]}});
  const [approved] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id,candidate.id));
  return {...context,candidate:approved,scan};
}

it("keeps a newly inserted SHA out until the verified publication transaction commits", async () => {
  const input = await fixture(), verified=latch(), release=latch();
  const publication = db.transaction(async tx => {
    await guardPublication(tx,{...input,slug:"scan-lock-app",scanId:null});
    verified.release();await release.promise;
  });
  void publication.catch(()=>{});
  let writer: ReturnType<typeof saveRepositoryAgentScan> | undefined;
  try {
    await verified.promise;
    writer=saveRepositoryAgentScan(scanned("b".repeat(40)));
    void writer.catch(()=>{});
    await waitForAdvisoryWaiter();
    expect(await db.select().from(agentRepositoryScans)).toHaveLength(1);
    release.release();await publication;await writer;
    expect(await db.select().from(agentRepositoryScans)).toHaveLength(2);
  } finally {release.release();await publication.catch(()=>{});await writer?.catch(()=>{});}
});

it("serializes same-SHA updates before scan row locks and rejects the superseded approval", async () => {
  const input=await fixture(), ownsIdentity=latch(), continueWrite=latch();
  const writer=db.transaction(async tx=>{
    await lockRepositoryAgentEvidence(tx,repo);
    ownsIdentity.release();await continueWrite.promise;
    await tx.update(agentRepositoryScans).set({completedAt:new Date(),startedAt:new Date()}).where(eq(agentRepositoryScans.id,input.scan.id));
  });
  void writer.catch(()=>{});
  let publication: Promise<unknown> | undefined;
  try {
    await ownsIdentity.promise;
    publication=db.transaction(tx=>guardPublication(tx,{...input,slug:"scan-lock-app",scanId:input.scan.id}));
    void publication.catch(()=>{});
    await waitForAdvisoryWaiter();
    continueWrite.release();await writer;
    await expect(publication).rejects.toThrow("review_approval_changed");
    expect(await db.select().from(crawlCandidates)).toMatchObject([{state:"approved"}]);
  } finally {continueWrite.release();await writer.catch(()=>{});await publication?.catch(()=>{});}
});
