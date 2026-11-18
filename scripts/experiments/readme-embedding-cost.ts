import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_DIMENSIONS } from "../../lib/domain/products/embedding";

type Timing = { kind: string; bucket?: string; count: number; ms: number };
type Plan = { products: number; readmeNonblank: number; cleanedReadme: number; variantRows: Record<string, number> };
type Storage = { relname: string; heap_bytes: number; total_bytes: number };
const halfvecPayloadBytes = 2 * EMBEDDING_DIMENSIONS;
const batchGapMs = 300;

function read<T>(scratch: string, filename: string): T {
  return JSON.parse(readFileSync(join(scratch, filename), "utf8")) as T;
}

export function readExperimentCost(scratch: string) {
  const plan = read<Plan>(scratch, "embedding-plan.json");
  const storage = read<Storage[]>(scratch, "embedding-storage.json");
  const timings = readFileSync(join(scratch, "model-timings.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Timing);
  const probes = timings.filter(({ kind }) => kind === "probe");
  const slowProbes = probes.filter(({ ms }) => ms > 300).length;

  const measured = (bucket: string) => {
    const calls = timings.filter((row) => row.kind === "product" && row.bucket === bucket);
    const ms = calls.map((row) => row.ms).sort((a, b) => a - b);
    const requestMs = ms.reduce((sum, value) => sum + value, 0);
    const embedded = calls.reduce((sum, row) => sum + row.count, 0);
    return {
      bucket, embedded, batches: ms.length, requestMs,
      p50Ms: ms[Math.floor(ms.length / 2)] ?? null,
      p95Ms: ms[Math.floor(ms.length * 0.95)] ?? null,
      msPerDocumentAtLimit: embedded ? (requestMs + ms.length * batchGapMs) / embedded : null,
    };
  };

  const observations = Object.keys(plan.variantRows).map(measured);
  const baseline = observations.find(({ bucket }) => bucket === "v0")?.msPerDocumentAtLimit;
  if (!baseline) throw new Error("V0 batch timings are required for rebuild estimates");
  const variants = observations.map((row) => {
    const { bucket, msPerDocumentAtLimit } = row;
    const changedDocuments = { v0: plan.products, v1: plan.cleanedReadme, v1raw: plan.readmeNonblank, v2: plan.cleanedReadme }[bucket];
    if (changedDocuments === undefined || !msPerDocumentAtLimit) throw new Error(`Missing cost inputs for ${bucket}`);
    const baselineDocuments = bucket === "v0" ? 0 : bucket === "v2" ? plan.products : plan.products - changedDocuments;
    const replacementMs = changedDocuments * msPerDocumentAtLimit;
    const coldRebuildMs = baselineDocuments * baseline + replacementMs;
    const storageRow = storage.find(({ relname }) => relname === `readme_exp_${bucket}`);
    if (!storageRow) throw new Error(`Missing PostgreSQL size for ${bucket}`);
    return {
      ...row,
      changedDocuments,
      coldRebuildHours: coldRebuildMs / 3_600_000,
      extraFromExistingV0Hours: bucket === "v0" ? 0 : replacementMs / 3_600_000,
      payloadBytes: plan.variantRows[bucket] * halfvecPayloadBytes,
      postgresHeapBytes: storageRow.heap_bytes,
      postgresTotalBytes: storageRow.total_bytes,
    };
  });
  return {
    batchGapMs, measuredPauseSeconds: 60 * slowProbes, probes: probes.length, slowProbes,
    maxProbeMs: probes.length ? Math.max(...probes.map(({ ms }) => ms)) : null, variants,
  };
}
