import {and,asc,inArray,sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {products} from '@/lib/db/schema';
import {checkRepositories,REPOSITORY_BATCH,type RepositoryBatchResult,type RepositoryCheck,type RepositoryRef} from '@/lib/crawl/github-repositories';
import {githubOwnerFromRepositoryUrl} from '@/lib/domain/products/github-owner';
import {STARS_BASELINE_HOURS} from '@/lib/domain/products/stars';
import {assertJobLease} from '@/lib/jobs/control';
import type {JobContext,JobOutcome} from '@/lib/jobs/runner';
/** afterId 는 옛 ID 차례 순회의 자리다 — 지금은 쓰지 않고, 남아 있어도 무시한다 */
export type StarsCursor={afterId?:number;retryAfter?:string};
type Check=(repos:RepositoryRef[],options:{timeoutMs:number})=>Promise<RepositoryBatchResult>;
const PUBLIC=['seeded','verified'] as const;

/**
 * 공개 제품의 GitHub 저장소를 하루 한 번 모두 본다 — 있는지·비었는지·막혔는지와 스타·보관·마지막 push·바뀐 이름.
 *
 * GraphQL 로 50개씩 묻는다(github-repositories.ts, 한 번 1점·3~4초). 묶음 사이 1초 쉬며 한 번에 하나씩(2차 한도),
 * 틱 시작 28초 안에서만 새 묶음을 연다 — 한 틱에 6~7묶음(약 300개), 5분마다라 하루 약 9만 개, GraphQL 점수는 하루 2천 점 안쪽
 * (토큰 하나가 시간당 5,000점). 2026-10-08 공개 저장소 3만 7천 개를 20시간마다 보려면 하루 4만 4천 개 — 2배 남짓 여유이고,
 * 하루 2천 개 넘게 늘면 두어 주 뒤 다시 본다. 모자라면 운영센터의 '저장소 확인 범위'가 95% 아래로 떨어져 알린다.
 * (처음엔 100개씩·틱 14초였는데 100개 묶음이 GitHub 10초 질의 상한을 넘어 묶음째 실패했다 — github-repositories.ts)
 *
 * 차례: 잡이 한 번도 보지 않은 새 제품(unseen, #305)을 먼저, 그다음 저장소를 가장 오래 확인하지 않은 것(아직 없는 것 먼저).
 * 다시 볼 때: 'ok' 는 20시간 뒤, 없음·빈 저장소·막힘은 24시간 뒤 — 첫 '없음' 다음 확인이 곧 하루 넘게 이어졌다는
 * 확정(repository.ts repoGone)이 된다. 묶음 전체가 시간 초과·5xx 로 실패하거나 별칭 하나가 알 수 없는 오류면 상태는 그대로 두고
 * 시도 시각(stars_checked_at)만 남겨 한 시간 뒤에 다시 본다 — 같은 행이 매 틱 앞을 막지 않는다.
 */
const BATCHES=8;
/** 새 묶음은 틱 시작 뒤 이 안에서만 연다 — 한 묶음이 10초(githubRequest 상한)까지 걸려도 이 잡의 예산 40초(scripts/worker.ts) 안에 끝난다 */
const START_WITHIN_MS=28_000;
const PAUSE_MS=1_000;
/** GraphQL 점수가 이만큼 아래로 내려가면 이번 틱을 접고 초기화 시각까지 기다린다 — 다른 잡의 몫을 남긴다 */
const MIN_REMAINING=200;

/**
 * 잡이 아직 한 번도 보지 않은 제품 — 발행 때 적은 첫 관측뿐이라 급상승에 오를 수 없다.
 * 한 번 보면(성공이든 실패든) 시도 시각이 남아 여기서 빠진다 — 지워진 저장소가 매번 앞을 차지하지 않는다.
 */
const unseen=sql`(${products.starsPreviousAt} is null and ${products.starsCheckedAt} is null)`;
const due=and(
 inArray(products.status,[...PUBLIC]),sql`${products.repoUrl} is not null`,
 sql`(${products.repoCheckedAt} is null or ${products.repoCheckedAt}<now()-case when ${products.repoStatus} in ('not_found','empty','blocked') then interval '24 hours' else interval '20 hours' end)`,
 sql`(${products.starsCheckedAt} is null or ${products.starsCheckedAt}<now()-interval '1 hour')`,
);

type Row={id:number;repoUrl:string|null;updatedAt:string};

/**
 * 한 묶음의 답을 한 문장으로 적는다. 레포나 공개 상태가 묻는 사이 바뀌었으면(updated_at·repo_url) 그 행은 적지 않는다.
 *
 * 스타: 받은 값은 늘 지금 값으로 적되, 지금 값이 STARS_BASELINE_HOURS 보다 오래됐을 때만 그것을 이전 값으로 넘긴다.
 * 그래서 이전·지금 사이는 늘 20시간 이상이고, 하루에 한 번 보는 동안 구간은 하루 남짓이다(급상승의 하루 평균이 맞다).
 * 새 제품을 발행 직후에 보면 넘기지 않고 지금 값만 새로 적는다 — 다음 확인(20시간 뒤)에 넘긴다.
 * 없음·빈 저장소의 시작(repo_missing_since)은 둘이 번갈아도 이어진 하나로 본다.
 * repo_changed_at 은 앞선 확정 답과 상태·보관·이름이 달라졌을 때만 고친다 — 처음 적는 답(앞선 확인 없음, 보관 값 없음)은 바뀐 것이 아니다.
 */
async function record(ctx:JobContext<StarsCursor>,rows:Row[],checks:(RepositoryCheck|null)[]){
 const values=rows.map((row,index)=>{
  const check=checks[index];
  return {id:row.id,repo_url:row.repoUrl,updated_at:row.updatedAt,status:check?.status??null,found:!!check?.facts,
   stars:check?.facts?.stars??null,owner_type:check?.facts?.ownerType??null,archived:check?.facts?.archived??null,
   pushed_at:check?.facts?.pushedAt??null,renamed_to:check?.facts?.renamedTo??null};
 });
 const shift=sql`(v.stars is not null and (p.stars_at is null or p.stars_at<=now()-make_interval(hours=>${STARS_BASELINE_HOURS}::int)))`;
 return db.transaction(async tx=>{
  if(ctx.lease)await assertJobLease(tx,ctx.lease);
  return tx.execute<{id:number;status:string|null}>(sql`
   update products p set
    stars_checked_at=now(),
    stars_previous=case when ${shift} then p.stars else p.stars_previous end,
    stars_previous_at=case when ${shift} then p.stars_at else p.stars_previous_at end,
    stars=coalesce(v.stars,p.stars),
    stars_at=case when v.stars is null then p.stars_at else now() end,
    owner_type=case when v.stars is null then p.owner_type else v.owner_type end,
    repo_status=coalesce(v.status,p.repo_status),
    repo_checked_at=case when v.status is null then p.repo_checked_at else now() end,
    repo_missing_since=case when v.status is null then p.repo_missing_since
     when v.status in ('not_found','empty') then coalesce(p.repo_missing_since,now()) else null end,
    repo_archived=case when v.found then v.archived else p.repo_archived end,
    repo_pushed_at=case when v.found then v.pushed_at at time zone 'UTC' else p.repo_pushed_at end,
    repo_renamed_to=case when v.found then v.renamed_to else p.repo_renamed_to end,
    repo_changed_at=case when v.status is null or p.repo_checked_at is null then p.repo_changed_at
     when v.status is distinct from p.repo_status then now()
     when v.found and p.repo_archived is not null
      and (v.archived is distinct from p.repo_archived or v.renamed_to is distinct from p.repo_renamed_to) then now()
     else p.repo_changed_at end
   from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v(id int,repo_url text,updated_at text,status text,found boolean,
    stars int,owner_type text,archived boolean,pushed_at timestamptz,renamed_to text)
   where p.id=v.id and p.repo_url=v.repo_url and p.updated_at=v.updated_at::timestamp and p.status in ('seeded','verified')
   returning p.id,v.status`);
 });
}

export async function refreshProductStars(ctx:JobContext<StarsCursor>,dependencies:{check?:Check}={}):Promise<JobOutcome<StarsCursor>>{
 const startedAt=Date.now();
 if(ctx.cursor?.retryAfter && Date.parse(ctx.cursor.retryAfter)>Date.now())return {done:false,cursor:ctx.cursor};
 const limit=REPOSITORY_BATCH*BATCHES;
 const columns={id:products.id,repoUrl:products.repoUrl,updatedAt:sql<string>`${products.updatedAt}::text`};
 const first=await db.select(columns).from(products).where(and(due,unseen)).orderBy(asc(products.id)).limit(limit);
 // 저장소를 아직 한 번도 확인하지 않은 것은 새 제품부터 — '최신' 목록은 확인을 마친 제품만 보이므로(#317) 오래된 것부터 돌면
 // 최근 제품이 가장 늦게 확인돼 최신 목록이 비었다. 확인한 것은 가장 오래 전에 본 것부터
 const rest=first.length<limit?await db.select(columns).from(products).where(and(due,sql`not ${unseen}`))
  .orderBy(sql`${products.repoCheckedAt} asc nulls first`,sql`case when ${products.repoCheckedAt} is null then ${products.id} end desc nulls last`,asc(products.id))
  .limit(limit-first.length):[];
 const rows=[...first,...rest];
 const check=dependencies.check??checkRepositories;
 const counts={examined:0,updated:0,ok:0,missing:0,empty:0,blocked:0,unknown:0,renamed:0,archived:0,batches:0};
 const wait=async(retryAfter:Date)=>{
  const cursor={retryAfter:retryAfter.toISOString()};
  await ctx.save(cursor);ctx.log('product_stars.waiting',counts);return {done:false,cursor};
 };
 for(let offset=0;offset<rows.length;offset+=REPOSITORY_BATCH){
  if(!ctx.hasBudget()||ctx.signal?.aborted||Date.now()-startedAt>START_WITHIN_MS){
   ctx.log('product_stars.refreshed',counts);return {done:false,cursor:null};
  }
  if(offset>0)await new Promise(resolve=>setTimeout(resolve,PAUSE_MS));
  const batch=rows.slice(offset,offset+REPOSITORY_BATCH);
  // 주소가 GitHub 저장소 꼴이 아니면 물을 수 없다 — 시도 시각만 남긴다
  const refs=batch.map(row=>{
   const owner=githubOwnerFromRepositoryUrl(row.repoUrl);
   return owner?{owner:owner.login,name:owner.repositoryUrl.slice(owner.profileUrl.length+1)}:null;
  });
  const asked=refs.filter((ref):ref is RepositoryRef=>ref!==null);
  let result:RepositoryBatchResult;
  try{result=asked.length?await check(asked,{timeoutMs:10_000}):{ok:true,checks:[],rateLimit:null};}
  catch{result={ok:false,error:{kind:'transport'}};}
  if(!result.ok && (result.error.kind==='rate_limited'||result.error.kind==='auth_unavailable'))
   return wait(result.error.resetAt??new Date(Date.now()+15*60_000));
  if(!result.ok && result.error.kind==='http' && result.error.status===401)return wait(new Date(Date.now()+60*60_000));
  let answered=0;
  const checks=refs.map(ref=>ref&&result.ok?result.checks[answered++]??null:null);
  const changed=await record(ctx,batch,checks);
  counts.batches++;counts.examined+=batch.length;
  for(const [index,check] of checks.entries()){
   if(!changed.some(row=>row.id===batch[index].id))continue;
   if(check?.facts?.stars!=null)counts.updated++;
   if(check?.status==='ok')counts.ok++;else if(check?.status==='not_found')counts.missing++;
   else if(check?.status==='empty')counts.empty++;else if(check?.status==='blocked')counts.blocked++;else counts.unknown++;
   if(check?.facts?.renamedTo)counts.renamed++;
   if(check?.facts?.archived)counts.archived++;
  }
  // 묶음 전체가 실패했다(시간 초과·5xx·깨진 응답) — 시도 시각은 남겼다. GitHub 이 흔들리는 동안 뒤 묶음을 더 보내지 않는다
  if(!result.ok){ctx.log('product_stars.refreshed',{...counts,failed:true});return {done:false,cursor:null};}
  if(result.rateLimit && result.rateLimit.remaining<MIN_REMAINING){
   const reset=result.rateLimit.resetAt?Date.parse(result.rateLimit.resetAt):Number.NaN;
   return wait(new Date(Number.isFinite(reset)&&reset>Date.now()?reset:Date.now()+15*60_000));
  }
 }
 ctx.log('product_stars.refreshed',counts);
 return {done:rows.length<limit,cursor:null};
}
