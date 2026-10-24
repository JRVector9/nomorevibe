/** Privileged, manual, exact one-request release. No stop/restart, model call or terminal fabrication. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "./dr/promotion";
import { providerBoundaryPlanSchema, providerBoundaryPlanHash, providerBoundaryReceiptSchema } from "@/lib/llm/provider-boundary-contract";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function boundedFile(path: string) { if (statSync(path).size > 5 * 1024 * 1024) throw new Error("provider_boundary_file_too_large"); return readFileSync(path); }
export function readBoundaryReleaseFiles(args: readonly string[]) {
  const allowed = new Set(["plan", "plan-sha", "receipt", "artifact-dir", "operator", "reference"]), opts = new Map<string, string>();
  let apply = false, stdin = false;
  for (const arg of args) {
    if (arg === "--apply" && !apply) { apply = true; continue; }
    if (arg === "--database-url-stdin" && !stdin) { stdin = true; continue; }
    const m = /^--([a-z-]+)=([^\n]+)$/.exec(arg);
    if (!m || !allowed.has(m[1]) || opts.has(m[1])) throw new Error("provider_boundary_cli_option");
    opts.set(m[1], m[2]);
  }
  if (!stdin || [...allowed].some(k => !opts.has(k))) throw new Error("provider_boundary_cli_required");
  const bytes = boundedFile(opts.get("plan")!);
  if (sha(bytes) !== opts.get("plan-sha")) throw new Error("provider_boundary_plan_file_hash");
  const plan = providerBoundaryPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  const receipt = providerBoundaryReceiptSchema.parse(JSON.parse(boundedFile(opts.get("receipt")!).toString("utf8")));
  const hashes = [plan.beforeArtifactHash, receipt.owner.artifactHash, ...receipt.gateways.map(g => g.artifactHash), receipt.provider.artifactHash];
  for (const hash of hashes) if (sha(boundedFile(resolve(opts.get("artifact-dir")!, `${hash}.json`))) !== hash)
    throw new Error("provider_boundary_artifact_hash");
  return { apply, plan, receipt, expectedPlanHash: providerBoundaryPlanHash(plan), operator: opts.get("operator")!, reference: opts.get("reference")! };
}
export async function providerBoundaryReleaseMain(args: readonly string[]) {
  // Hashes bind the reviewed bytes. The operator must independently verify these are actual stop observations, not invented JSON.
  const input = readBoundaryReleaseFiles(args), chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) throw new Error("dr_cli_invalid_database_url"); }
  if ((globalThis as { db?: unknown; pgClient?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) throw new Error("dr_cli_database_already_open");
  process.env.DATABASE_URL = parseDatabaseUrl(Buffer.concat(chunks).toString("utf8")); delete process.env.READ_DATABASE_URL;
  try {
    const { releaseProviderBoundaryRequest } = await import("@/lib/operations/dr/provider-boundary-release");
    const result = await releaseProviderBoundaryRequest(input, input.apply);
    process.stdout.write(`${JSON.stringify({ dryRun: !input.apply, result })}\n`);
  } finally { await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void providerBoundaryReleaseMain(process.argv.slice(2))
  .catch(() => { process.stderr.write('{"code":"provider_boundary_release_failed"}\n'); process.exitCode = 1; });
