import{completedThumbnailIds}from'@/lib/domain/products/thumbnails/receipt';
import{readFileSync,appendFileSync,existsSync}from'node:fs';import{basename}from'node:path';
import{loadThumbnailProduct,saveThumbnail}from'@/lib/domain/products/thumbnails/repository';import{resolveThumbnail}from'@/lib/domain/products/thumbnails/resolver';
async function main(){
 const args=process.argv.slice(2);const path=args[0],receipt=args[1];if(!path||!receipt||args.some(a=>a.startsWith('--'))&&args.some(a=>!['--apply','--limit=12'].includes(a)&&a.startsWith('--')))throw new Error('Usage: backfill-thumbnails.ts cohort.json receipt.jsonl [--apply] [--limit=12]');
 const cohort=JSON.parse(readFileSync(path,'utf8')) as {rows:{id:number;slug:string}[]};if(!Array.isArray(cohort.rows)||cohort.rows.some(r=>!Number.isInteger(r.id)||!/^[-a-z0-9]+$/.test(r.slug)))throw new Error('Invalid cohort');
 const done=completedThumbnailIds(existsSync(receipt)?readFileSync(receipt,'utf8'):'');
 const queue=cohort.rows.filter(r=>!done.has(r.id)).slice(0,args.includes('--limit=12')?12:undefined);let count=0;
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
 await Promise.all(Array.from({length:8},async()=>{
  while(queue.length&&!controller.signal.aborted){const row=queue.shift()!;let out:Record<string,unknown>={id:row.id,slug:row.slug,at:new Date().toISOString()};
   try{const p=await loadThumbnailProduct(row.slug);
    if(!p||p.id!==row.id||p.ogImage)out={...out,status:p?.id===row.id&&p.ogImage?'preexisting':'skipped'};
    else{const result=await resolveThumbnail(p,{signal:controller.signal});if(controller.signal.aborted)break;
     const applied=args.includes('--apply')?await saveThumbnail(p,result):false;
     out={...out,status:args.includes('--apply')?(applied?'applied':'skipped'):'preview',kind:result.kind,sourceUrl:result.sourceUrl,width:result.width,height:result.height,errors:result.errors};}
   }catch{out={...out,status:'failed'};}
   appendFileSync(receipt,JSON.stringify(out)+'\n',{mode:0o600});count++;
   if(count%50===0)console.log(JSON.stringify({processed:count,remaining:queue.length,receipt:basename(receipt)}));
  }
 }));console.log(JSON.stringify({processed:count,remaining:queue.length,receipt}));process.exit(controller.signal.aborted?130:0);
}
main().catch(()=>{console.error('thumbnail backfill failed; check arguments/database');process.exit(1)});
