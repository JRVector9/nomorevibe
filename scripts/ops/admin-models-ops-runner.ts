/** Operator host only: node --import tsx scripts/ops/admin-models-ops-runner.ts prepare|run UUID --profile=/private/profile.json --state-dir=/private/state */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { z } from "zod";
import { readModelOpsState, saveModelOpsState } from "@/lib/operations/ops-runner/repository";
import { opsRootHandoffPath, runPreparedModelOps } from "@/lib/operations/ops-runner/operator";
import { opsFinished } from "@/lib/operations/ops-runner/contract";

export function parseOpsRunnerArgs(args: string[]) {
  if (args.length !== 4 || !["prepare", "run"].includes(args[0]) || !z.uuid().safeParse(args[1]).success
    || !args[2].startsWith("--profile=/") || !args[3].startsWith("--state-dir=/")) throw new Error("ops_runner_arguments_denied");
  return { prepare: args[0] === "prepare", id: args[1], profile: args[2].slice(10), directory: args[3].slice(12) };
}
async function main() {
  const args = parseOpsRunnerArgs(process.argv.slice(2));
  // Dedicated direct Postgres session owns a global advisory lock. No web or maintenance SSH credentials.
  if (!process.env.DATABASE_URL) throw new Error("ops_runner_database_required");
  const lock = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: null });
  const session = await lock.reserve();
  try {
    const [row] = await session`SELECT pg_try_advisory_lock(7219402) AS locked`;
    if (!row.locked) throw new Error("ops_runner_already_running");
    const state = await readModelOpsState(args.id);
    if (!state) throw new Error("ops_runner_job_missing");
    if (opsFinished(state)) { process.stdout.write(JSON.stringify(state) + "\n"); return; }
    let result;
    try { result = await runPreparedModelOps(state, args.profile, args.directory, args.prepare); }
    catch {
      const latest = await readModelOpsState(args.id);
      await saveModelOpsState({ ...(latest ?? state), status: "blocked", code: "operator_profile_or_journal_rejected" });
      throw new Error("ops_runner_operator_precheck_failed");
    }
    const rootHandoffFile = opsRootHandoffPath(args.directory, args.id);
    process.stdout.write(JSON.stringify({ ...result, ...(existsSync(rootHandoffFile) ? { rootHandoffFile } : {}) }) + "\n");
    if (result.status === "blocked" || result.status === "manual") process.exitCode = 1;
  } finally {
    await session`SELECT pg_advisory_unlock(7219402)`.catch(() => {}); session.release();
    await lock.end({ timeout: 5 });
    await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  process.stderr.write('{"code":"ops_runner_failed_inspect_journal"}\n'); process.exitCode = 1;
});
