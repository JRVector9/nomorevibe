import { expect, it, vi } from "vitest";
import { parseLayaEvaluationInput, evaluateLayaSamples } from "@/lib/crawl/laya-evaluation";
import type { LayaPreview } from "@/lib/crawl/laya-preview";

const sample = (id: string, decision = "approve", firstMs: number | null = 10_000, secondMs: number | null = 8_000) => ({
  id, snapshot: { product: { repo: `acme/app-${id}`, accessMode: "installable", name: "Tool", description: "Compress images",
    readme: "npm install imagecli", pageText: "" }, repoFacts: { stars: 900 } },
  first: { decision, durationMs: firstMs }, secondDurationMs: secondMs,
});
const hint: LayaPreview = { kind: "hint", prefetch: true, softwareProbability: .95, routingModel: "english",
  authority: "none", questionVersion: "test", requestHash: "a".repeat(64), truncated: false, durationMs: 32 };

it("dry-run never calls the API and cannot claim an actual speedup", async () => {
  const request = vi.fn<typeof fetch>();
  const samples = parseLayaEvaluationInput({ version: 1, samples: [sample("1")] });
  const report = await evaluateLayaSamples(samples, { live: false, previewOptions: { request } });
  expect(request).not.toHaveBeenCalled();
  expect(report).toMatchObject({ mode: "dry_run", complete: true, productionEffect: "none", measuredSpeedup: null,
    summary: { samples: 1, eligible: 1, hintResponses: 0, suggestedPrefetch: 0 } });
  expect(report.rows[0].overlapUpperBoundMs).toBeNull();
});

it("separates agreement with a model from correctness and reports wasted candidates", async () => {
  const inputs = [sample("1"), sample("2", "reject"), sample("3", "needs_review"), sample("4", "approve", null, null)];
  const report = await evaluateLayaSamples(parseLayaEvaluationInput({ version: 1, samples: inputs }), {
    live: true, preview: async () => hint,
  });
  expect(report.summary).toMatchObject({ suggestedPrefetch: 4, firstApproved: 2, potentialWaste: 2, overlapTimedSamples: 1 });
  expect(report.rows.map(row => row.overlapUpperBoundMs)).toEqual([8000, null, null, null]);
  expect(report).toMatchObject({ measuredSpeedup: null, humanAccuracy: null, productionEffect: "none" });
  expect(JSON.stringify(report)).not.toContain("Compress images");
  expect(JSON.stringify(report)).not.toContain("npm install");
});

it("accounts for LAYA latency in the conditional overlap upper bound", async () => {
  const report = await evaluateLayaSamples(parseLayaEvaluationInput({ version: 1, samples: [sample("1", "approve", 20, 8000)] }), {
    live: true, preview: async () => hint,
  });
  expect(report.rows[0].overlapUpperBoundMs).toBe(0);
});

it("does not claim negative predictions or errors reject a candidate", async () => {
  const inputs = parseLayaEvaluationInput({ version: 1, samples: [sample("1"), sample("2")] });
  let calls = 0;
  const report = await evaluateLayaSamples(inputs, { live: true, preview: async () => ++calls === 1
    ? { ...hint, prefetch: false, softwareProbability: .1 }
    : { kind: "unavailable", reason: "timeout", authority: "none", questionVersion: "test", durationMs: 500 } });
  expect(report.summary).toMatchObject({ suggestedPrefetch: 0, normalPath: 2, unavailable: 1 });
  expect(report.rows.every(row => row.overlapUpperBoundMs === null)).toBe(true);
});

it("cancels between samples, marks partial results, and preserves sample order", async () => {
  const controller = new AbortController();
  const inputs = parseLayaEvaluationInput({ version: 1, samples: [sample("1"), sample("2")] });
  const report = await evaluateLayaSamples(inputs, { live: true, signal: controller.signal, preview: async () => {
    controller.abort(); return hint;
  } });
  expect(report.complete).toBe(false);
  expect(report.rows.map(row => row.id)).toEqual(["1"]);
});

it("rejects duplicate ids and duplicate snapshot samples to avoid inflated evidence", () => {
  expect(() => parseLayaEvaluationInput({ version: 1, samples: [sample("1"), sample("1")] })).toThrow("duplicate_sample");
  expect(() => parseLayaEvaluationInput({ version: 1, samples: [sample("1"), { ...sample("1"), id: "2" }] })).toThrow("duplicate_sample");
});

it.each([
  { version: 1, samples: [sample("1", "auto_approve")] },
  { version: 1, samples: [sample("1", "approve", -1)] },
  { version: 1, samples: Array.from({ length: 101 }, (_, i) => sample(String(i))) },
  { version: 2, samples: [sample("1")] },
])("rejects invalid or unbounded evaluation inputs", input => {
  expect(() => parseLayaEvaluationInput(input)).toThrow();
});

it("excludes website/low-star cases and preserves absent timing as unknown", async () => {
  const low = sample("1", "approve", null, null);
  low.snapshot.repoFacts.stars = 499;
  const inputs = parseLayaEvaluationInput({ version: 1, samples: [low] });
  const request = vi.fn<typeof fetch>();
  const report = await evaluateLayaSamples(inputs, { live: false, previewOptions: { request } });
  expect(report.summary).toMatchObject({ eligible: 0, overlapTimedSamples: 0 });
  expect(report.rows[0].overlapUpperBoundMs).toBeNull();
});
