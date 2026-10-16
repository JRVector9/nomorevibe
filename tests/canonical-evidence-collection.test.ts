import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { collectCanonicalSite } from "@/lib/domain/evidence/canonical-collection";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import type { ProductEvidenceSource } from "@/lib/db/product-evidence-schema";
const url="https://site.example";
const body=Buffer.from('<a href="https://github.com/owner/repo">Source code</a>');
const digest=createHash("sha256").update(body).digest("hex");
const full=()=>({ok:true as const,status:200,headers:new Headers({etag:'"a"'}),finalUrl:url,body});
const cached=()=>({sourceUrl:url,etag:'"a"',lastModified:null,normalizedFacts:{type:"site_fingerprint",finalUrl:url,bodyDigest:digest,parserVersion:1,repositoryKeys:["owner/repo"]}} as Pick<ProductEvidenceSource,"sourceUrl"|"normalizedFacts"|"etag"|"lastModified">);
it("full canonical body preserves explicit repository evidence",async()=>{
 expect(await collectCanonicalSite(url,undefined,{fetch:async()=>full()})).toMatchObject({state:"ok",etag:'"a"',facts:{bodyDigest:digest,repositoryKeys:["owner/repo"]}});
});
it("same finalURL 304 preserves last-good facts and conditional validators",async()=>{
 const fetch=vi.fn<typeof import("@/lib/net/fetch").fetchCapped>().mockResolvedValue({...full(),status:304,headers:new Headers(),body:Buffer.alloc(0)});
 expect(await collectCanonicalSite(url,cached(),{fetch})).toMatchObject({state:"ok",etag:'"a"',facts:cached().normalizedFacts});
 expect(fetch.mock.calls[0][1]).toMatchObject({headers:{"If-None-Match":'"a"'},maxBytes:2*1024*1024});
});
it.each(["missing","different-final"])("%s cache cannot turn 304 into evidence",async kind=>{
 const stored=kind==="missing"?undefined:cached();
 const fetch=vi.fn().mockResolvedValueOnce({...full(),status:304,finalUrl:url+"/new",body:Buffer.alloc(0)}).mockResolvedValueOnce(full());
 expect((await collectCanonicalSite(url,stored,{fetch})).state).toBe("ok");
 expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][1].headers).toEqual({});
});
it("unresolved 304 is a failure and a cap boundary is incomplete",async()=>{
 expect(await collectCanonicalSite(url,undefined,{fetch:async()=>({...full(),status:304})})).toEqual({state:"failed",reason:"site_cacheless_304"});
 expect(await collectCanonicalSite(url,undefined,{fetch:async()=>({...full(),body:Buffer.alloc(2*1024*1024)})})).toEqual({state:"incomplete"});
});
it("aborting never races an unfinished actual reader into completion",async()=>{
 const controller=new AbortController(); let settle!: (value:ReturnType<typeof full>)=>void;
 const fetch=vi.fn(()=>new Promise<ReturnType<typeof full>>(resolve=>{settle=resolve;}));
 let done=false; const work=collectCanonicalSite(url,undefined,{signal:controller.signal,fetch}).finally(()=>{done=true;});
 controller.abort(); await Promise.resolve(); expect(done).toBe(false); settle(full());
 expect(await work).toEqual({state:"incomplete"});
});
it("typed origin deferral keeps the exact error even if abort fires",async()=>{
 const controller=new AbortController(), error=new HttpOriginPermitError("waiting_aborted");
 await expect(collectCanonicalSite(url,undefined,{signal:controller.signal,fetch:async()=>{controller.abort();throw error;}})).rejects.toBe(error);
});
it("result contract rejects malformed evidence and caller completion flags",async()=>{
 const {CanonicalCollectionSchema}=await import("@/lib/domain/evidence/canonical-collection");
 const value={state:"ok",facts:cached().normalizedFacts,etag:null,lastModified:null};
 expect(CanonicalCollectionSchema.safeParse(value).success).toBe(true);
 for(const result of [{...value,complete:true},{...value,facts:{...value.facts,repositoryKeys:["not-a-repository"]}},
 {state:"failed",reason:""},{state:"incomplete",attempts:1}]) expect(CanonicalCollectionSchema.safeParse(result).success).toBe(false);
});
