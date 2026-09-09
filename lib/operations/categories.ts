import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { categoryDecisions, crawlCandidates, crawlDocuments, operationsAudit, type CrawlCandidate, type CrawlDocument } from '@/lib/db/schema';
import { CATEGORIES, type Category } from '@/lib/domain/products/schema';
import { requestJob } from '@/lib/jobs/control';

export function categorySourceHash(candidate: CrawlCandidate, document: CrawlDocument) {
  return createHash('sha256').update(JSON.stringify([candidate,document,CATEGORIES])).digest('hex');
}
/** Filter holds before LIMIT; changed source/candidate rows become eligible immediately. */
export function classificationReadyPredicate() {
  return sql`not exists (select 1 from category_decisions cd where cd.repo = ${crawlCandidates.repo}
    and cd.category is null and cd.retry_at > now() and cd.updated_at >= ${crawlCandidates.updatedAt}
    and not exists (select 1 from crawl_documents d where d.repo=cd.repo and d.fetched_at > cd.updated_at))`;
}
export async function decisionFor(candidate: CrawlCandidate, document: CrawlDocument) {
  const decision=await db.query.categoryDecisions.findFirst({where:eq(categoryDecisions.repo,candidate.repo)});
  return decision ? { ...decision, category: decision.sourceHash===categorySourceHash(candidate,document) ? decision.category : null } : null;
}
export async function holdClassification(candidate: CrawlCandidate, document: CrawlDocument) {
  const sourceHash=categorySourceHash(candidate,document);
  await db.transaction(async tx=>{
    const [c]=await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id,candidate.id)).for('update');
    const [d]=await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo,candidate.repo)).for('share');
    if(!c||!d||c.state!=='approved'||categorySourceHash(c,d)!==sourceHash)return;
    const [existing]=await tx.select().from(categoryDecisions).where(eq(categoryDecisions.repo,c.repo)).for('update');
    if(existing?.category && existing.sourceHash===sourceHash)return;
    const values={sourceHash,category:null,reason:'AI 분류 실패 또는 미연결 · 수동 분류 대기',actor:'publisher',retryAt:sql`now() + interval '1 hour'`,updatedAt:sql`clock_timestamp()`};
    await tx.insert(categoryDecisions).values({repo:c.repo,...values}).onConflictDoUpdate({target:categoryDecisions.repo,set:{...values,revision:sql`${categoryDecisions.revision}+1`}});
  });
}
export async function setManualCategory(input:{repo:string;sourceHash:string;category:Category;reason:string;actor:string}) {
  if(!CATEGORIES.includes(input.category)||input.reason.trim().length<3||input.reason.length>500)throw new Error('카테고리와 3~500자의 지정 사유를 입력해주세요.');
  return db.transaction(async tx=>{
    const [c]=await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo,input.repo)).for('update');
    const [d]=await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo,input.repo)).for('share');
    if(!c||!d||c.state!=='approved'||categorySourceHash(c,d)!==input.sourceHash)throw new Error('후보 또는 출처가 변경되었습니다. 새로고침 후 다시 확인해주세요.');
    const values={sourceHash:input.sourceHash,category:input.category,reason:input.reason.trim(),actor:input.actor,retryAt:sql`now()`,updatedAt:sql`clock_timestamp()`};
    await tx.insert(categoryDecisions).values({repo:input.repo,...values}).onConflictDoUpdate({target:categoryDecisions.repo,set:{...values,revision:sql`${categoryDecisions.revision}+1`}});
    await tx.insert(operationsAudit).values({actor:input.actor,action:'manual-category',target:input.repo,detail:{category:input.category,reason:input.reason,sourceHash:input.sourceHash}});
    await requestJob('crawl-publish',tx);
  });
}
export async function manualCandidates() {
  const rows=await db.select({candidate:crawlCandidates,document:crawlDocuments,decision:categoryDecisions}).from(crawlCandidates)
    .innerJoin(crawlDocuments,eq(crawlDocuments.repo,crawlCandidates.repo))
    .leftJoin(categoryDecisions,eq(categoryDecisions.repo,crawlCandidates.repo))
    .where(eq(crawlCandidates.state,'approved')).orderBy(sql`${categoryDecisions.category} nulls first`,crawlCandidates.id).limit(50);
  return rows.map(({candidate:c,document:d,decision})=>({repo:c.repo,url:c.productUrl,name:String(d.pageMeta?.title??d.repoMeta.name??c.repo),description:String(d.pageMeta?.description??d.repoMeta.description??''),sourceHash:categorySourceHash(c,d),category:decision?.sourceHash===categorySourceHash(c,d)?decision.category:null,reason:decision?.reason??'승인 후보 · 분류 대기',retryAt:decision?.retryAt.toISOString()??null}));
}
