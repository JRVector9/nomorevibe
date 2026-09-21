import { expect, it, vi } from "vitest";
import { emitPipelineEvent, measureReviewCall, summarizePipelineEvents } from "@/lib/observability/review-pipeline";

it("counts calls separately from reuse and reports clock anomalies without inventing latency", async () => {
  const events: Record<string, unknown>[] = [];
  const sink = (_: string, fields: Record<string, unknown>) => { events.push(fields); };
  const context = { stage: "first" as const, candidateId: 1, firstAttemptId: 2, provider: "abcllm", model: "fixture" };
  const outcome = { ok: true, outcome: { decision: "approve" } };
  expect(await measureReviewCall(context, async () => outcome, sink)).toBe(outcome);
  await measureReviewCall(context, async () => ({ ok: false, error: "timeout" }), sink);
  emitPipelineEvent("reused", context, sink);
  const report = summarizePipelineEvents([...events, { ...events[1], durationMs: -5 }]);
  expect(report.first).toMatchObject({ calls: 2, failed: 1, reused: 1, incomplete: 0 });
  expect(report.clockAnomalies).toBe(1);
  expect(report.first.modelMs.samples).toBe(2);
});
it("a broken log sink cannot fail or repeat a model call and cannot leak arbitrary fields", async () => {
  const call = vi.fn(async () => ({ ok: true }));
  await expect(measureReviewCall({ stage: "second" }, call, () => { throw Error("logging failed"); })).resolves.toEqual({ ok: true });
  expect(call).toHaveBeenCalledTimes(1);
  const sink = vi.fn();
  emitPipelineEvent("committed", { stage: "first", candidateId: 1, body: "private", apiKey: "secret" } as never, sink);
  expect(JSON.stringify(sink.mock.calls)).not.toMatch(/private|secret|apiKey|body/);
});
it("missing end events and negative cross-host wait are unknown, not zero", () => {
  const report = summarizePipelineEvents([
    { version: 1, kind: "model_start", stage: "second", callId: "lost", at: "2026-09-21T01:00:00Z" },
    { version: 1, kind: "queue", stage: "second", waitMs: -100 },
  ]);
  expect(report.second).toMatchObject({ calls: 0, incomplete: 1, modelMs: { samples: 0, p50: null, p95: null } });
  expect(report.clockAnomalies).toBe(1);
});
