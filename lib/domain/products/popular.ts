import {and,asc,desc,eq,inArray,sql} from 'drizzle-orm';
import {db} from '@/lib/db';
import {products} from '@/lib/db/schema';
import {notDown} from './repository';
import {STAR_TIERS,type StarTier} from './stars';

export type PopularProduct={slug:string;name:string;tagline:string;category:string;repoUrl:string|null;stars:number;ownerType:'User'|'Organization'|null;starsAt:string|null};
const fields={slug:products.slug,name:products.name,tagline:products.tagline,category:products.category,repoUrl:products.repoUrl,
 stars:sql<number>`${products.stars}`,ownerType:products.ownerType,starsAt:sql<string|null>`${products.starsAt}::text`};
function publicStars(personal:boolean){return and(inArray(products.status,['seeded','verified']),notDown,
 sql`${products.stars}>=2000 and ${products.stars}<100000`,personal?eq(products.ownerType,'User'):undefined);}
async function counts(personal:boolean){
 const [row]=await db.execute<{rising:number;noticed:number;popular:number;large:number}>(sql`select
 count(*) filter(where stars>=2000 and stars<5000)::int rising,
 count(*) filter(where stars>=5000 and stars<10000)::int noticed,
 count(*) filter(where stars>=10000 and stars<30000)::int popular,
 count(*) filter(where stars>=30000 and stars<100000)::int large
 from products where ${publicStars(personal)}`);
 return STAR_TIERS.map(t=>row[t.key]);
}
async function items(tier:StarTier,personal:boolean,limit:number,offset=0):Promise<PopularProduct[]>{
 const t=STAR_TIERS.find(t=>t.key===tier)!;
 return db.select(fields).from(products).where(and(publicStars(personal),sql`${products.stars}>=${t.min} and ${products.stars}<${t.max}`))
  .orderBy(desc(products.stars),asc(products.id)).limit(limit).offset(offset);
}
export async function getPopularGroups(personal=false){
 const [totals,...lists]=await Promise.all([counts(personal),...STAR_TIERS.map(t=>items(t.key,personal,10))]);
 return STAR_TIERS.map((tier,index)=>({...tier,total:(totals as number[])[index],items:lists[index] as PopularProduct[]}));
}
export async function getPopularPage(tier:StarTier,personal=false,requestedPage=1,pageSize=15){
 const totals=await counts(personal),total=totals[STAR_TIERS.findIndex(t=>t.key===tier)];
 const pages=Math.max(1,Math.ceil(total/pageSize));
 const page=Number.isInteger(requestedPage)&&requestedPage>=1&&requestedPage<=pages?requestedPage:1;
 return {items:await items(tier,personal,pageSize,(page-1)*pageSize),total,totals,page,pages};
}
