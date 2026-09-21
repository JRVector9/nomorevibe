import { createHash } from "node:crypto";
import { z } from "zod";
import { LAYA_QUESTION_VERSION, previewLaya, type LayaOptions, type LayaPreview, type LayaSubject } from "./laya-preview";

const timing = z.number().finite().nonnegative().max(3_600_000).nullable().default(null);
const sampleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  snapshot: z.object({
    product: z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
      accessMode: z.enum(["website", "installable"]), name: z.string().max(1000), description: z.string().max(12_000),
      readme: z.string().max(12_000), pageText: z.string().max(12_000),
    }),
    repoFacts: z.object({ stars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }),
  }),
  first: z.object({ decision: z.enum(["approve", "reject", "needs_review"]), durationMs: timing }),
  secondDurationMs: timing,
});
export type LayaSample = z.infer<typeof sampleSchema>;

/** Read-only projection; no original snapshot or LAYA text is passed to a real reviewer. */
function subjectOf(sample: LayaSample): LayaSubject {
  return { ...sample.snapshot.product, stars: sample.snapshot.repoFacts.stars ?? 0 };
}
function subjectHash(sample: LayaSample): string {
  return createHash("sha256").update(JSON.stringify(subjectOf(sample))).digest("hex");
}
export function parseLayaEvaluationInput(input: unknown): LayaSample[] {
  const { samples } = z.object({ version: z.literal(1), samples: z.array(sampleSchema).min(1).max(100) }).parse(input);
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const sample of samples) {
    const hash = subjectHash(sample);
    if (ids.has(sample.id) || hashes.has(hash)) throw new Error("duplicate_sample");
    ids.add(sample.id); hashes.add(hash);
  }
  return samples;
}

type Row = {
  id: string; subjectHash: string; firstDecision: LayaSample["first"]["decision"];
  hint: LayaPreview | null; overlapUpperBoundMs: number | null;
};
type EvaluationOptions = {
  live: boolean; signal?: AbortSignal; previewOptions?: LayaOptions;
  preview?: typeof previewLaya;
};
const quantile = (values: number[], q: number) => values.length
  ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1] : null;

/** Evaluation only. No candidate, review, queue or publication writes. */
export async function evaluateLayaSamples(samples: LayaSample[], options: EvaluationOptions) {
  const start = performance.now();
  const rows: Row[] = [];
  let eligible = 0;
  for (const sample of samples) {
    if (options.signal?.aborted || performance.now() - start >= 55_000) break;
    const subject = subjectOf(sample);
    if (subject.accessMode === "installable" && subject.stars >= 500) eligible++;
    const hint = options.live ? await (options.preview ?? previewLaya)(subject, {
      ...options.previewOptions, signal: options.signal ?? options.previewOptions?.signal,
      timeoutMs: Math.min(options.previewOptions?.timeoutMs ?? 500, 55_000 - (performance.now() - start)),
    }) : null;
    const overlapUpperBoundMs = hint?.kind === "hint" && hint.prefetch && sample.first.decision === "approve"
      && sample.first.durationMs !== null && sample.secondDurationMs !== null
      ? Math.min(Math.max(sample.first.durationMs - hint.durationMs, 0), sample.secondDurationMs) : null;
    rows.push({ id: sample.id, subjectHash: subjectHash(sample), firstDecision: sample.first.decision, hint, overlapUpperBoundMs });
  }
  const suggestions = rows.filter(row => row.hint?.kind === "hint" && row.hint.prefetch);
  const latencies = rows.flatMap(row => row.hint && row.hint.kind !== "skipped" ? [row.hint.durationMs] : []);
  const overlap = rows.flatMap(row => row.overlapUpperBoundMs === null ? [] : [row.overlapUpperBoundMs]);
  return {
    version: 1, questionVersion: LAYA_QUESTION_VERSION, generatedAt: new Date().toISOString(),
    mode: options.live ? "live" : "dry_run", complete: rows.length === samples.length,
    productionEffect: "none", measuredSpeedup: null, humanAccuracy: null,
    interpretation: "Agreement with prior model decisions is not human accuracy. Overlap is an ideal spare-slot upper bound, excluding queue/preparation/DB/contention; not an observed speedup. No production decisions or work were changed.",
    summary: {
      samples: samples.length, processed: rows.length, eligible,
      hintResponses: rows.filter(row => row.hint?.kind === "hint").length,
      unavailable: rows.filter(row => row.hint?.kind === "unavailable").length,
      skipped: rows.filter(row => row.hint?.kind === "skipped").length,
      suggestedPrefetch: suggestions.length,
      firstApproved: suggestions.filter(row => row.firstDecision === "approve").length,
      potentialWaste: suggestions.filter(row => row.firstDecision !== "approve").length,
      normalPath: rows.length - suggestions.length,
      apiP50Ms: quantile(latencies, .5), apiP95Ms: quantile(latencies, .95),
      overlapTimedSamples: overlap.length, overlapUpperBoundP50Ms: quantile(overlap, .5),
    }, rows,
  };
}
