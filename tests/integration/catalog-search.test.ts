import{beforeAll,beforeEach,it,expect}from'vitest';import{db}from'@/lib/db';import{products}from'@/lib/db/schema';import{listProducts}from'@/lib/domain/products/repository';import{ensureSchema,resetTables}from'./setup';
beforeAll(ensureSchema);beforeEach(resetTables);
it('searches owner, repository and descriptions with literal AND terms',async()=>{
 await db.insert(products).values({slug:'deep-work',name:'Workspace',url:'https://workspace.example',tagline:'A useful app',description:'Plan quantum experiments with your team. 100%_literal.',repoUrl:'https://github.com/TeamOwner/DeepWork',category:'Dev',status:'seeded',source:'crawler',builder:'UnconfirmedAI',verifyToken:'v',editTokenHash:'e'});
 const search=async(query:string)=>(await listProducts({statuses:['seeded'],limit:10,query})).map(p=>p.slug);
 for(const q of['@TeamOwner','TeamOwner/DeepWork','quantum team','  experiments   quantum  ','100%_literal'])expect(await search(q)).toEqual(['deep-work']);
 for(const q of['quantum missing','UnconfirmedAI','100x_literal','100%Xliteral','Plan Plan Plan Plan Plan Plan Plan Plan Plan Plan Plan Plan absent'])expect(await search(q)).toEqual([]);
});
