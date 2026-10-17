import { execFileSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { attachLiveCapacityLabels, compareLiveCapacityRuns, reportLiveCapacityWindow } from "../lib/operations/pipeline-capacity-live";
import { formatCapacityCliError } from "../lib/operations/pipeline-capacity-cli";

const USAGE = "usage: pipeline-capacity-live collect RUN_ID START END primary|replica OUTPUT | report ARTIFACT | compare BASELINE CANDIDATE | label ARTIFACT LABELS OUTPUT";
async function read(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    const buffer = await file.readFile();
    if (buffer.byteLength > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    try { return JSON.parse(buffer.toString("utf8")) as unknown; }
    catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
}
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

/** 읽기 전용 수집. 명시한 URL 하나만 쓰고 앱 기본 DB(DATABASE_URL)·복제본 라우팅은 쓰지 않는다. */
async function collect(runId: string, startedAt: string, endedAt: string, target: string, output: string) {
  if (target !== "primary" && target !== "replica") throw new Error(USAGE);
  const url = process.env.LIVE_CAPACITY_DATABASE_URL;
  if (!url) throw new Error("explicit_LIVE_CAPACITY_DATABASE_URL_required");
  if (["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"].some(key => Boolean(process.env[key])))
    throw new Error("database_override_rejected");
  let revision: string;
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error("live_revision_unavailable"); }
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, { collectLiveCapacityWindow }] = await Promise.all([
    import("drizzle-orm/postgres-js"), import("../lib/db/schema"), import("../lib/db/pool"),
    import("../lib/operations/pipeline-capacity-live-repository")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: process.env.DB_POOLER_MODE,
    DB_POOL_MAX: "1" }), applicationName: "nomorevibe:capacity-live" });
  try {
    const artifact = await collectLiveCapacityWindow(drizzle(client, { schema }),
      { runId, revision, startedAt, endedAt, target });
    await save(output, artifact);
    const report = reportLiveCapacityWindow(artifact);
    console.log(JSON.stringify({ collected: true, target, attempts: artifact.attempts.length, votes: artifact.votes.length,
      finals: report.finals, witnesses: artifact.readiness.witnesses, evidenceIssues: report.evidenceIssues }));
  } finally { await client.end({ timeout: 5 }); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "collect" && args.length === 5) return collect(args[0], args[1], args[2], args[3], args[4]);
  let result: unknown;
  if (command === "report" && args.length === 1) result = reportLiveCapacityWindow(await read(args[0]));
  else if (command === "compare" && args.length === 2) result = compareLiveCapacityRuns(await read(args[0]), await read(args[1]));
  else if (command === "label" && args.length === 3) {
    await save(args[2], attachLiveCapacityLabels(await read(args[0]), await read(args[1])));
    result = { labeled: true };
  } else throw new Error(USAGE);
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(formatCapacityCliError(error)); process.exitCode = 1; });
