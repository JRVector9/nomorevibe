/** Privileged, manual, exact one-request release. No stop/restart, model call or terminal fabrication. */
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "./dr/promotion";
import { cliExecutorIndeterminateRemovedPlanSchema, cliExecutorIndeterminateRemovedPlanHash, cliExecutorIndeterminateRemovedReceiptSchema, cliExecutorIndeterminateRemovedArtifactHashes } from "@/lib/llm/cli-executor-indeterminate-removed-boundary-contract";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function boundedFile(path: string) { const stat = lstatSync(path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("cli_executor_indeterminate_removed_boundary_private_file_required"); if (stat.size > 5 * 1024 * 1024) throw new Error("cli_executor_indeterminate_removed_boundary_file_too_large"); return readFileSync(path); }
export function readIndeterminateRemovedBoundaryReleaseFiles(args: readonly string[]) {
  const allowed = new Set(["plan", "plan-sha", "receipt", "receipt-sha", "artifact-dir", "operator", "reference"]), opts = new Map<string, string>();
  let apply = false, stdin = false;
  for (const arg of args) {
    if (arg === "--apply" && !apply) { apply = true; continue; }
    if (arg === "--database-url-stdin" && !stdin) { stdin = true; continue; }
    const m = /^--([a-z-]+)=([^\n]+)$/.exec(arg);
    if (!m || !allowed.has(m[1]) || opts.has(m[1])) throw new Error("cli_executor_indeterminate_removed_boundary_cli_option");
    opts.set(m[1], m[2]);
  }
  if (!stdin || [...allowed].some(k => !opts.has(k))) throw new Error("cli_executor_indeterminate_removed_boundary_cli_required");
  const bytes = boundedFile(opts.get("plan")!);
  if (sha(bytes) !== opts.get("plan-sha")) throw new Error("cli_executor_indeterminate_removed_boundary_plan_file_hash");
  const plan = cliExecutorIndeterminateRemovedPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  const receiptBytes = boundedFile(opts.get("receipt")!);
  if (sha(receiptBytes) !== opts.get("receipt-sha")) throw new Error("cli_executor_indeterminate_removed_boundary_receipt_file_hash");
  const receipt = cliExecutorIndeterminateRemovedReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const hashes = cliExecutorIndeterminateRemovedArtifactHashes(plan, receipt);
  for (const hash of hashes) if (sha(boundedFile(resolve(opts.get("artifact-dir")!, `${hash}.json`))) !== hash)
    throw new Error("cli_executor_indeterminate_removed_boundary_artifact_hash");
  return { apply, plan, receipt, expectedPlanHash: cliExecutorIndeterminateRemovedPlanHash(plan), operator: opts.get("operator")!, reference: opts.get("reference")! };
}
export async function cliExecutorIndeterminateRemovedBoundaryReleaseMain(args: readonly string[]) {
  // Hashes bind the reviewed bytes. The operator must independently verify these are actual stop observations, not invented JSON.
  const input = readIndeterminateRemovedBoundaryReleaseFiles(args), chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) throw new Error("dr_cli_invalid_database_url"); }
  if ((globalThis as { db?: unknown; pgClient?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) throw new Error("dr_cli_database_already_open");
  process.env.DATABASE_URL = parseDatabaseUrl(Buffer.concat(chunks).toString("utf8")); delete process.env.READ_DATABASE_URL;
  try {
    const { releaseCliExecutorIndeterminateRemovedBoundaryRequest } = await import("@/lib/operations/dr/cli-executor-indeterminate-removed-boundary-release");
    const result = await releaseCliExecutorIndeterminateRemovedBoundaryRequest(input, input.apply);
    process.stdout.write(`${JSON.stringify({ dryRun: !input.apply, result })}\n`);
  } finally { await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cliExecutorIndeterminateRemovedBoundaryReleaseMain(process.argv.slice(2))
  .catch(() => { process.stderr.write('{"code":"cli_executor_indeterminate_removed_boundary_release_failed"}\n'); process.exitCode = 1; });
