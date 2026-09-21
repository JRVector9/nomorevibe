import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { summarizePipelineEvents } from "../lib/observability/review-pipeline";

// Offline JSONL only. Never infer historical p95 from one operations observation or contact production.
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error("Usage: tsx scripts/report-review-latency.ts LOG.jsonl");
const events: Record<string, unknown>[] = [];
let invalidLines = 0;
for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
  if (events.length >= 1_000_000 || line.length > 65_536) throw new Error("log_size_limit");
  try { const row = JSON.parse(line); if (row?.event === "review.pipeline") events.push(row); }
  catch { invalidLines++; }
}
console.log(JSON.stringify({ ...summarizePipelineEvents(events), invalidLines }, null, 2));
