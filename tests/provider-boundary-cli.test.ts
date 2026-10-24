import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoundaryReleaseFiles } from "@/scripts/ops/model-provider-boundary-release";
import { providerBoundaryPlanHash } from "@/lib/llm/provider-boundary-contract";
import { boundaryFixture } from "./fixtures/provider-boundary-release";

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
