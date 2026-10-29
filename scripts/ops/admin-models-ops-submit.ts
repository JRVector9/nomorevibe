/** Operator shell intake for an ops-runner "request-release" job, for a web release that has no /admin/models button yet.
 *   DATABASE_URL=<direct primary> node --import tsx scripts/ops/admin-models-ops-submit.ts \
 *     --target=<indeterminate request UUID> --id=<new job UUID> --operator=<name> --reason=<text> [--execute]
 * Default is a READ ONLY preview. --execute calls the same submitModelOpsCommand as the web action (advisory lock, DR writer fence,
 * one unfinished job at a time, indeterminate re-check, append-only operations_audit row). Re-running with the same --id after an
 * unclear response returns the existing job; a different reason/operator/target for that id is refused.
 * The DB URL is read from the environment only. exit 0=submitted/allowed, 3=refused (nothing written), 1=error (fixed code on stderr). */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { opsCommandSchema } from "@/lib/operations/ops-runner/contract";

const operatorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,119}$/);
export function parseOpsSubmitArgs(args: readonly string[]) {
  const options = new Map<string, string>();
  let execute = false;
  for (const arg of args) {
    if (arg === "--execute" && !execute) { execute = true; continue; }
    const match = /^--(target|id|operator|reason)=([^]+)$/.exec(arg);
    if (!match || options.has(match[1])) throw new Error("ops_submit_arguments_denied");
    options.set(match[1], match[2]);
  }
  if (options.size !== 4) throw new Error("ops_submit_arguments_denied");
  const command = opsCommandSchema.safeParse({ action: "request-release", targetId: options.get("target"), reason: options.get("reason"),
    confirmed: true, id: options.get("id") });
  const operator = operatorSchema.safeParse(options.get("operator"));
  if (!command.success || !operator.success) throw new Error("ops_submit_arguments_denied");
  return { command: command.data, operator: operator.data, execute };
}

async function main() {
  const { command, operator, execute } = parseOpsSubmitArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("ops_submit_database_required");
  const { previewModelOpsCommand, submitModelOpsCommand, readModelOpsState } = await import("@/lib/operations/ops-runner/repository");
  try {
    const preview = await previewModelOpsCommand(command, operator);
    if (!execute || preview.blocked.length) {
      process.stdout.write(JSON.stringify({ dryRun: !execute, command, operator, ...preview }) + "\n");
      if (preview.blocked.length) process.exitCode = 3;
      return;
    }
    const submitted = await submitModelOpsCommand(command, operator, "cli");
    // The append-only row id is the audit number, distinct from the job UUID.
    const recorded = await readModelOpsState(submitted.id);
    process.stdout.write(JSON.stringify({ dryRun: false, state: recorded ?? submitted, request: preview.request }) + "\n");
  } finally {
    await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  const known = new Set(["ops_submit_arguments_denied", "ops_submit_database_required", "dr_writer_site_fenced", "ops_runner_id_conflict",
    "ops_runner_unfinished_operation", "ops_runner_request_not_indeterminate"]);
  const code = error instanceof Error && known.has(error.message) ? error.message : "ops_submit_unconfirmed_readback_required";
  process.stderr.write(JSON.stringify({ code }) + "\n"); process.exitCode = 1;
});
