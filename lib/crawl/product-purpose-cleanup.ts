import{createHash}from'node:crypto';
import{and,desc,eq,inArray,isNull,sql}from'drizzle-orm';import{db}from'@/lib/db';import{products,crawlDocuments,productEvidenceAudit}from'@/lib/db/schema';import{lockProductGeneration}from'@/lib/domain/products/generation';import{nonProductPurpose,type NonProductPurpose}from'./product-purpose';
export type PurposeRemoval={id:number;slug:string;url:string;repoUrl:string|null;name:string;tagline:string;updatedAt:string;documentAt:string|null;evidenceHash:string;purpose:NonProductPurpose};
function classificationInput(name:string,tagline:string,meta:Record<string,unknown>|null|undefined){
 return {title:typeof meta?.title==='string'&&meta.title.trim()?meta.title:name,description:typeof meta?.description==='string'&&meta.description.trim()?meta.description:tagline,textSample:typeof meta?.textSample==='string'?meta.textSample:null};
}
const evidenceHash=(input:ReturnType<typeof classificationInput>)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export async function planPurposeRemovals():Promise<PurposeRemoval[]>{
 const rows=await db.select({id:products.id,slug:products.slug,url:products.url,repoUrl:products.repoUrl,name:products.name,tagline:products.tagline,updatedAt:sql<string>`${products.updatedAt}::text`,documentAt:sql<string|null>`${crawlDocuments.fetchedAt}::text`,pageMeta:crawlDocuments.pageMeta}).from(products).leftJoin(crawlDocuments,sql`lower(${products.repoUrl})=lower('https://github.com/'||${crawlDocuments.repo})`).where(and(inArray(products.status,['seeded','verified']),eq(products.source,'crawler'),isNull(products.claimedAt))).orderBy(products.id,desc(crawlDocuments.fetchedAt));
 const seen=new Set<number>();
 return rows.flatMap(({pageMeta,...p})=>{if(seen.has(p.id))return [];seen.add(p.id);const input=classificationInput(p.name,p.tagline,pageMeta);const purpose=nonProductPurpose(input);return purpose?[{...p,evidenceHash:evidenceHash(input),purpose}]:[];});
}
export async function applyPurposeRemoval(expected:PurposeRemoval):Promise<boolean>{
 return db.transaction(async tx=>{
  if(!await lockProductGeneration(tx,expected.id,expected.slug))return false;
  const [p]=await tx.select().from(products).where(and(eq(products.id,expected.id),eq(products.slug,expected.slug),eq(products.url,expected.url),sql`${products.repoUrl} is not distinct from ${expected.repoUrl}`,sql`${products.updatedAt}=${expected.updatedAt}::timestamp`,inArray(products.status,['seeded','verified']),eq(products.source,'crawler'),isNull(products.claimedAt)));
  if(!p)return false;
  const [document]=await tx.select({at:sql<string>`${crawlDocuments.fetchedAt}::text`,pageMeta:crawlDocuments.pageMeta}).from(crawlDocuments).where(sql`lower('https://github.com/'||${crawlDocuments.repo})=lower(${p.repoUrl})`).orderBy(desc(crawlDocuments.fetchedAt)).limit(1).for('share');
  if((document?.at??null)!==expected.documentAt)return false;
  const input=classificationInput(p.name,p.tagline,document?.pageMeta);
  if(evidenceHash(input)!==expected.evidenceHash)return false;
  const purpose=nonProductPurpose(input);
  if(!purpose||purpose.kind!==expected.purpose.kind||purpose.evidence!==expected.purpose.evidence)return false;
  await tx.update(products).set({status:'banned',updatedAt:sql`now()`}).where(eq(products.id,p.id));
  await tx.insert(productEvidenceAudit).values({slug:p.slug,actor:'admin',action:'admin.product.ban',metadata:{reason:'not_a_product',policy:'content-purpose-2026-09-13',...purpose,beforeStatus:p.status,status:'banned'}});
  return true;
 });
}
