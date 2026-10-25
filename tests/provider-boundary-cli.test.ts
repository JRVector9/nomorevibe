import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoundaryReleaseFiles } from "@/scripts/ops/model-provider-boundary-release";
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash } from "@/lib/llm/provider-boundary-contract";
import { boundaryFixture } from "./fixtures/provider-boundary-release";
import { launchdBoundaryFixture } from "./fixtures/provider-boundary-launchd";
import { historicalOwnerFixture } from "./fixtures/provider-boundary-historical-owner";

it("operator CLI defaults to rollback and pins reviewed plan bytes plus every actual artifact byte hash",()=>{
  const dir=mkdtempSync(join(tmpdir(),"boundary-cli-"));
  try {
    const {plan,receipt}=boundaryFixture(), sha=(v:string)=>createHash("sha256").update(v).digest("hex");
    const artifact=(v:string)=>{const h=sha(v);writeFileSync(join(dir,`${h}.json`),v,{mode:0o600});return h;};
    plan.beforeArtifactHash=artifact('{"fixture":"before"}');receipt.owner.artifactHash=artifact('{"fixture":"owner"}');
    receipt.gateways.forEach((g,i)=>g.artifactHash=artifact(JSON.stringify({fixture:`gateway${i}`})));
    receipt.provider.artifactHash=artifact('{"fixture":"provider"}');receipt.planHash=providerBoundaryPlanHash(plan);
    const bytes=JSON.stringify(plan,null,2);writeFileSync(join(dir,"plan.json"),bytes,{mode:0o600});writeFileSync(join(dir,"receipt.json"),JSON.stringify(receipt),{mode:0o600});
    const args=[`--plan=${join(dir,"plan.json")}`,`--plan-sha=${sha(bytes)}`,`--receipt=${join(dir,"receipt.json")}`,`--artifact-dir=${dir}`,"--operator=fixture","--reference=fixture observations","--database-url-stdin"];
    expect(readBoundaryReleaseFiles(args).apply).toBe(false);expect(readBoundaryReleaseFiles([...args,"--apply"]).apply).toBe(true);
    expect(()=>readBoundaryReleaseFiles([...args,"--client-bound=abcllm-supa"])).toThrow("provider_boundary_cli_option");
    expect(()=>readBoundaryReleaseFiles([...args,"--apply","--apply"])).toThrow("provider_boundary_cli_option");
    writeFileSync(join(dir,`${receipt.provider.artifactHash}.json`),"changed");
    expect(()=>readBoundaryReleaseFiles(args)).toThrow("provider_boundary_artifact_hash");
    writeFileSync(join(dir,"plan.json"),`${bytes}\n`);
    expect(()=>readBoundaryReleaseFiles(args)).toThrow("provider_boundary_plan_file_hash");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it("launchd CLI도 topology 원문 artifact를 실제 재해시하고 없거나 바뀌면 실행하지 않는다", () => {
  const dir=mkdtempSync(join(tmpdir(),"boundary-mac-cli-"));
  try {
    const {plan,receipt}=launchdBoundaryFixture(), sha=(v:string)=>createHash("sha256").update(v).digest("hex");
    const artifact=(v:string)=>{const h=sha(v);writeFileSync(join(dir,`${h}.json`),v,{mode:0o600});return h;};
    plan.beforeArtifactHash=artifact('{"fixture":"before"}');
    plan.provider.topologyProofSha256=artifact('{"fixture":"reviewed synthetic topology"}');
    receipt.owner.artifactHash=artifact('{"fixture":"owner"}');receipt.gateways.forEach((g,i)=>g.artifactHash=artifact(JSON.stringify({fixture:`gateway${i}`})));
    receipt.provider.artifactHash=artifact('{"fixture":"provider"}');receipt.planHash=providerBoundaryPlanHash(plan);
    const bytes=JSON.stringify(plan);writeFileSync(join(dir,"plan.json"),bytes);writeFileSync(join(dir,"receipt.json"),JSON.stringify(receipt));
    const args=[`--plan=${join(dir,"plan.json")}`,`--plan-sha=${sha(bytes)}`,`--receipt=${join(dir,"receipt.json")}`,`--artifact-dir=${dir}`,"--operator=fixture","--reference=synthetic observations","--database-url-stdin"];
    expect(readBoundaryReleaseFiles(args).apply).toBe(false);
    writeFileSync(join(dir,`${plan.provider.topologyProofSha256}.json`),"changed");
    expect(()=>readBoundaryReleaseFiles(args)).toThrow("provider_boundary_artifact_hash");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it("v2 CLI는 current ingress와 별도로 originalOwner 보조 artifact 원문을 요구한다",()=>{
  const dir=mkdtempSync(join(tmpdir(),"boundary-history-cli-"));
  try {
    const {plan,receipt}=historicalOwnerFixture(),sha=(v:string)=>createHash("sha256").update(v).digest("hex");
    const artifact=(v:string)=>{const h=sha(v);writeFileSync(join(dir,`${h}.json`),v,{mode:0o600});return h;};
    plan.beforeArtifactHash=artifact('{"fixture":"before"}');plan.originalOwner.artifactHash=artifact('{"fixture":"supplemental original-owner observations only"}');
    plan.provider.topologyProofSha256=artifact('{"fixture":"topology"}');receipt.currentIngressOwner.artifactHash=artifact('{"fixture":"current ingress"}');
    receipt.gateways.forEach((g,i)=>g.artifactHash=artifact(JSON.stringify({fixture:`gateway${i}`})));receipt.provider.artifactHash=artifact('{"fixture":"provider"}');
    receipt.originalOwnerProofHash=providerBoundaryCanonicalHash(plan.originalOwner);receipt.planHash=providerBoundaryPlanHash(plan);
    const bytes=JSON.stringify(plan);writeFileSync(join(dir,"plan.json"),bytes,{mode:0o600});writeFileSync(join(dir,"receipt.json"),JSON.stringify(receipt),{mode:0o600});
    const args=[`--plan=${join(dir,"plan.json")}`,`--plan-sha=${sha(bytes)}`,`--receipt=${join(dir,"receipt.json")}`,`--artifact-dir=${dir}`,"--operator=fixture","--reference=synthetic observations","--database-url-stdin"];
    expect(readBoundaryReleaseFiles(args).apply).toBe(false);
    writeFileSync(join(dir,`${plan.originalOwner.artifactHash}.json`),"changed");
    expect(()=>readBoundaryReleaseFiles(args)).toThrow("provider_boundary_artifact_hash");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('v3 CLI verifies native endpoint/journal/clock/source artifact bytes and never invents gateway artifacts',async()=>{
 const {bootBoundaryFixture}=await import('./fixtures/provider-boot-boundary');const dir=mkdtempSync(join(tmpdir(),'boundary-boot-cli-'));
 try{const {plan,receipt}=bootBoundaryFixture(),sha=(v:string)=>createHash('sha256').update(v).digest('hex');
 const artifact=(name:string)=>{const bytes=JSON.stringify({synthetic:true,name}),hash=sha(bytes);writeFileSync(join(dir,`${hash}.json`),bytes,{mode:0o600});return hash;};
 plan.beforeArtifactHash=artifact('before');plan.provider.endpointProofHash=artifact('nativeEndpoint');plan.provider.oldJournal.artifactHash=artifact('oldJournal');plan.provider.currentJournal.artifactHash=artifact('currentJournal');
 plan.bootWitness.artifactHash=artifact('planClock');plan.transport.sourceArtifactHash=artifact('actualRuntimeTransportSources');receipt.owner.artifactHash=artifact('ownerExit');receipt.provider.artifactHash=artifact('providerCurrentBoot');receipt.provider.bootWitness.artifactHash=artifact('receiptClock');receipt.planHash=providerBoundaryPlanHash(plan);
 const bytes=JSON.stringify(plan);writeFileSync(join(dir,'plan.json'),bytes);writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt));
 const args=[`--plan=${join(dir,'plan.json')}`,`--plan-sha=${sha(bytes)}`,`--receipt=${join(dir,'receipt.json')}`,`--artifact-dir=${dir}`,'--operator=fixture','--reference=synthetic reboot proof','--database-url-stdin'];
 expect(readBoundaryReleaseFiles(args).apply).toBe(false);
 for(const hash of [plan.provider.endpointProofHash,plan.provider.oldJournal.artifactHash,plan.provider.currentJournal.artifactHash,plan.bootWitness.artifactHash,receipt.provider.bootWitness.artifactHash,plan.transport.sourceArtifactHash]){
 const file=join(dir,`${hash}.json`),original=readFileSync(file);writeFileSync(file,'changed');expect(()=>readBoundaryReleaseFiles(args)).toThrow('provider_boundary_artifact_hash');writeFileSync(file,original);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('v4 CLI requires original-owner/current-ingress and all native boot artifact bytes', async () => {
  const { historicalBootBoundaryFixture } = await import('./fixtures/provider-boot-historical-owner');
  const dir = mkdtempSync(join(tmpdir(), 'boundary-boot-history-cli-'));
  try {
    const { plan, receipt } = historicalBootBoundaryFixture(), sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const artifact = (name: string) => { const bytes = JSON.stringify({ synthetic: true, name }), hash = sha(bytes); writeFileSync(join(dir, `${hash}.json`), bytes, { mode: 0o600 }); return hash; };
    plan.beforeArtifactHash = artifact('before'); plan.originalOwner.artifactHash = artifact('originalOwner');
    plan.provider.endpointProofHash = artifact('nativeEndpoint'); plan.provider.oldJournal.artifactHash = artifact('oldJournal'); plan.provider.currentJournal.artifactHash = artifact('currentJournal');
    plan.bootWitness.artifactHash = artifact('planClock'); plan.transport.sourceArtifactHash = artifact('actualRuntimeTransportSources');
    receipt.currentIngressOwner.artifactHash = artifact('currentIngressExit'); receipt.provider.artifactHash = artifact('providerCurrentBoot'); receipt.provider.bootWitness.artifactHash = artifact('receiptClock');
    receipt.originalOwnerProofHash = providerBoundaryCanonicalHash(plan.originalOwner); receipt.planHash = providerBoundaryPlanHash(plan);
    const bytes = JSON.stringify(plan); writeFileSync(join(dir, 'plan.json'), bytes); writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
    const args = [`--plan=${join(dir, 'plan.json')}`, `--plan-sha=${sha(bytes)}`, `--receipt=${join(dir, 'receipt.json')}`, `--artifact-dir=${dir}`, '--operator=fixture', '--reference=synthetic historical reboot proof', '--database-url-stdin'];
    expect(readBoundaryReleaseFiles(args).apply).toBe(false);
    for (const hash of [plan.beforeArtifactHash, plan.originalOwner.artifactHash, receipt.currentIngressOwner.artifactHash, receipt.provider.artifactHash,
      plan.provider.endpointProofHash, plan.provider.oldJournal.artifactHash, plan.provider.currentJournal.artifactHash, plan.bootWitness.artifactHash,
      receipt.provider.bootWitness.artifactHash, plan.transport.sourceArtifactHash]) {
      const file = join(dir, `${hash}.json`), original = readFileSync(file); writeFileSync(file, 'changed');
      expect(() => readBoundaryReleaseFiles(args)).toThrow('provider_boundary_artifact_hash'); writeFileSync(file, original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
