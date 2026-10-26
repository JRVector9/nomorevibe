import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readIndeterminateRemovedBoundaryReleaseFiles } from "@/scripts/ops/model-cli-executor-indeterminate-removed-boundary-release";
import { cliExecutorIndeterminateRemovedArtifactHashes } from "@/lib/llm/cli-executor-indeterminate-removed-boundary-contract";
import { cliExecutorIndeterminateRemovedFixture, materializeIndeterminateRemovedArtifacts } from "./fixtures/cli-executor-indeterminate-removed-boundary";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function files() {
  const dir=mkdtempSync(join(tmpdir(), "cli-executor-removed-files-")); dirs.push(dir); chmodSync(dir,0o700);
  const fx=cliExecutorIndeterminateRemovedFixture(); materializeIndeterminateRemovedArtifacts(fx,(hash,bytes)=>writeFileSync(join(dir,`${hash}.json`),bytes,{mode:0o600}));
  const p=JSON.stringify(fx.plan),r=JSON.stringify(fx.receipt),hash=(s:string)=>createHash("sha256").update(s).digest("hex");
  writeFileSync(join(dir,"plan.json"),p,{mode:0o600});writeFileSync(join(dir,"receipt.json"),r,{mode:0o600});
  return {dir,fx,args:[`--plan=${join(dir,"plan.json")}`,`--plan-sha=${hash(p)}`,`--receipt=${join(dir,"receipt.json")}`,`--receipt-sha=${hash(r)}`,
    `--artifact-dir=${dir}`,"--operator=fixture-operator",`--reference=${fx.plan.reviewReference}`,"--database-url-stdin"]};
}
it("requires all original/deletion/stop/two fresh capture hashes before DB and defaults to dry-run", () => {
  const {fx,args}=files();expect(readIndeterminateRemovedBoundaryReleaseFiles(args).apply).toBe(false);
  expect(readIndeterminateRemovedBoundaryReleaseFiles([...args,"--apply"]).apply).toBe(true);
  expect(cliExecutorIndeterminateRemovedArtifactHashes(fx.plan,fx.receipt)).toContain(fx.receipt.closureBoundary.observations[0].captureArtifactHash);
});
it("refuses any missing/altered/public new proof artifact and duplicate/apply retry option", () => {
  const first=files();
  for (const hash of cliExecutorIndeterminateRemovedArtifactHashes(first.fx.plan,first.fx.receipt)) {
    const next=files(),file=join(next.dir,`${hash}.json`);writeFileSync(file,"{}",{mode:0o600});
    expect(()=>readIndeterminateRemovedBoundaryReleaseFiles(next.args)).toThrow();
  }
  const next=files(),file=join(next.dir,`${next.fx.receipt.closureBoundary.stopAttemptArtifactHash}.json`);
  chmodSync(file,0o644);expect(()=>readIndeterminateRemovedBoundaryReleaseFiles(next.args)).toThrow("private_file_required");
  for(const bad of [next.args.slice(1),[...next.args,next.args[0]],[...next.args,"--retry"],[...next.args,"--apply","--apply"]])
    expect(()=>readIndeterminateRemovedBoundaryReleaseFiles(bad)).toThrow();
});
