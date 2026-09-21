import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseLayaEvaluationInput } from "../lib/crawl/laya-evaluation";
import { createQualityAudit, renderQualityAudit, summarizeQualityAudit } from "../lib/crawl/laya-quality-audit";

const USAGE = "Usage: tsx scripts/prepare-laya-quality-audit.ts --input FILE --responses FILE --out-dir NEW_DIRECTORY --seed SEED --take COUNT [--annotations FILE]";
const MAX_BYTES = 2 * 1024 * 1024;
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("invalid_file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("input_too_large");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { await file.close(); }
}
async function main() {
  const args = process.argv.slice(2), options: Record<string, string> = {};
  const allowed = new Set(["--input", "--responses", "--out-dir", "--seed", "--take", "--annotations"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || options[args[i]] || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid_arguments");
    options[args[i]] = args[i + 1];
  }
  if (["--input", "--responses", "--out-dir", "--seed", "--take"].some(key => !options[key])) throw new Error("missing_arguments");
  const samples = parseLayaEvaluationInput(await readJson(options["--input"]));
  const plan = createQualityAudit(samples, await readJson(options["--responses"]), { seed: options["--seed"], take: Number(options["--take"]) });
  const annotations = options["--annotations"] ? await readJson(options["--annotations"]) : null;
  const summary = summarizeQualityAudit(plan, annotations);
  const html = renderQualityAudit(plan);
  // An existing directory is never reused, including symlinks. No API or database writes.
  await mkdir(options["--out-dir"], { mode: 0o700 });
  const files = { "index.html": html, "assignment.json": JSON.stringify(plan, null, 2) + "\n", "summary.json": JSON.stringify(summary, null, 2) + "\n" };
  for (const [name, content] of Object.entries(files)) await writeFile(join(options["--out-dir"], name), content, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ auditId: plan.auditId, population: plan.population, perGroup: plan.take,
    uniqueCards: plan.cards.length, overlap: plan.overlap, status: summary.status, productionEffect: "none" }));
}
main().catch(() => {
  console.error(USAGE);
  console.error("Quality audit preparation failed. Check input, complete matching responses, annotations and a new output directory. Private error details are suppressed.");
  process.exitCode = 1;
});
