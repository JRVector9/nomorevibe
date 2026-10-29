import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect, it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { replacedProviderEvidenceShape, replacedProviderPlanHash, replacedProviderDigest as sha } from "@/lib/llm/replaced-provider-boundary-contract";
import { replacedProviderFixture } from "./fixtures/replaced-provider-boundary";

it("accepts exact replacement boundaries while retaining indeterminate failure and unknown usage", () => {
  const { evidence } = replacedProviderFixture();
  expect(modelDispatchReleaseEvidenceSchema.parse(evidence).kind).toBe("replaced_provider_boundary_exit");
  expect(evidence.receipt.relay.state).toBe("indeterminate");
  expect(evidence.receipt.relay.error).toBe("upstream_timeout");
});
it("pins generated SQL to the strict contract", () => {
  expect(readFileSync("drizzle/0140_replaced_provider_boundary_exit.sql", "utf8")).toBe(readFileSync("scripts/ops/replaced-provider-boundary-sql.template.sql", "utf8")
    .replace("__EVIDENCE_SHAPE__", JSON.stringify(z.toJSONSchema(replacedProviderEvidenceShape))));
});
type E = ReturnType<typeof replacedProviderFixture>["evidence"];
const negatives: [string, (e: E) => void][] = [
  ["wire hash mismatch", e => { e.plan.request.wireHash = "0".repeat(64); }],
  ["relay hash mismatch", e => { e.receipt.relay.requestHash = "0".repeat(64); }],
  ["different relay messages even with recomputed hash", e => {
    const body = JSON.parse(e.receipt.relay.relayWire); body.messages[1].content = "other request";
    e.receipt.relay.relayWire = JSON.stringify(body); e.receipt.relay.requestHash = sha(e.receipt.relay.relayWire);
  }],
  ["extra original parameter", e => { const b = JSON.parse(e.receipt.relay.originalWire); b.tools = [];
    e.receipt.relay.originalWire = JSON.stringify(b); e.plan.request.wireHash = e.receipt.relay.originalWireArtifactHash = sha(e.receipt.relay.originalWire); }],
  ["wrong owner", e => { e.plan.originalOwner.bootId = "11111111-1111-4111-8111-111111111111"; }],
  ["unreplaced owner", e => { e.receipt.containers[0].startedAt = e.dispatchAt; }],
  ["unreplaced m3 gateway", e => { e.receipt.containers[1].startedAt = e.dispatchAt; }],
  ["unreplaced mini gateway", e => { e.receipt.containers[2].startedAt = e.dispatchAt; }],
  ["foreign gateway", e => { e.receipt.containers[2].serviceName = "other"; }],
  ["same relay generation", e => { e.receipt.relay.currentGeneration = e.receipt.relay.relayGeneration; }],
  ["relay started before old receipt ended", e => { e.receipt.relay.currentStartedAt = e.receipt.relay.startedAt; }],
  ["model not replaced", e => { e.receipt.relay.currentModel = e.receipt.relay.requestModel; }],
  ["stale receipt", e => { e.evaluatedAt = new Date(Date.parse(e.receipt.observedAt) + 300_001).toISOString(); }],
  ["multiple request ids", e => { Object.assign(e.plan, { requestIds: [e.requestId, e.requestId] }); }],
  ["usage fabrication", e => { Object.assign(e, { usageKnown: true }); }],
  ["success fabrication", e => { Object.assign(e, { businessResult: true }); }],
];
for (const [name, change] of negatives) it(`rejects ${name}`, () => {
  const { evidence } = replacedProviderFixture(); change(evidence); evidence.receipt.planHash = replacedProviderPlanHash(evidence.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
for (const key of Object.keys(replacedProviderFixture().receipt.relay)) it(`rejects missing relay evidence ${key}`, () => {
  const { evidence } = replacedProviderFixture(); delete (evidence.receipt.relay as Record<string, unknown>)[key];
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
for (const key of Object.keys(replacedProviderFixture().plan.originalOwner)) it(`rejects missing original owner ${key}`, () => {
  const { evidence } = replacedProviderFixture(); delete (evidence.plan.originalOwner as Record<string, unknown>)[key];
  evidence.receipt.planHash = replacedProviderPlanHash(evidence.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
for (const index of [0, 1, 2]) for (const key of Object.keys(replacedProviderFixture().receipt.containers[index])) it(`rejects missing container ${index}.${key}`, () => {
  const { evidence } = replacedProviderFixture(); delete (evidence.receipt.containers[index] as Record<string, unknown>)[key];
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
