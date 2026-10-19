import { execFileSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { assertExportSourceEnv, assertIsolatedReplayDatabase, attachFixedInputLabels, compareFixedInputRuns, FIXED_INPUT_FILE_LIMIT,
  formatFixedInputCliError, parseFixedInputArtifact, parseFixedInputRunManifest, reportFixedInputRun, sha256 } from "../lib/operations/pipeline-replay-fixed-input";
import { fixedInputPreflightStatus } from "../lib/operations/pipeline-replay-preflight-status";

const USAGE = "usage: pipeline-replay-fixed-input export FROM TO SEED COUNT OUTPUT | preflight MANIFEST ARTIFACT | run MANIFEST ARTIFACT OUTPUT"
  + " | report RESULT | compare BASELINE CANDIDATE | label RESULT LABELS OUTPUT";
async function bytes(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > FIXED_INPUT_FILE_LIMIT) throw new Error("artifact_size_limit");
    const value = await file.readFile();
    if (value.byteLength > FIXED_INPUT_FILE_LIMIT) throw new Error("artifact_size_limit");
    return value;
  } finally { await file.close(); }
}
function json(value: Buffer): unknown {
  try { return JSON.parse(value.toString("utf8")) as unknown; } catch { throw new Error("invalid_artifact_json"); }
}
const read = async (path: string) => json(await bytes(path));
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
function revision(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error("live_revision_unavailable"); }
}

/** 운영 원본 읽기 전용. 명시한 URL 하나만, 연결 1개·REPEATABLE READ READ ONLY 트랜잭션으로 연다. */
async function exportCommand(from: string, to: string, seed: string, count: string, output: string) {
  const url = assertExportSourceEnv(process.env);
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, { exportFixedInputs }] = await Promise.all([
    import("drizzle-orm/postgres-js"), import("../lib/db/schema"), import("../lib/db/pool"), import("../lib/operations/pipeline-replay-fixed-input-repository")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: process.env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:fixed-input-export" });
  try {
    const artifact = await exportFixedInputs(drizzle(client, { schema }), { from, to, seed, count: Number(count), revision: revision() })
      .catch((error: unknown) => {
        const summary = (error as { exportSummary?: unknown } | null)?.exportSummary;
        if (summary) console.log(JSON.stringify({ exported: false, ...summary as object }));
        throw error;
      });
    await save(output, artifact);
    console.log(JSON.stringify({ exported: true, selected: artifact.inputs.length, population: artifact.export.population,
      examined: artifact.export.examined, exclusions: artifact.export.exclusions, firstReviewer: artifact.export.firstReviewer }));
  } finally { await client.end({ timeout: 5 }); }
}

/** 격리 DB 관문을 드라이버·앱 모듈을 읽기 전에 통과시킨다. 운영 URL·복제본·libpq 우회는 여기서 끝난다. */
async function runCommand(manifestPath: string, artifactPath: string, output: string) {
  const manifestBytes = await bytes(manifestPath), artifactBytes = await bytes(artifactPath);
  const manifest = parseFixedInputRunManifest(json(manifestBytes)), artifact = parseFixedInputArtifact(json(artifactBytes));
  if (manifest.artifactSha256 !== sha256(artifactBytes)) throw new Error("replay_artifact_sha_mismatch");
  const url = assertIsolatedReplayDatabase(process.env.TEST_DATABASE_URL, process.env);
  process.env.DATABASE_URL = url;
  const { runFixedInputReplay } = await import("../lib/operations/pipeline-replay-model-runner");
  try {
    const result = await runFixedInputReplay({ manifest: json(manifestBytes), artifact, artifactSha256: sha256(artifactBytes),
      manifestSha256: sha256(manifestBytes), revision: revision() });
    await save(output, result);
    const report = reportFixedInputRun(result);
    console.log(JSON.stringify({ ran: true, mode: result.mode, included: result.inputs.items.length, stop: result.stop, calls: result.meter.calls,
      finals: report.finals, finalPerHour: report.finalPerHour, writes: result.writes, evidenceIssues: report.evidenceIssues }));
  } finally {
    const client = (globalThis as typeof globalThis & { pgClient?: { end(options: { timeout: number }): Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "export" && args.length === 5) return exportCommand(args[0], args[1], args[2], args[3], args[4]);
  if (command === "run" && args.length === 3) return runCommand(args[0], args[1], args[2]);
  let result: unknown;
  if (command === "preflight" && args.length === 2) {
    const [manifestBytes, artifactBytes] = await Promise.all(args.map(bytes));
    const { fixedInputPreflight } = await import("../lib/operations/pipeline-replay-model-runner");
    const checked = fixedInputPreflight(json(manifestBytes), json(artifactBytes));
    result = { mode: checked.manifest.mode, ...fixedInputPreflightStatus(checked.manifest.artifactSha256, sha256(artifactBytes), checked.blocked),
      inputs: checked.artifact.inputs.length, limits: checked.manifest.limits, durationMs: checked.manifest.durationMs,
      firstReviewer: checked.settings.firstReview, voters: checked.settings.secondReview.voters, fallbacks: checked.settings.secondReview.fallbacks ?? [] };
  } else if (command === "report" && args.length === 1) result = reportFixedInputRun(await read(args[0]));
  else if (command === "compare" && args.length === 2) result = compareFixedInputRuns(await read(args[0]), await read(args[1]));
  else if (command === "label" && args.length === 3) {
    await save(args[2], attachFixedInputLabels(await read(args[0]), await read(args[1])));
    result = { labeled: true };
  } else throw new Error("invalid_fixed_input_command");
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => {
  console.error(error instanceof Error && error.message === "invalid_fixed_input_command" ? USAGE : formatFixedInputCliError(error));
  process.exitCode = 1;
});
