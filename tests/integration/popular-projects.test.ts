import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {products,crawlCandidates,crawlDocuments,crawlSettings,productHealth} from '@/lib/db/schema';
import {getPopularPage,getPopularGroups} from '@/lib/domain/products/popular';
import {refreshProductStars} from '@/lib/jobs/products/stars-refresh';
import {update} from '@/lib/domain/products/repository';
import {ensureSchema,resetTables} from './setup';
import type {JobContext} from '@/lib/jobs/runner';
vi.mock('server-only',()=>({}));
beforeAll(ensureSchema);
beforeEach(async()=>{await db.delete(crawlCandidates);await db.delete(crawlDocuments);await db.delete(crawlSettings);await resetTables();});
let serial=0;
async function product(stars: number|null, ownerType: 'User'|'Organization'|null='User', status: 'seeded'|'verified'|'banned'|'unverified'='seeded') {
 const slug=`stars-${++serial}`;
 const [row]=await db.insert(products).values({slug,name:slug,url:`https://${slug}.example`,tagline:'A useful product',description:'description',category:'Dev',repoUrl:`https://github.com/test/${slug}`,stars,starsAt:stars===null?null:new Date(),ownerType,status,source:'crawler',verifyToken:`v-${slug}`,editTokenHash:'a'.repeat(64)}).returning();return row;
}
const context = ():JobContext<{afterId?:number;retryAfter?:string}> => ({cursor:null,save:vi.fn(),hasBudget:()=>true,log:vi.fn()});
const response=(stars:number)=>({ok:true as const,status:200 as const,value:{stargazers_count:stars,owner:{type:'Organization'}},etag:null,lastModified:null,link:null});
it('공개되고 접속 가능한 제품만 세고 동점은 ID로 정렬한다',async()=>{
 for(const stars of [1999,2000,4999,5000,9999,10000,29999,30000,99999,100000])await product(stars);
 await product(4500,'Organization');await product(4500,null);await product(4500,'User','banned');await product(4500,'User','unverified');
 const down=await product(4500);await db.insert(productHealth).values({slug:down.slug,status:503,failures:3});
 const all=await getPopularPage('rising',false,1,2);
 expect(all.total).toBe(4);expect(all.items.map(p=>p.stars)).toEqual([4999,4500]);expect(all.pages).toBe(2);
 const next=await getPopularPage('rising',false,2,2);expect(next.items.map(p=>p.stars)).toEqual([4500,2000]);
 expect((await getPopularPage('rising',true)).total).toBe(2);
 expect((await getPopularGroups(false)).map(g=>g.total)).toEqual([4,2,2,2]);
 expect((await getPopularPage('rising',false,999)).page).toBe(1);
});
it('오래된 스타만 갱신하고 신선한 제품은 재조회하지 않는다',async()=>{
 const stale=await product(2500);const fresh=await product(2600);
 await db.execute(sql`update products set stars_at=now()-interval '2 days' where id=${stale.id}`);
 const request=vi.fn(async()=>response(7000));
 await refreshProductStars(context(),{request});
 expect(request).toHaveBeenCalledTimes(1);
 expect((await db.select().from(products).where(eq(products.id,stale.id)))[0]).toMatchObject({stars:7000,ownerType:'Organization'});
 expect((await db.select().from(products).where(eq(products.id,fresh.id)))[0].stars).toBe(2600);
});
it('실패 시 값과 성공 시각을 보존하고 다음 후보를 계속 본다',async()=>{
 const first=await product(null);const second=await product(null);
 const request=vi.fn(async(path:string)=>path.endsWith(first.slug)?{ok:false as const,error:{kind:'not_found' as const}}:response(4000));
 await refreshProductStars(context(),{request});
 expect((await db.select().from(products).where(eq(products.id,first.id)))[0]).toMatchObject({stars:null,starsAt:null});
 expect((await db.select().from(products).where(eq(products.id,second.id)))[0].stars).toBe(4000);
 request.mockClear();await refreshProductStars(context(),{request});expect(request).not.toHaveBeenCalled();
});
it('쿼터 대기를 저장하고 재개 시각 전에는 API를 부르지 않는다',async()=>{
 await product(null);const ctx=context();const future=new Date(Date.now()+60000);
 const request=vi.fn(async()=>({ok:false as const,error:{kind:'rate_limited' as const,resetAt:future}}));
 const result=await refreshProductStars(ctx,{request});expect(result.done).toBe(false);expect(result.cursor?.retryAfter).toBe(future.toISOString());
 request.mockClear();await refreshProductStars({...context(),cursor:result.cursor??null},{request});expect(request).not.toHaveBeenCalled();
});
it('요청 중 저장소가 바뀌면 이전 응답을 버린다',async()=>{
 const p=await product(null);const request=vi.fn(async()=>{await update(p.id,{repoUrl:'https://github.com/test/replacement'});return response(5000);});
 await refreshProductStars(context(),{request});expect((await db.select().from(products).where(eq(products.id,p.id)))[0].stars).toBeNull();
});
it('저장소를 바꾸면 이전 저장소의 스타를 표시하지 않는다',async()=>{
 const p=await product(9000);await update(p.id,{repoUrl:'https://github.com/test/replacement'});
 expect((await db.select().from(products).where(eq(products.id,p.id)))[0]).toMatchObject({stars:null,starsAt:null,ownerType:null});
});
it('백필은 제품의 현재 저장소에 연결된 최신 원본만 사용한다',async()=>{
 const p=await product(null);const other=await product(null);
 await db.insert(crawlDocuments).values([
 {repo:`test/${p.slug}`,repoMeta:{stargazers_count:9876,owner:{type:'Organization'}},fetchedAt:new Date('2026-09-10T00:00:00Z')},
 {repo:`TEST/${p.slug.toUpperCase()}`,repoMeta:{stargazers_count:9999,owner:{type:'User'}},fetchedAt:new Date('2026-09-11T00:00:00Z')},
 {repo:`test/${other.slug}`,repoMeta:{stargazers_count:'9000',owner:{type:'User'}}},
 ]);
 const {readFileSync}=await import('node:fs');
 const migration=readFileSync('drizzle/0030_product_stars.sql','utf8').split('-- 제품에 현재 연결된 저장소')[1];
 await db.execute(sql.raw('-- 제품에 현재 연결된 저장소'+migration));
 expect((await db.select().from(products).where(eq(products.id,p.id)))[0]).toMatchObject({stars:9999,ownerType:'User'});
 expect((await db.select().from(products).where(eq(products.id,other.id)))[0].stars).toBeNull();
});
it('저장소 주소가 바뀌었다 돌아와도 진행 중이던 응답은 적용하지 않는다',async()=>{
 const p=await product(null);
 await refreshProductStars(context(),{request:async()=>{
  await update(p.id,{repoUrl:'https://github.com/test/interim'});
  await update(p.id,{repoUrl:p.repoUrl});
  return response(9900);
 }});
 expect((await db.select().from(products).where(eq(products.id,p.id)))[0].stars).toBeNull();
});
it('목록의 AI 흔적은 공개 설정과 링크 숨김을 지키고 오래된 관측을 표시한다',async()=>{
 const {productLinks,productEvidenceSources}=await import('@/lib/db/schema');
 const {saveSettings}=await import('@/lib/crawl/settings');
 const {saveRepositoryAgentScan}=await import('@/lib/domain/evidence/agents/repository');
 const {getPublicObservedAgentFacts}=await import('@/lib/domain/products/detail-view');
 const p=await product(4500),repo=`test/${p.slug}`,sha='a'.repeat(40);
 const scan=await saveRepositoryAgentScan({repositoryId:'12',repositoryKey:repo,commitSha:sha,scope:'',state:'complete',cursor:null,requestCount:4,fileCount:1,errorCode:null,retryAt:null,observations:[{
  kind:'model_config',client:'claude-code',compatibleClients:[],modelDeveloper:'z-ai',declaredModelId:'glm-4.7',gateway:'z-ai',routing:'fixed',role:'sonnet',scope:'',keyPath:'env.ANTHROPIC_DEFAULT_SONNET_MODEL',ruleId:'claude.settings.v1',sourcePath:'.claude/settings.json',commitSha:sha,blobSha:'b'.repeat(40),sourceUrl:`https://github.com/${repo}/blob/${sha}/.claude/settings.json`,
 }]},new Date(Date.now()-2*86400000));
 await db.insert(productLinks).values({slug:p.slug,kind:'repository',declarationSource:'discovered',url:p.repoUrl!,normalizedKey:repo,visible:true});
 await db.insert(productEvidenceSources).values({slug:p.slug,kind:'repository',provider:'github',sourceKey:repo,normalizedFacts:{type:'github_repository',agentScanId:scan!.id}});
 expect((await getPublicObservedAgentFacts([p.slug])).get(p.slug)).toEqual([]);
 await saveSettings({agentEvidence:{displayObservedFacts:true}},'test');
 expect((await getPublicObservedAgentFacts([p.slug])).get(p.slug)).toMatchObject([{clientLabel:'Claude Code',coverageLabel:'에이전트 정보 재확인 필요',relationshipLabel:'제품과 저장소 관계 미확인'}]);
 await db.update(productLinks).set({visible:false}).where(eq(productLinks.slug,p.slug));
 expect((await getPublicObservedAgentFacts([p.slug])).get(p.slug)).toEqual([]);
});
