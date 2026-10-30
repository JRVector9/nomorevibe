import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect, it } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { REPLACED_PATH_OWNERS, REPLACED_PATH_PROVIDERS, REPLACED_PATH_PROVIDERS_0145, replacedPathEvidenceShape, replacedPathPlanHash,
  replacedPathRequiredHops } from "@/lib/llm/replaced-path-boundary-contract";
import { replacedPathFixture } from "./fixtures/replaced-path-boundary";

it("accepts a path whose every process started after the dispatch", () => {
  for (const [budget, owner] of [["abcllm-m1-qwen", "m3-text"], ["abcllm-supa", "m3-reviewer"], ["abcllm-m3-mlx", "m3-reviewer"], ["supa-direct", "m3-text"]]) {
    const { evidence } = replacedPathFixture(budget, owner);
    expect(modelDispatchReleaseEvidenceSchema.parse(evidence).kind).toBe("replaced_path_boundary_exit");
  }
});
it("requires the owner, both gateways and every provider process of the budget", () => {
  expect(replacedPathRequiredHops("m3-reviewer", "abcllm-supa")?.map(h => `${h.role}:${h.host}:${h.service}`)).toEqual([
    "owner:m3ultra:app-copy-primary-hard-drive-b5fhzd", "gateway-m3:m3ultra:app-reboot-optical-matrix-3bl2a4",
    "gateway-mini:9mini:app-hack-optical-monitor-v1ioak", "provider:supa:vllm.service"]);
  expect(replacedPathRequiredHops("m3-text", "abcllm-m1-qwen")?.map(h => h.role)).toEqual(["owner", "gateway-m3", "gateway-mini", "relay", "provider"]);
  // 'supa-direct' (capacity rev12 alias, 2026-10-30) is the same Supa path; 0145 did not know it.
  expect(replacedPathRequiredHops("m3-reviewer", "supa-direct")).toEqual(replacedPathRequiredHops("m3-reviewer", "abcllm-supa"));
  expect(Object.keys(REPLACED_PATH_PROVIDERS_0145)).toEqual(["abcllm-supa", "abcllm-m3-mlx", "abcllm-m1-qwen"]);
  expect(replacedPathRequiredHops("m3-reviewer", "gpu3090-qwen")).toBeNull();
  expect(replacedPathRequiredHops("mini-reviewer-standby", "abcllm-supa")).toBeNull();
  expect(replacedPathRequiredHops("toString", "abcllm-supa")).toBeNull();
});
it("pins 0146 to the same shape and keeps it to the evidence validator only", () => {
  const sql = readFileSync("drizzle/0146_replaced_path_absent_after_dispatch.sql", "utf8");
  expect(sql).toBe(readFileSync("scripts/ops/replaced-path-boundary-0146.template.sql", "utf8")
    .replace("__EVIDENCE_SHAPE__", JSON.stringify(z.toJSONSchema(replacedPathEvidenceShape))));
  expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/g)).toEqual(["CREATE OR REPLACE FUNCTION"]);
  expect(sql).not.toMatch(/ALTER TABLE|CREATE TRIGGER|DROP /);
  expect(sql).toContain("(h->>'observedAt')::timestamptz<=(q->>'dispatchAt')::timestamptz");
});
it("pins generated SQL to the strict contract and topology", () => {
  expect(readFileSync("drizzle/0145_replaced_path_boundary_exit.sql", "utf8")).toBe(readFileSync("scripts/ops/replaced-path-boundary-sql.template.sql", "utf8")
    .replace("__EVIDENCE_SHAPE__", JSON.stringify(z.toJSONSchema(replacedPathEvidenceShape)))
    .replace("__OWNERS__", JSON.stringify(REPLACED_PATH_OWNERS)).replace("__PROVIDERS__", JSON.stringify(REPLACED_PATH_PROVIDERS_0145)));
});
it("pins 0150 to the current topology and keeps it to the topology function only", () => {
  const sql = readFileSync("drizzle/0150_replaced_path_supa_direct.sql", "utf8");
  expect(sql).toBe(readFileSync("scripts/ops/replaced-path-boundary-0150.template.sql", "utf8")
    .replace("__OWNERS__", JSON.stringify(REPLACED_PATH_OWNERS)).replace("__PROVIDERS__", JSON.stringify(REPLACED_PATH_PROVIDERS)));
  expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/g)).toEqual(["CREATE OR REPLACE FUNCTION"]);
  expect(sql).not.toMatch(/ALTER TABLE|CREATE TRIGGER|DROP /);
  expect(sql).toContain('"supa-direct":');
});
type E = ReturnType<typeof replacedPathFixture>["evidence"];
const negatives: [string, (e: E) => void][] = [
  ["owner not replaced", e => { e.receipt.hops[0].startedAt = e.dispatchAt; }],
  ["m3 gateway not replaced", e => { e.receipt.hops[1].startedAt = e.dispatchAt; }],
  ["mini gateway not replaced", e => { e.receipt.hops[2].startedAt = new Date(Date.parse(e.dispatchAt) - 1).toISOString(); }],
  ["relay not replaced", e => { e.receipt.hops[3].startedAt = e.dispatchAt; }],
  ["engine not replaced", e => { e.receipt.hops[4].startedAt = e.dispatchAt; }],
  ["missing hop", e => { e.receipt.hops.pop(); }],
  ["extra hop", e => { e.receipt.hops.push({ ...e.receipt.hops[4], incarnationId: "other" }); }],
  ["reordered hops", e => { e.receipt.hops.reverse(); }],
  ["foreign service", e => { e.receipt.hops[1].service = "other-gateway"; }],
  ["foreign host", e => { e.receipt.hops[4].host = "m3ultra"; }],
  ["different hop kind", e => { e.receipt.hops[4].kind = "launchd"; }],
  ["duplicate incarnation", e => { e.receipt.hops[2].incarnationId = e.receipt.hops[1].incarnationId; e.receipt.hops[2].host = e.receipt.hops[1].host; }],
  ["hop observed after the receipt", e => { e.receipt.hops[0].observedAt = new Date(Date.parse(e.receipt.observedAt) + 1).toISOString(); }],
  ["hop started after its observation", e => { e.receipt.hops[0].startedAt = new Date(Date.parse(e.receipt.hops[0].observedAt) + 1).toISOString(); }],
  ["unregistered budget", e => { e.plan.request.providerBudgetId = "abcllm-unknown"; }],
  ["unregistered owner", e => { e.plan.request.owner.instanceId = "mini-text-standby"; e.owner.instanceId = "mini-text-standby"; }],
  ["owner mismatch", e => { e.owner = { ...e.owner, bootId: "11111111-1111-4111-8111-111111111111" }; }],
  ["plan older than an hour", e => { e.evaluatedAt = new Date(Date.parse(e.plan.createdAt) + 3_600_001).toISOString(); }],
  ["receipt older than a day", e => { e.evaluatedAt = new Date(Date.parse(e.receipt.observedAt) + 86_400_001).toISOString(); }],
  ["receipt after evaluation", e => { e.receipt.observedAt = e.notBefore = new Date(Date.parse(e.evaluatedAt) + 1).toISOString(); }],
  ["control updated after plan", e => { e.plan.control.updatedAt = new Date(Date.parse(e.plan.createdAt) + 1).toISOString().replace("Z", "000Z"); }],
  ["not draining", e => { (e.plan.control as { mode: string }).mode = "open"; }],
  ["usage fabrication", e => { Object.assign(e, { usageKnown: true }); }],
  ["success fabrication", e => { Object.assign(e, { businessResult: true }); }],
  ["single instance not proven", e => { (e.receipt.hops[0] as { singleInstance: boolean }).singleInstance = false; }],
];
for (const [name, change] of negatives) it(`rejects ${name}`, () => {
  const { evidence } = replacedPathFixture(); change(evidence); evidence.receipt.planHash = replacedPathPlanHash(evidence.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
it("accepts an idle engine after its upstream was replaced, and an absent relay", () => {
  const { evidence } = replacedPathFixture(), hops = evidence.receipt.hops;
  Object.assign(hops[3], { mode: "absent", incarnationId: "absent", startedAt: null });
  Object.assign(hops[4], { mode: "idle", startedAt: new Date(Date.parse(evidence.dispatchAt) - 60_000).toISOString() });
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(true);
});
const modeNegatives: [string, (e: E) => void][] = [
  ["an idle engine observed before an upstream replacement", e => { const h = e.receipt.hops;
    Object.assign(h[4], { mode: "idle", startedAt: e.dispatchAt, observedAt: h[2].startedAt }); }],
  ["an idle engine observed at the same moment as an absent relay", e => { const h = e.receipt.hops;
    Object.assign(h[3], { mode: "absent", incarnationId: "absent", startedAt: null });
    Object.assign(h[4], { mode: "idle", startedAt: e.dispatchAt, observedAt: h[3].observedAt }); }],
  ["an idle owner", e => { Object.assign(e.receipt.hops[0], { mode: "idle" }); }],
  ["an idle gateway", e => { Object.assign(e.receipt.hops[1], { mode: "idle" }); }],
  ["an absent owner", e => { Object.assign(e.receipt.hops[0], { mode: "absent", incarnationId: "absent", startedAt: null }); }],
  ["an absence observed before the dispatch", e => { Object.assign(e.receipt.hops[3], { mode: "absent", incarnationId: "absent", startedAt: null,
    observedAt: new Date(Date.parse(e.dispatchAt) - 1).toISOString() }); }],
  ["an absence observed at the dispatch", e => { Object.assign(e.receipt.hops[3], { mode: "absent", incarnationId: "absent", startedAt: null,
    observedAt: e.dispatchAt }); }],
  ["an absent engine", e => { Object.assign(e.receipt.hops[4], { mode: "absent", incarnationId: "absent", startedAt: null }); }],
  ["an absent hop with a start", e => { Object.assign(e.receipt.hops[3], { mode: "absent", incarnationId: "absent" }); }],
  ["an absent hop with an incarnation", e => { Object.assign(e.receipt.hops[3], { mode: "absent", startedAt: null }); }],
  ["a replaced hop without a start", e => { Object.assign(e.receipt.hops[1], { startedAt: null }); }],
  ["an engine called replaced but started before dispatch", e => { Object.assign(e.receipt.hops[4], { startedAt: e.dispatchAt }); }],
];
for (const [name, change] of modeNegatives) it(`rejects ${name}`, () => {
  const { evidence } = replacedPathFixture(); change(evidence); evidence.receipt.planHash = replacedPathPlanHash(evidence.plan);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
it("accepts a replacement read back before the plan", () => {
  const { evidence } = replacedPathFixture();
  for (const hop of evidence.receipt.hops) hop.observedAt = new Date(Date.parse(evidence.plan.createdAt) - 600_000).toISOString();
  evidence.receipt.observedAt = evidence.notBefore = evidence.receipt.hops[0].observedAt;
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(true);
});
it("rejects a receipt bound to another plan", () => {
  const { evidence } = replacedPathFixture(); evidence.receipt.planHash = "0".repeat(64);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
for (const key of Object.keys(replacedPathFixture().receipt.hops[0])) it(`rejects missing hop ${key}`, () => {
  const { evidence } = replacedPathFixture(); delete (evidence.receipt.hops[0] as Record<string, unknown>)[key];
  expect(modelDispatchReleaseEvidenceSchema.safeParse(evidence).success).toBe(false);
});
