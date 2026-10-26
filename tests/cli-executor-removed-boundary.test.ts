import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect, it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { cliExecutorPlanHash } from "@/lib/llm/cli-executor-boundary-contract";
import { cliExecutorRemovedEvidenceShape } from "@/lib/llm/cli-executor-removed-boundary-contract";
import { cliExecutorFixture } from "./fixtures/cli-executor-boundary";
import { cliExecutorRemovedFixture } from "./fixtures/cli-executor-removed-boundary";

it("keeps V1 known exits and accepts a separately typed deleted executor with UNKNOWN exit code", () => {
  expect(modelDispatchReleaseEvidenceSchema.safeParse(cliExecutorFixture().evidence).success).toBe(true);
  const e = cliExecutorRemovedFixture().evidence;
  expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(true);
  expect(e.receipt.exits[1].exitCode).toBeNull();
});
it("SQL shape snapshot is generated from the exact strict V2 schema and leaves0134 immutable", () => {
  const template = readFileSync("scripts/ops/cli-executor-removed-boundary-sql.template.sql", "utf8");
  expect(readFileSync("drizzle/0135_cli_executor_removed_boundary_exit.sql", "utf8")).toBe(template.replace("__EVIDENCE_SHAPE__", JSON.stringify(z.toJSONSchema(cliExecutorRemovedEvidenceShape))));
  expect(createHash("sha256").update(readFileSync("drizzle/0134_cli_executor_boundary_exit.sql")).digest("hex")).toBe("10e81479e0db9fe62f4143dd071a922fb2d18c8c8e114e26decb62f1a174a4ae");
});
type Evidence = ReturnType<typeof cliExecutorRemovedFixture>["evidence"];
const negatives: [string, (e: Evidence) => void][] = [
  ["fabricated known exit", e => { Object.assign(e.receipt.exits[1], { exitCode: 0 }); }],
  ["missing durable task-delete", e => { Reflect.deleteProperty(e.receipt.exits[1], "engineTaskDelete"); }],
  ["foreign deleted CID", e => { if (e.receipt.exits[1].taskState === "removed") e.receipt.exits[1].engineTaskDelete.containerId = "0".repeat(64); }],
  ["foreign daemon", e => { if (e.receipt.exits[1].taskState === "removed") e.receipt.exits[1].engineTaskDelete.daemonId = "foreign"; }],
  ["bad original isolation", e => { if (e.receipt.exits[1].taskState === "removed") Object.assign(e.receipt.exits[1].originalBefore.topology, { privatePid: false }); }],
  ["unrelated before task", e => { if (e.receipt.exits[1].taskState === "removed") e.receipt.exits[1].originalBefore.identity = { ...e.receipt.exits[1].identity, taskId: "foreign" }; }],
  ["wrong durable timestamp", e => { if (e.receipt.exits[1].taskState === "removed") e.receipt.exits[1].engineTaskDelete.rawTimestamp = e.plan.createdAt; }],
  ["delete before stop", e => { if (e.receipt.exits[1].taskState === "removed") { const x=e.receipt.exits[1].engineTaskDelete; x.occurredAt=e.receipt.exits[1].originalBefore.observedAt; x.rawTimestamp=x.occurredAt; } }],
  ["historical zero reused", e => { e.receipt.removalBoundary.observations[0].observedAt = new Date(Date.parse(e.plan.createdAt)-1).toISOString(); }],
  ["duplicate observation", e => { e.receipt.removalBoundary.observations[1] = e.receipt.removalBoundary.observations[0]; }],
  ["foreign control", e => { e.receipt.removalBoundary.observations[0].control = { ...e.plan.control, revision: e.plan.control.revision+1 }; }],
  ["foreign writer", e => { e.receipt.removalBoundary.observations[0].writer = { ...e.plan.writer, writerEpoch: e.plan.writer.writerEpoch+1 }; }],
  ["reused direct inspect", e => { e.receipt.removalBoundary.observations[1].missing[0].task.artifactHash=e.receipt.removalBoundary.observations[0].missing[0].task.artifactHash; }],
  ["stale direct inspect", e => { e.receipt.removalBoundary.observations[1].missing[0].container.observedAt=e.plan.createdAt; }],
  ["partial missing inventory", e => { e.receipt.removalBoundary.observations[1].missing.pop(); }],
  ["stop after new plan", e => { e.receipt.removalBoundary.stopAttemptAt=e.receipt.observedAt; }],
  ["expired first zero", e => { e.receipt.removalBoundary.observations[0].observedAt=new Date(Date.parse(e.evaluatedAt)-301000).toISOString(); }],
  ["unknown extra proof", e => { Object.assign(e.receipt.removalBoundary, { guessedExitCode: 0 }); }],
];
for (const [name, mutate] of negatives) it(`rejects ${name}`, () => {
  const e = structuredClone(cliExecutorRemovedFixture().evidence); mutate(e); e.receipt.planHash=cliExecutorPlanHash(e.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(e).success).toBe(false);
});
