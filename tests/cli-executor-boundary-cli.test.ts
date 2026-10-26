import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBoundaryReleaseFiles } from "@/scripts/ops/model-cli-executor-boundary-release";
import { cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";
import { cliExecutorFixture } from "./fixtures/cli-executor-boundary";
const dirs: string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function files(){
  const dir=mkdtempSync(join(tmpdir(),"cli-executor-files-"));dirs.push(dir);chmodSync(dir,0o700);
  const {plan,receipt}=cliExecutorFixture();
  const hashes: string[]=[];
  for(const layer of [plan.artifactHashes,receipt.artifactHashes])for(const k of Object.keys(layer)){
    const bytes=Buffer.from(JSON.stringify({fixture:true,ordinal:hashes.length})),hash=createHash("sha256").update(bytes).digest("hex");
    Object.assign(layer,{[k]:hash});writeFileSync(join(dir,`${hash}.json`),bytes,{mode:0o600});hashes.push(hash);
  }
  receipt.planHash=cliExecutorPlanHash(plan);
  const p=JSON.stringify(plan),r=JSON.stringify(receipt),hash=(s:string)=>createHash("sha256").update(s).digest("hex");
  writeFileSync(join(dir,"plan.json"),p,{mode:0o600});writeFileSync(join(dir,"receipt.json"),r,{mode:0o600});
  const args=[`--plan=${join(dir,"plan.json")}`,`--plan-sha=${hash(p)}`,`--receipt=${join(dir,"receipt.json")}`,`--receipt-sha=${hash(r)}`,
    `--artifact-dir=${dir}`,"--operator=fixture-operator",`--reference=${plan.reviewReference}`,"--database-url-stdin"];
  return {dir,args,hashes};
}
it("defaults to rollback and checks every private reviewed byte before opening any DB",()=>{
  const {args}=files();expect(readBoundaryReleaseFiles(args).apply).toBe(false);expect(readBoundaryReleaseFiles([...args,"--apply"]).apply).toBe(true);
});
it("rejects missing/duplicate/unknown options and altered plan/receipt/artifact bytes",()=>{
  const {args}=files();
  for(const bad of [args.slice(1),[...args,args[0]],[...args,"--retry"],[...args,"--apply","--apply"]])expect(()=>readBoundaryReleaseFiles(bad)).toThrow();
  for(const key of ["plan", "receipt", "artifact"]){
    const fresh=files(), name=key==="artifact"?`${fresh.hashes[0]}.json`:`${key}.json`;
    writeFileSync(join(fresh.dir,name),"{}",{mode:0o600});expect(()=>readBoundaryReleaseFiles(fresh.args)).toThrow();
  }
});
it("rejects public or absent artifact files",()=>{
  const {args,dir,hashes}=files();chmodSync(join(dir,`${hashes[0]}.json`),0o644);expect(()=>readBoundaryReleaseFiles(args)).toThrow("private_file_required");
  rmSync(join(dir,`${hashes[0]}.json`));expect(()=>readBoundaryReleaseFiles(args)).toThrow();
});
