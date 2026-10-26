import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect,it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { cliExecutorIndeterminateEvidenceShape } from "@/lib/llm/cli-executor-indeterminate-boundary-contract";
import { providerBoundaryCanonicalHash } from "@/lib/llm/provider-boundary-contract";
import { cliExecutorFixture } from "./fixtures/cli-executor-boundary";
import { cliExecutorRemovedFixture } from "./fixtures/cli-executor-removed-boundary";
import { cliExecutorIndeterminateFixture } from "./fixtures/cli-executor-indeterminate-boundary";

it("accepts a separately typed indeterminate request with known executor exits and leaves V1/V2 unchanged",()=>{
  expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorFixture().evidence).success).toBe(true);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorRemovedFixture().evidence).success).toBe(true);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorIndeterminateFixture().evidence).success).toBe(true);
});
it("generated0136 shape is exact and both earlier migration bytes remain immutable",()=>{
  expect(readFileSync("drizzle/0136_cli_executor_indeterminate_boundary_exit.sql","utf8")).toBe(readFileSync("scripts/ops/cli-executor-indeterminate-boundary-sql.template.sql","utf8").replace("__EVIDENCE_SHAPE__",JSON.stringify(z.toJSONSchema(cliExecutorIndeterminateEvidenceShape))));
  for(const [file,hash] of [["0134_cli_executor_boundary_exit.sql","10e81479e0db9fe62f4143dd071a922fb2d18c8c8e114e26decb62f1a174a4ae"],["0135_cli_executor_removed_boundary_exit.sql","ec14294629630cb22292d07ff1d6473d328e21dc861daa4c0d0f039d0d9dd731"]])expect(createHash("sha256").update(readFileSync("drizzle/"+file)).digest("hex")).toBe(hash);
});
type Evidence=ReturnType<typeof cliExecutorIndeterminateFixture>["evidence"];
const negatives:[string,(e:Evidence)=>void][]=[
  ["dispatched evidence",e=>{Object.assign(e,{fromState:"dispatched"});}],
  ["dispatched plan",e=>{Object.assign(e.plan.request,{state:"dispatched"});}],
  ["removed unknown exit",e=>{Object.assign(e.receipt.exits[0],{exitCode:null,taskState:"removed"});}],
  ["live init",e=>{Object.assign(e.receipt.exits[0].initClosure,{pid:22});}],
  ["no child namespace fence",e=>{Object.assign(e.receipt.exits[0].originalBefore,{childCannotEscapeNamespace:false});}],
  ["foreign before source",e=>{e.receipt.exits[0].originalBefore.executor={...e.plan.executor,sourceSha:"0".repeat(40)};}],
  ["foreign candidate",e=>{e.receipt.exits[0].identity={...e.receipt.exits[0].identity,taskId:"foreign"};}],
  ["missing candidate",e=>{e.receipt.exits.pop();}],
  ["duplicate zero",e=>{e.receipt.closureBoundary.observations[1]=e.receipt.closureBoundary.observations[0];}],
  ["stale first zero",e=>{e.receipt.closureBoundary.observations[0].observedAt=new Date(Date.parse(e.evaluatedAt)-301000).toISOString();}],
  ["historical zero",e=>{e.receipt.closureBoundary.observations[0].observedAt=new Date(Date.parse(e.plan.createdAt)-1).toISOString();}],
  ["foreign zero control",e=>{e.receipt.closureBoundary.observations[0].control={...e.plan.control,revision:e.plan.control.revision+1};}],
  ["foreign zero writer",e=>{e.receipt.closureBoundary.observations[0].writer={...e.plan.writer,writerEpoch:e.plan.writer.writerEpoch+1};}],
  ["new executor after stop",e=>{Object.assign(e.receipt.closureBoundary.observations[1].wholeService,{replacements:1});}],
  ["zero exit differs",e=>{e.receipt.closureBoundary.observations[0].exits[0].exitCode=1;}],
  ["refund",e=>{e.plan.request.chargedTokens--;}],
  ["usage fabricated",e=>{Object.assign(e,{usageKnown:true});}],
];
for(const [name,mutate] of negatives)it(`rejects ${name}`,()=>{const e=structuredClone(cliExecutorIndeterminateFixture().evidence);mutate(e);e.receipt.planHash=providerBoundaryCanonicalHash(e.plan);expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(false);});
