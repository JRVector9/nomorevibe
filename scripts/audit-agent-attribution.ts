import { open } from 'node:fs/promises';
import { db } from '../lib/db';
import { AGENT_DETECTOR_VERSION } from '../lib/domain/evidence/agents/types';
import { accumulateAttributionAudit,classifyAttributionAuditRow,createAttributionAuditSummary,loadAttributionAuditPage } from '../lib/domain/evidence/agents/audit';

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--output'||!args[1])throw new Error('usage: audit-agent-attribution --output NEW_FILE.jsonl');
  const file=await open(args[1],'wx');const now=new Date();
  const write=async(value:unknown)=>{await file.writeFile(JSON.stringify(value)+'\n');};
  try{
    await write({type:'header',generatedAt:now.toISOString(),detectorVersion:AGENT_DETECTOR_VERSION,
      interpretation:'Contribution claims and maker reports; not verified AI execution',complete:false});
    // Read-only repeatable read keeps keyset pages consistent while ingestion continues.
    await db.transaction(async tx=>{
      let afterId=0;const summary=createAttributionAuditSummary();
      while(true){const rows=await loadAttributionAuditPage(tx,afterId);if(!rows.length)break;
        for(const row of rows){const item=classifyAttributionAuditRow(row,now);accumulateAttributionAudit(summary,item);await write({type:'product',...item});}
        afterId=rows[rows.length-1].id;
      }
      await write({type:'summary',...summary});
    },{isolationLevel:'repeatable read',accessMode:'read only'});
    await write({type:'complete',complete:true});
  }finally{await file.close();}
}
main().then(()=>process.exit(0)).catch(()=>{console.error('Attribution audit failed. Check the output path and DB access; a report without its completion marker is incomplete.');process.exit(1)});
