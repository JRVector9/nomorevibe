import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { OgStoreError } from "@/lib/storage/og-store";
import type{JobContext,JobOutcome}from'@/lib/jobs/runner';
import{loadThumbnailProduct,listDueThumbnails,saveThumbnail}from'@/lib/domain/products/thumbnails/repository';import{resolveThumbnail}from'@/lib/domain/products/thumbnails/resolver';
export async function refreshProductThumbnails(ctx:JobContext<null>):Promise<JobOutcome<null>>{
 let permitError:HttpOriginPermitError|undefined;
 const slugs=await listDueThumbnails(6);let filled=0,defaults=0,skipped=0,failed=0;let storeError:string|null=null;
 await Promise.all(slugs.map(async slug=>{
  if(!ctx.hasBudget())return;try{const product=await loadThumbnailProduct(slug);if(!product){skipped++;return;}
   const result=await resolveThumbnail(product,{signal:ctx.signal});
   if(!ctx.hasBudget()||ctx.signal?.aborted){skipped++;return;}
   if(!await saveThumbnail(product,result,ctx.lease)){skipped++;return;}
   if(result.kind==='default')defaults++;else filled++;
  }catch(error){if(error instanceof HttpOriginPermitError)permitError??=error;else{failed++;if(error instanceof OgStoreError)storeError=error.message;}}
 }));
 if(permitError)throw permitError;
 // 버킷 실패는 상태를 남기지 않아 다음 틱에 다시 한다 — 이유(동작·HTTP 상태)만 남긴다
 ctx.log('thumbnail.refreshed',{examined:slugs.length,filled,defaults,skipped,failed,...(storeError?{storeError}:{})});return {done:slugs.length<6};
}
