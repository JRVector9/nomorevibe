import {expect,it,describe} from 'vitest';
import {AGENT_DETECTOR_VERSION,type AgentObservation} from '@/lib/domain/evidence/agents/types';
import {classifyAttributionAuditRow,createAttributionAuditSummary,accumulateAttributionAudit,type AttributionAuditRow} from '@/lib/domain/evidence/agents/audit';
const now=new Date('2026-09-14T00:00:00Z'),sha='a'.repeat(40);
const observation:AgentObservation={kind:'commit_attribution',client:'codex',compatibleClients:[],modelDeveloper:null,declaredModelId:null,gateway:null,routing:'unknown',role:'coauthor',scope:'',keyPath:null,ruleId:'commit.coauthor.v2',sourcePath:null,commitSha:sha,blobSha:null,sourceUrl:`https://github.com/acme/app/commit/${sha}`,commitEvidence:{basis:'coauthor',headSha:sha,changedPaths:['src/app.ts'],changeKind:'development'}};
const row:AttributionAuditRow={id:1,slug:'app',repository_key:'acme/app',maker_builder:'Codex',scan_id:1,scan_state:'complete',detector_version:AGENT_DETECTOR_VERSION,head_sha:sha,completed_ms:now.getTime(),scan_error:null,relationship_state:'site_link',source_state:'ok',source_success_ms:now.getTime(),observations:[observation]};
describe('inspectable contribution audit',()=>{
 it('deduplicates tool/project claims and keeps maker labels in a separate count',()=>{
  const item=classifyAttributionAuditRow({...row,observations:[observation,observation]},now);const summary=createAttributionAuditSummary();accumulateAttributionAudit(summary,item);
  expect(summary).toMatchObject({products:1,productsWithContributionClaims:1,contributionTools:{codex:1},makerReportedTools:{Codex:1}});
  expect(item.executionVerified).toBe(false);expect(item.claims[0].sourceUrl).toBe(observation.sourceUrl);
 });
 it.each([
  [{scan_id:null},'unscanned'],[{detector_version:'old'},'outdated_detector'],[{scan_error:'timeout'},'failed'],
  [{scan_state:'partial'},'incomplete'],[{completed_ms:now.getTime()-86400000},'stale'],[{completed_ms:now.getTime()+1},'stale'],
 ] as const)('never counts unavailable or incomplete scan results %j',(patch,state)=>{
  const item=classifyAttributionAuditRow({...row,...patch},now);expect(item.scanState).toBe(state);expect(item.claims.every(c=>!c.qualified)).toBe(true);
 });
 it.each([{source_state:'failed'},{source_success_ms:0},{relationship_state:'repository_link'},{relationship_state:null}])('requires fresh product-to-repository evidence %j',patch=>{
  expect(classifyAttributionAuditRow({...row,...patch},now).claims[0]).toMatchObject({qualified:false,reason:'relationship_unconfirmed'});
 });
 it('rejects legacy, committer-only, docs-only, wrong-head and wrong-source claims',()=>{
  for(const patch of [{commitEvidence:undefined},{role:'committer'},{commitEvidence:{...observation.commitEvidence!,changedPaths:['docs/demo.ts']}},{commitEvidence:{...observation.commitEvidence!,headSha:'b'.repeat(40)}}]){
    expect(classifyAttributionAuditRow({...row,observations:[{...observation,...patch}]},now).claims.every(c=>!c.qualified)).toBe(true);
  }
  const bad=classifyAttributionAuditRow({...row,observations:[{...observation,sourceUrl:`https://github.com/other/app/commit/${sha}`}]},now);
  expect(bad.claims).toEqual([]);expect(bad.ignoredObservationCount).toBe(1);
 });
 it('handles arbitrary maker labels without prototype keys affecting counters',()=>{
  const summary=createAttributionAuditSummary();accumulateAttributionAudit(summary,classifyAttributionAuditRow({...row,maker_builder:'__proto__'},now));
  expect(summary.makerReportedTools['__proto__']).toBe(1);expect(Object.getPrototypeOf(summary.makerReportedTools)).toBeNull();
 });
});
