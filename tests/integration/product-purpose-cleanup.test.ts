import{beforeAll,beforeEach,it,expect}from'vitest';import{eq,sql}from'drizzle-orm';import{db}from'@/lib/db';import{products,productEvidenceAudit,crawlDocuments}from'@/lib/db/schema';import{planPurposeRemovals,applyPurposeRemoval}from'@/lib/crawl/product-purpose-cleanup';import{ensureSchema,resetTables}from'./setup';
beforeAll(ensureSchema);beforeEach(resetTables);
async function seed(name:string,tagline:string){const slug=name.toLowerCase().replaceAll(' ','-');return(await db.insert(products).values({slug,name,tagline,description:tagline,url:`https://${slug}.example`,category:'Education',status:'seeded',source:'crawler',verifyToken:'v',editTokenHash:'e'}).returning())[0];}
it('previews without mutation and removes only definite unclaimed non-products with an audit',async()=>{
 const p=await seed('Personal Research Notes','My research journal');await seed('Survey Builder','A survey platform for teams');
 const plan=await planPurposeRemovals();expect(plan.map(p=>p.slug)).toEqual([p.slug]);expect((await db.select().from(products).where(eq(products.id,p.id)))[0].status).toBe('seeded');
 expect(await applyPurposeRemoval(plan[0])).toBe(true);expect(await applyPurposeRemoval(plan[0])).toBe(false);expect(await db.select().from(productEvidenceAudit)).toHaveLength(1);
 expect((await db.select().from(products).where(eq(products.id,p.id)))[0].status).toBe('banned');
});
it('preserves a product edited or claimed after preview',async()=>{
 const p=await seed('Personal Research Notes','My research journal');const plan=await planPurposeRemovals();await db.update(products).set({name:'Research tool',updatedAt:sql`now()+interval '1 second'`}).where(eq(products.id,p.id));expect(await applyPurposeRemoval(plan[0])).toBe(false);expect(await db.select().from(productEvidenceAudit)).toHaveLength(0);
});

it('uses current page identity instead of stale catalogue identity and freezes all evidence',async()=>{
 const p=await seed('Personal Research Notes','My research journal');
 await db.update(products).set({repoUrl:'https://github.com/owner/project'}).where(eq(products.id,p.id));
 await db.insert(crawlDocuments).values({repo:'owner/project',repoMeta:{},productUrl:p.url,pageStatus:200,pageMeta:{title:'Research Notes Manager',description:'A research tool for teams'}});
 expect(await planPurposeRemovals()).toHaveLength(0);
 await db.update(crawlDocuments).set({pageMeta:{title:'My research notes',description:'Personal research journal',textSample:'Original notes'}}).where(eq(crawlDocuments.repo,'owner/project'));
 const plan=await planPurposeRemovals();expect(plan).toHaveLength(1);
 await db.update(crawlDocuments).set({pageMeta:{title:'My research notes',description:'Personal research journal',textSample:'Changed notes'}}).where(eq(crawlDocuments.repo,'owner/project'));
 expect(await applyPurposeRemoval(plan[0])).toBe(false);
 expect((await db.select().from(products).where(eq(products.id,p.id)))[0].status).toBe('seeded');
});
