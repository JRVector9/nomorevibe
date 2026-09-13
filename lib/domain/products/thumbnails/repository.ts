import{and,eq,inArray,sql}from'drizzle-orm';import{db}from'@/lib/db';import{products,productThumbnailState,ogImages,crawlDocuments}from'@/lib/db/schema';
import{assertJobLease,type JobLease}from'@/lib/jobs/control';import{lockProductGeneration}from'@/lib/domain/products/generation';
import{THUMBNAIL_RANK,type ThumbnailInput,type ThumbnailResult,type ThumbnailKind}from'./resolver';
export type ThumbnailProduct=ThumbnailInput&{id:number;slug:string;ogImage:string|null;updatedAt:string};
const PUBLIC=['seeded','verified'] as const;
const noMedia=sql`not exists(select 1 from product_media m where m.slug=${products.slug} and m.current and m.visible)`;
export async function listDueThumbnails(limit:number):Promise<string[]>{
 const rows=await db.select({slug:products.slug}).from(products).leftJoin(productThumbnailState,eq(products.slug,productThumbnailState.slug)).where(and(inArray(products.status,[...PUBLIC]),noMedia,
  sql`(${products.ogImage} is null or (${products.ogImage} like '/api/og-cache/%?thumbnail=%' and ${productThumbnailState.nextAttemptAt}<=now()))`,
  sql`(${productThumbnailState.nextAttemptAt} is null or ${productThumbnailState.nextAttemptAt}<=now())`,
 )).orderBy(sql`${productThumbnailState.checkedAt} asc nulls first`,products.id).limit(Math.max(1,Math.min(100,limit)));
 return rows.map(r=>r.slug);
}
export async function loadThumbnailProduct(slug:string):Promise<ThumbnailProduct|null>{
 const [p]=await db.select({id:products.id,slug:products.slug,name:products.name,url:products.url,repoUrl:products.repoUrl,ogImage:products.ogImage,updatedAt:sql<string>`${products.updatedAt}::text`}).from(products).where(and(eq(products.slug,slug),inArray(products.status,[...PUBLIC]),noMedia)).limit(1);
 if(!p)return null;
 const key=p.repoUrl?.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/?#]+)\/?$/i)?.[1]?.replace(/\.git$/,'');
 const d=key?await db.query.crawlDocuments.findFirst({where:eq(crawlDocuments.repo,key),columns:{pageMeta:true,repoMeta:true}}):null;
 return {...p,pageMeta:d?.pageMeta,repoMeta:d?.repoMeta};
}
export async function saveThumbnail(p:ThumbnailProduct,result:ThumbnailResult,lease?:JobLease):Promise<boolean>{
 return db.transaction(async tx=>{
  if(lease)await assertJobLease(tx,lease);
  if(!await lockProductGeneration(tx,p.id,p.slug))return false;
  const [current]=await tx.select({id:products.id}).from(products).where(and(eq(products.id,p.id),eq(products.url,p.url),sql`${products.repoUrl} is not distinct from ${p.repoUrl}`,sql`${products.updatedAt}=${p.updatedAt}::timestamp`,sql`${products.ogImage} is not distinct from ${p.ogImage}`,inArray(products.status,[...PUBLIC]),noMedia));
  if(!current||p.ogImage&&!p.ogImage.startsWith(`/api/og-cache/${p.slug}?thumbnail=`))return false;
  const old=await tx.query.productThumbnailState.findFirst({where:eq(productThumbnailState.slug,p.slug)});
  const downgrade=old&&p.ogImage&&THUMBNAIL_RANK[result.kind]>THUMBNAIL_RANK[old.kind as ThumbnailKind];
  const kind=downgrade?old.kind as ThumbnailKind:result.kind;
  const values={kind,sourceUrl:downgrade?old.sourceUrl:result.sourceUrl,width:downgrade?old.width:result.width,height:downgrade?old.height:result.height,
   checkedAt:sql`now()`,nextAttemptAt:kind==='og'?null:sql`now()+interval '1 day'`,lastError:result.errors.length?result.errors.slice(0,4).join(',').slice(0,120):null};
  await tx.insert(productThumbnailState).values({slug:p.slug,...values}).onConflictDoUpdate({target:productThumbnailState.slug,set:{...values,attempts:sql`${productThumbnailState.attempts}+1`}});
  if(!downgrade){
   await tx.insert(ogImages).values({slug:p.slug,contentType:'image/webp',data:result.data}).onConflictDoUpdate({target:ogImages.slug,set:{contentType:'image/webp',data:result.data}});
   const path=`/api/og-cache/${p.slug}?thumbnail=${kind}&w=${result.width}&h=${result.height}&v=${Date.now()}`;
   await tx.update(products).set({ogImage:path}).where(eq(products.id,p.id));
  }
  return true;
 });
}
