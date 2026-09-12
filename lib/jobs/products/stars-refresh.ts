import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {products} from '@/lib/db/schema';
import {githubRequest,type GitHubHttpResult} from '@/lib/crawl/github';
import {githubOwnerFromRepositoryUrl} from '@/lib/domain/products/github-owner';
import {parseRepositoryStats} from '@/lib/domain/products/stars';
import {assertJobLease} from '@/lib/jobs/control';
import type {JobContext,JobOutcome} from '@/lib/jobs/runner';
export type StarsCursor={afterId?:number;retryAfter?:string};
type Request=(path:string,conditional?:object,options?:{timeoutMs?:number})=>Promise<GitHubHttpResult<Record<string,unknown>>>;
const PUBLIC=['seeded','verified'] as const;

/** 하루 한 번 성공 값을 갱신한다. 실패는 한 시간 뒤로 미루고 뒤의 제품을 계속 본다. */
export async function refreshProductStars(ctx:JobContext<StarsCursor>,dependencies:{request?:Request}={}):Promise<JobOutcome<StarsCursor>>{
 const deadline=Date.now()+15_000;
 if(ctx.cursor?.retryAfter && Date.parse(ctx.cursor.retryAfter)>Date.now())return {done:false,cursor:ctx.cursor};
 let afterId=ctx.cursor?.afterId??0;
 const rows=await db.select({id:products.id,repoUrl:products.repoUrl,updatedAt:sql<string>`${products.updatedAt}::text`}).from(products).where(and(
  inArray(products.status,[...PUBLIC]),sql`${products.repoUrl} is not null`,sql`${products.id}>${afterId}`,
  sql`(${products.starsAt} is null or ${products.starsAt}<now()-interval '24 hours')`,
  sql`(${products.starsCheckedAt} is null or ${products.starsCheckedAt}<now()-interval '1 hour')`,
 )).orderBy(asc(products.id)).limit(40);
 const request=dependencies.request??githubRequest<Record<string,unknown>>;
 let updated=0,failed=0;
 for(let offset=0;offset<rows.length;offset+=3){
  if(!ctx.hasBudget()||ctx.signal?.aborted||Date.now()>deadline-1000)return {done:false,cursor:{afterId}};
  const batch=rows.slice(offset,offset+3);
  const outcomes=await Promise.all(batch.map(async row=>{
   const owner=githubOwnerFromRepositoryUrl(row.repoUrl);
   const repo=owner?.repositoryUrl.slice('https://github.com/'.length);
   let result:GitHubHttpResult<Record<string,unknown>>;
   try{result=repo?await request(`/repos/${repo}`,{},{timeoutMs:Math.min(8000,deadline-Date.now())}):{ok:false,error:{kind:'invalid_response'}};}
   catch{ return {retryAt:new Date(Date.now()+60*60_000)}; }
   if(!result.ok && result.error.kind==='rate_limited')return {retryAt:result.error.resetAt??new Date(Date.now()+15*60_000)};
   if(!result.ok && result.error.kind==='http' && [401,403].includes(result.error.status))return {retryAt:new Date(Date.now()+60*60_000)};
   const stats=result.ok&&result.status===200?parseRepositoryStats(result.value):null;
   // 레포나 공개 상태가 요청 중 바뀌면 이전 응답을 적용하지 않는다. 임대도 같은 트랜잭션에서 확인한다.
   const changed=await db.transaction(async tx=>{
    if(ctx.lease)await assertJobLease(tx,ctx.lease);
    return tx.update(products).set({starsCheckedAt:sql`now()`,...(stats?{...stats,starsAt:sql`now()`}:{})})
     .where(and(eq(products.id,row.id),eq(products.repoUrl,row.repoUrl!),sql`${products.updatedAt}=${row.updatedAt}::timestamp`,inArray(products.status,[...PUBLIC])))
     .returning({id:products.id});
   });
   if(stats)updated+=changed.length;else failed++;
   return {};
  }));
  const retries=outcomes.flatMap(o=>o.retryAt?[o.retryAt]:[]);
  if(retries.length){
   const retryAfter=new Date(Math.max(...retries.map(d=>d.getTime()))).toISOString();
   await ctx.save({afterId,retryAfter});ctx.log('product_stars.waiting',{updated,failed});return {done:false,cursor:{afterId,retryAfter}};
  }
  afterId=batch.at(-1)!.id;await ctx.save({afterId});
 }
 ctx.log('product_stars.refreshed',{updated,failed,examined:rows.length});
 return rows.length<40?{done:true,cursor:null}:{done:false,cursor:{afterId}};
}
