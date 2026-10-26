import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect,it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { cliExecutorIndeterminateRemovedEvidenceShape } from "@/lib/llm/cli-executor-indeterminate-removed-boundary-contract";
import { cliExecutorIndeterminateRemovedFixture } from "./fixtures/cli-executor-indeterminate-removed-boundary";
it("accepts actual known die after a removed task without inventing a Swarm state",()=>{expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorIndeterminateRemovedFixture().evidence).success).toBe(true);});
it("permits a fresh plan after the sole historical stop, with two subsequent fresh zero observations",()=>{const e=cliExecutorIndeterminateRemovedFixture().evidence;e.plan.createdAt=new Date(Date.parse(e.receipt.closureBoundary.stopAttemptAt)+1000).toISOString();e.receipt.planHash=providerBoundaryCanonicalHash(e.plan);expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(true);});
it("pins generated0137 shape and leaves actual0136 migration bytes unchanged",()=>{
  expect(readFileSync("drizzle/0137_cli_executor_indeterminate_removed_boundary_exit.sql","utf8")).toBe(readFileSync("scripts/ops/cli-executor-indeterminate-removed-boundary-sql.template.sql","utf8").replace("__EVIDENCE_SHAPE__",JSON.stringify(z.toJSONSchema(cliExecutorIndeterminateRemovedEvidenceShape))));
  expect(createHash("sha256").update(readFileSync("drizzle/0136_cli_executor_indeterminate_boundary_exit.sql")).digest("hex")).toBe("ed81165ef2d7f9289e0fe61d570f002598f0ffdafc070648712fda40f258e90c");
});
type E=ReturnType<typeof cliExecutorIndeterminateRemovedFixture>["evidence"];
const negatives:[string,(e:E)=>void][]=[
 ["guessed task failure",e=>{Object.assign(e.receipt.exits[0],{taskState:"failed"});}],
 ["unknown exit",e=>{Object.assign(e.receipt.exits[0],{exitCode:null});}],
 ["foreign CID",e=>{e.receipt.exits[0].dockerDie.containerId="0".repeat(64);}],
 ["foreign task",e=>{e.receipt.exits[0].dockerDie.taskId="foreign";}],
 ["foreign daemon",e=>{e.receipt.exits[0].dockerDie.daemonId="foreign";}],
 ["wrong exit code",e=>{e.receipt.exits[0].dockerDie.exitCode=0;}],
 ["rounded nanoseconds",e=>{e.receipt.exits[0].dockerDie.timeNano=(BigInt(e.receipt.exits[0].dockerDie.timeNano)+BigInt(1000000)).toString();}],
 ["die before stop",e=>{e.receipt.exits[0].dockerDie.occurredAt=e.receipt.exits[0].originalBefore.observedAt;}],
 ["missing direct task",e=>{e.receipt.closureBoundary.observations[0].missing.pop();}],
 ["foreign direct task",e=>{e.receipt.closureBoundary.observations[0].missing[0].identity={...e.plan.candidates[0],taskId:"foreign"};}],
 ["reused direct capture",e=>{e.receipt.closureBoundary.observations[1].missing[0].task.artifactHash=e.receipt.closureBoundary.observations[0].missing[0].task.artifactHash;}],
 ["stale zero",e=>{e.receipt.closureBoundary.observations[0].observedAt=e.plan.request.dispatchAt;}],
 ["wrong zero control",e=>{e.receipt.closureBoundary.observations[0].control.revision++;}],
 ["wrong zero writer",e=>{e.receipt.closureBoundary.observations[0].writer.writerEpoch++;}],
 ["namespace escape",e=>{Object.assign(e.receipt.exits[0].originalBefore,{childCannotEscapeNamespace:false});}],
 ["usage fabrication",e=>{Object.assign(e,{usageKnown:true});}],
];
for(const [name,change] of negatives)it(`rejects ${name}`,()=>{const e=structuredClone(cliExecutorIndeterminateRemovedFixture().evidence);change(e);e.receipt.planHash=providerBoundaryCanonicalHash(e.plan);expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(false);});
