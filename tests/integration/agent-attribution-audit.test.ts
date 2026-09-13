import { beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { products,productLinks,productEvidenceSources } from '@/lib/db/schema';
import { saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { loadAttributionAuditPage,classifyAttributionAuditRow,accumulateAttributionAudit,createAttributionAuditSummary } from '@/lib/domain/evidence/agents/audit';
import type { AgentObservation } from '@/lib/domain/evidence/agents/types';
import { ensureSchema,resetTables,TEST_DATABASE_URL } from './setup';
const sha='a'.repeat(40);
beforeAll(()=>ensureSchema());beforeEach(()=>resetTables());
async function seed(){
 for(let i=0;i<5;i++){
  const slug=`audit-${i}`,repo=`acme/app${i}`;
  await db.insert(products).values({slug,url:`https://${slug}.example`,name:slug,tagline:'test',description:'test',category:'Dev',
   repoUrl:i===4?null:`https://GitHub.com/${repo}.git/`,source:'crawler',status:i===3?'banned':'seeded',
   builder:'Codex',claimedAt:i===1?new Date():null,verifyToken:'token',editTokenHash:'a'.repeat(64)});
  if(i===4)continue;
  await db.insert(productLinks).values({slug,kind:'repository',declarationSource:'maker',url:`https://github.com/${repo}`,normalizedKey:repo,visible:i!==2});
  await db.insert(productEvidenceSources).values({slug,kind:'repository',provider:'github',sourceKey:repo,state:'ok',lastSuccessAt:new Date(),normalizedFacts:{type:'github_repository',relationshipState:'site_link'}});
  const o:AgentObservation={kind:'commit_attribution',client:'codex',compatibleClients:[],modelDeveloper:null,declaredModelId:null,gateway:null,routing:'unknown',role:'coauthor',scope:'',keyPath:null,ruleId:'commit.coauthor.v2',sourcePath:null,commitSha:sha,blobSha:null,sourceUrl:`https://github.com/${repo}/commit/${sha}`,commitEvidence:{basis:'coauthor',headSha:sha,changedPaths:['src/app.ts'],changeKind:'development'}};
  await saveRepositoryAgentScan({repositoryId:String(100+i),repositoryKey:repo,repositoryFork:false,commitSha:sha,scope:'',state:'complete',cursor:null,observations:[o],requestCount:4,fileCount:0,errorCode:null,retryAt:null});
 }
}
describe('read-only attribution report',()=>{
 it('paginates every published product once, normalizes repository identity and excludes hidden links from qualifying',async()=>{
  await seed();const summary=createAttributionAuditSummary();const ids:number[]=[];let afterId=0;
  await db.transaction(async tx=>{
   while(true){const page=await loadAttributionAuditPage(tx,afterId,2);if(!page.length)break;
    for(const row of page){ids.push(row.id);accumulateAttributionAudit(summary,classifyAttributionAuditRow(row,new Date()));}
    afterId=page[page.length-1].id;
   }
  },{accessMode:'read only',isolationLevel:'repeatable read'});
  expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(4);
  expect(summary).toMatchObject({products:4,productsWithContributionClaims:2,scanStates:{current:3,unscanned:1},contributionTools:{codex:2},makerReportedTools:{Codex:1}});
 });
 it.each(['http://github.com/acme/app0','https://www.github.com/acme/app0','https://github.com/ACME/APP0.GIT',
  'https://github.com/%61cme/app0',' https://github.com/acme//app0/ '])('shares accepted repository normalization for %s',async repoUrl=>{
  await seed();await db.update(products).set({repoUrl}).where(eq(products.slug,'audit-0'));
  const rows=await loadAttributionAuditPage(db);const item=classifyAttributionAuditRow(rows.find(row=>row.slug==='audit-0')!,new Date());
  expect(item.repositoryKey).toBe('acme/app0');expect(item.claims[0].qualified).toBe(true);
 });
 it('writes a completed report with source URLs and refuses to overwrite it',async()=>{
  await seed();const directory=mkdtempSync(join(tmpdir(),'attribution-audit-')),output=join(directory,'report.jsonl');
  const args=['node_modules/tsx/dist/cli.mjs','scripts/audit-agent-attribution.ts','--output',output];
  try{
   execFileSync(process.execPath,args,{env:{...process.env,DATABASE_URL:TEST_DATABASE_URL},stdio:'pipe'});
   const original=readFileSync(output,'utf8'),rows=original.trim().split('\n').map(line=>JSON.parse(line));
   expect(rows.at(-1)).toEqual({type:'complete',complete:true});
   expect(rows.find(row=>row.type==='summary')).toMatchObject({products:4,productsWithContributionClaims:2});
   expect(rows.find(row=>row.type==='product'&&row.slug==='audit-0').claims[0].sourceUrl).toBe(`https://github.com/acme/app0/commit/${sha}`);
   expect(()=>execFileSync(process.execPath,args,{env:{...process.env,DATABASE_URL:TEST_DATABASE_URL},stdio:'pipe'})).toThrow();
   expect(readFileSync(output,'utf8')).toBe(original);
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
});
