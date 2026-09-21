import { open } from "node:fs/promises";
import { evaluateLayaSamples, parseLayaEvaluationInput } from "../lib/crawl/laya-evaluation";

const USAGE = "Usage: tsx scripts/evaluate-laya-speculation.ts --input FILE.json --output NEW_FILE.json [--live]";
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

async function main() {
  const args = process.argv.slice(2);
  let input: string | undefined, output: string | undefined, live = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--input" && !input && args[index + 1] && !args[index + 1].startsWith("--")) input = args[++index];
    else if (arg === "--output" && !output && args[index + 1] && !args[index + 1].startsWith("--")) output = args[++index];
    else if (arg === "--live" && !live) live = true;
    else { console.error(USAGE); process.exitCode = 1; return; }
  }
  if (!input || !output) { console.error(USAGE); process.exitCode = 1; return; }
  if (live && (!process.env.LAYA_URL?.trim() || !process.env.LAYA_API_KEY?.trim())) {
    console.error("LAYA configuration required: set LAYA_URL and LAYA_API_KEY in the process environment.");
    process.exitCode = 1; return;
  }
  const source = await open(input, "r");
  let bytes: Buffer;
  try {
    if (!(await source.stat()).isFile()) throw new Error("invalid_input");
    bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await source.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_INPUT_BYTES) throw new Error("input_too_large");
    bytes = bytes.subarray(0, size);
  } finally { await source.close(); }
  const samples = parseLayaEvaluationInput(JSON.parse(bytes.toString("utf8")));
  // Exclusive create both protects previous reports and fails before spending API calls.
  const file = await open(output, "wx", 0o600);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const report = await evaluateLayaSamples(samples, { live, signal: controller.signal });
    await file.writeFile(JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ mode: report.mode, complete: report.complete, ...report.summary,
      measuredSpeedup: report.measuredSpeedup, productionEffect: report.productionEffect }));
    const configured = !report.rows.some(row => row.hint?.kind === "skipped" && row.hint.reason !== "outside_scope");
    if (!report.complete || report.summary.unavailable || !configured) process.exitCode = 2;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await file.close();
  }
}

main().catch(() => {
  // Neither exceptions nor response/source bodies are safe diagnostic output.
  console.error("LAYA evaluation failed. Check input format, file size and new output path. An incomplete report is not validation evidence.");
  process.exitCode = 1;
});
