import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import type{JobContext,JobOutcome}from'@/lib/jobs/runner';
import{loadThumbnailProduct,listDueThumbnails,saveThumbnail}from'@/lib/domain/products/thumbnails/repository';import{resolveThumbnail}from'@/lib/domain/products/thumbnails/resolver';
export async function refreshProductThumbnails(ctx:JobContext<null>):Promise<JobOutcome<null>>{
 let permitError:HttpOriginPermitError|undefined;
 const slugs=await listDueThumbnails(6);let filled=0,defaults=0,skipped=0,failed=0;
 await Promise.all(slugs.map(async slug=>{
  if(!ctx.hasBudget())return;try{const product=await loadThumbnailProduct(slug);if(!product){skipped++;return;}
   const result=await resolveThumbnail(product,{signal:ctx.signal});
   if(!ctx.hasBudget()||ctx.signal?.aborted){skipped++;return;}
   if(!await saveThumbnail(product,result,ctx.lease)){skipped++;return;}
   if(result.kind==='default')defaults++;else filled++;
  }catch(error){if(error instanceof HttpOriginPermitError)permitError??=error;else failed++;}
 }));
 if(permitError)throw permitError;
 ctx.log('thumbnail.refreshed',{examined:slugs.length,filled,defaults,skipped,failed});return {done:slugs.length<6};
}
