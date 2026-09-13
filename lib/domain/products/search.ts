import{and,ilike,isNotNull,ne,or}from'drizzle-orm';import{products,type Product}from'@/lib/db/schema';
export function searchTerms(query:string){return query.trim().slice(0,200).split(/\s+/).filter(Boolean).map(term=>term.replace(/^@(?=[\w-])/,''));}
const pattern=(term:string)=>`%${term.replace(/[\\%_]/g,c=>`\\${c}`)}%`;
export function productSearchPredicate(query:string){
 const reported=or(ne(products.source,'crawler'),isNotNull(products.claimedAt))!;
 return and(...searchTerms(query).map(term=>or(
  ...[products.name,products.tagline,products.description,products.slug,products.repoUrl].map(field=>ilike(field,pattern(term))),
  and(reported,ilike(products.builder,pattern(term))),
 )!));
}
export function matchesProductSearch(product:Pick<Product,'name'|'tagline'|'description'|'slug'|'repoUrl'|'builder'|'source'|'claimedAt'>,query:string){
 const values=[product.name,product.tagline,product.description,product.slug,product.repoUrl,product.source!=='crawler'||product.claimedAt!==null?product.builder:null].filter((s):s is string=>typeof s==='string').map(s=>s.toLowerCase());
 return searchTerms(query).every(term=>values.some(s=>s.includes(term.toLowerCase())));
}
