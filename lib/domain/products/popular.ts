import { displayProjectName } from './display-name';
import type { StarObservation } from './star-change';
import {and,asc,eq,inArray,isNotNull,sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {products,type TaglineSource} from '@/lib/db/schema';
import {listedByDefault,notDown,repoGone,starGainPerDay} from './repository';
import {taglineKo} from './korean-tagline';
import {STAR_TIERS,type PopularSort,type StarTier} from './stars';

export type PopularProduct=StarObservation&{slug:string;name:string;tagline:string;taglineKo:string|null;taglineSource:TaglineSource;category:string;repoUrl:string|null;repoRenamedTo:string|null;ogImage:string|null;stars:number;ownerType:'User'|'Organization'|null;starsAt:string|null;
 accessMode:'website'|'installable';aiLevel:number|null;makerName:string|null};
/** /popular 거르기 — 개인 계정만, AI로 제작(근거 단계가 있는 것), 분야 하나. 홈 구간은 개인 계정만 쓴다 */
export type PopularFilters={personal:boolean;ai:boolean;category:string|null};
const NO_FILTERS:PopularFilters={personal:false,ai:false,category:null};
const fields={slug:products.slug,name:products.name,tagline:products.tagline,taglineKo,taglineSource:products.taglineSource,category:products.category,repoUrl:products.repoUrl,repoRenamedTo:products.repoRenamedTo,ogImage:products.ogImage,
 starsPrevious:products.starsPrevious,starsPreviousAt:sql<string|null>`${products.starsPreviousAt}::text`,
 stars:sql<number>`${products.stars}`,ownerType:products.ownerType,starsAt:sql<string|null>`${products.starsAt}::text`,
 accessMode:products.accessMode,aiLevel:products.aiLevel,makerName:products.makerName};
// 저장소가 사라진 제품의 스타는 마지막으로 본 옛 값이라 구간에 넣지 않는다(repository.ts repoGone)
function publicStars(f:PopularFilters){return and(inArray(products.status,['seeded','verified']),notDown,listedByDefault,sql`not ${repoGone}`,
 sql`${products.stars}>=2000 and ${products.stars}<100000`,f.personal?eq(products.ownerType,'User'):undefined,
 f.ai?isNotNull(products.aiLevel):undefined,f.category?eq(products.category,f.category):undefined);}
const inTier=(tier:StarTier)=>{const t=STAR_TIERS.find(t=>t.key===tier)!;return sql`${products.stars}>=${t.min} and ${products.stars}<${t.max}`;};
async function counts(f:PopularFilters){
 const [row]=await db.execute<{rising:number;noticed:number;popular:number;large:number}>(sql`select
 count(*) filter(where stars>=2000 and stars<5000)::int rising,
 count(*) filter(where stars>=5000 and stars<10000)::int noticed,
 count(*) filter(where stars>=10000 and stars<30000)::int popular,
 count(*) filter(where stars>=30000 and stars<100000)::int large
 from products where ${publicStars(f)}`);
 return STAR_TIERS.map(t=>row[t.key]);
}
/** 요즘 많이 는 순은 홈 '지금 뜨는'과 같은 하루 평균 증가(repository.ts starGainPerDay) — 셀 수 없는 행은 뒤로, 같으면 스타 순 */
const order=(sort:PopularSort)=>sort==='rising'?[sql`${starGainPerDay} desc nulls last`,sql`${products.stars} desc`]:[sql`${products.stars} desc`];
async function items(tier:StarTier,f:PopularFilters,sort:PopularSort,limit:number,offset=0):Promise<PopularProduct[]>{
 const rows = await db.select(fields).from(products).where(and(publicStars(f),inTier(tier)))
  .orderBy(...order(sort),asc(products.id)).limit(limit).offset(offset);
 return rows.map(p=>({...p,name:displayProjectName(p.name,p.repoUrl)}));
}
export async function getPopularGroups(personal=false){
 const f={...NO_FILTERS,personal};
 const [totals,...lists]=await Promise.all([counts(f),...STAR_TIERS.map(t=>items(t.key,f,'stars',3))]);
 return STAR_TIERS.map((tier,index)=>({...tier,total:(totals as number[])[index],items:lists[index] as PopularProduct[]}));
}

/**
 * 거르기 칩의 수 — 누르면 나올 목록의 수와 같게 센다(홈 BrowseFilters 와 같은 약속).
 * 분야 칩은 지금 켠 개인·AI 를 반영한 분야별 수, 'AI로 제작'·'개인 계정만'은 그것을 켰을 때의 수(나머지 거르기는 그대로).
 * 한 구간 안의 행만 한 번 훑는다(구간마다 수백 건).
 */
export type PopularFacets={categories:{category:string;count:number}[];all:number;ai:number;personal:number};
export async function getPopularFacets(tier:StarTier,f:PopularFilters):Promise<PopularFacets>{
 const personal=f.personal?sql`owner_type='User'`:sql`true`;
 const ai=f.ai?sql`ai_level is not null`:sql`true`;
 const rows=await db.execute<{category:string;n:number;ai:number;personal:number}>(sql`select category,
 count(*) filter(where ${personal} and ${ai})::int n,
 count(*) filter(where ${personal} and ai_level is not null)::int ai,
 count(*) filter(where owner_type='User' and ${ai})::int personal
 from products where ${publicStars({...f,personal:false,ai:false,category:null})} and ${inTier(tier)} group by category`);
 const scoped=f.category?rows.filter(r=>r.category===f.category):rows;
 const sum=(key:'n'|'ai'|'personal')=>scoped.reduce((total,r)=>total+Number(r[key]),0);
 const categories=rows.map(r=>({category:r.category,count:Number(r.n)})).filter(r=>r.count>0||r.category===f.category)
  .sort((a,b)=>b.count-a.count||a.category.localeCompare(b.category));
 return {categories,all:rows.reduce((total,r)=>total+Number(r.n),0),ai:sum('ai'),personal:sum('personal')};
}

export async function getPopularPage(tier:StarTier,f:PopularFilters=NO_FILTERS,sort:PopularSort='stars',requestedPage=1,pageSize=15){
 const totals=await counts(f),total=totals[STAR_TIERS.findIndex(t=>t.key===tier)];
 const pages=Math.max(1,Math.ceil(total/pageSize));
 const page=Number.isInteger(requestedPage)&&requestedPage>=1&&requestedPage<=pages?requestedPage:1;
 return {items:await items(tier,f,sort,pageSize,(page-1)*pageSize),total,totals,page,pages,pageSize};
}
