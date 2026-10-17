/**
 * PR17a 2배 rollout 보고 도구. 모든 DB 명령은 읽기 전용 REPEATABLE READ 한 트랜잭션이며 쓰기가 없다.
 *   snapshot  --output=FILE [--target=primary|replica]                      구간 시작 전 기준 카운터(역할 epoch·잡 실행 수·제어 epoch)
 *   observe   --run=ID --end=ISO --output=FILE [--hours=24] [--baseline=FILE] [--target=…]   (end−hours, end] 운영 관측
 *   dr-drill  --promotion=UUID --output=FILE [--failure-at=ISO] [--target=…]  승격 DB의 DR 증거로 RPO/RTO
 *   report    --artifact=FILE [--json]                                       요약(기본 사람용, --json은 기계용)
 * DB는 PIPELINE_REPORT_DATABASE_URL 하나만 쓴다(DATABASE_URL·복제본 라우팅·libpq 우회 거절). 출력 파일은 새로 만들고(0600) 덮어쓰지 않는다.
 * exit: 0 정상, 1 오류(고정 code만 stderr), 3 report에서 안전 위반(중복 발행·사람 결정 덮음·lease 위반)이 검증됨.
 */
import { execFileSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { formatPipelineObservation, OBSERVATION_DEFAULT_HOURS, OBSERVATION_MAX_WINDOW_MS, OBSERVATION_MIN_WINDOW_MS, pipelineSnapshotSchema,
  reportPipelineObservation } from "../lib/operations/pipeline-observation";
import { formatDrillReport, reportDrill } from "../lib/operations/dr/drill-report";

type Target = "primary" | "replica";
export type ReportCliCommand =
  | { command: "snapshot"; output: string; target: Target }
  | { command: "observe"; runId: string; endedAt: string; output: string; hours: number; baseline: string | null; target: Target }
  | { command: "dr-drill"; promotionId: string; output: string; failureAt: string | null; target: Target }
  | { command: "report"; artifact: string; json: boolean };
const ALLOWED: Record<ReportCliCommand["command"], readonly string[]> = { snapshot: ["output", "target"],
  observe: ["run", "end", "output", "hours", "baseline", "target"], "dr-drill": ["promotion", "output", "failure-at", "target"], report: ["artifact", "json"] };
const FLAGS = new Set(["json"]);
const fail = (code: string): never => { throw new Error(code); };
const isoMillis = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(Date.parse(value)).toISOString() === value;

/** --key=value 형식만. 모르는·중복 옵션과 값 없는 옵션은 거절한다. */
export function parseReportCliArgs(args: readonly string[]): ReportCliCommand {
  const [command, ...rest] = args;
  if (!command || !Object.hasOwn(ALLOWED, command)) return fail("report_cli_unknown_command");
  const name = command as ReportCliCommand["command"], options = new Map<string, string>();
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !ALLOWED[name].includes(match[1])) return fail("report_cli_unknown_option");
    if (FLAGS.has(match[1]) ? match[2] !== undefined : !match[2]) fail("report_cli_invalid_option");
    if (options.has(match[1])) fail("report_cli_duplicate_option");
    options.set(match[1], match[2] ?? "");
  }
  const key = (option: string) => option.replace(/-/g, "_");
  const one = (option: string) => options.get(option) ?? fail(`report_cli_missing_${key(option)}`);
  const checked = (option: string, valid: (value: string) => boolean, value = one(option)) => valid(value) ? value : fail(`report_cli_invalid_${key(option)}`);
  const target = () => (options.has("target") ? checked("target", value => value === "primary" || value === "replica") : "primary") as Target;
  switch (name) {
    case "snapshot": return { command: name, output: one("output"), target: target() };
    case "observe": {
      const hours = options.has("hours") ? Number(checked("hours", value => /^\d+(\.\d+)?$/.test(value))) : OBSERVATION_DEFAULT_HOURS;
      if (hours * 3_600_000 < OBSERVATION_MIN_WINDOW_MS || hours * 3_600_000 > OBSERVATION_MAX_WINDOW_MS) fail("report_cli_invalid_hours");
      return { command: name, runId: checked("run", value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)), endedAt: checked("end", isoMillis),
        output: one("output"), hours, baseline: options.get("baseline") ?? null, target: target() };
    }
    case "dr-drill": return { command: name, promotionId: checked("promotion", value => z.uuid().safeParse(value).success), output: one("output"),
      failureAt: options.has("failure-at") ? checked("failure-at", isoMillis) : null, target: target() };
    case "report": return { command: name, artifact: one("artifact"), json: options.has("json") };
  }
}

const LIMIT = 64 * 1024 * 1024;
async function read(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error("artifact_size_limit");
    const buffer = await file.readFile();
    if (buffer.byteLength > LIMIT) throw new Error("artifact_size_limit");
    try { return JSON.parse(buffer.toString("utf8")) as unknown; } catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
}
async function save(path: string, value: unknown) {
  try { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "report_output_exists" : "report_output_failed"); }
}

/** 명시한 URL 하나만 연다. 앱 기본 DB·복제본 라우팅·libpq 환경 우회는 쓰지 않는다. 연결 1개. */
async function withDatabase<T>(run: (database: import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof import("../lib/db/schema")>) => Promise<T>): Promise<T> {
  const url = process.env.PIPELINE_REPORT_DATABASE_URL;
  if (!url) throw new Error("explicit_PIPELINE_REPORT_DATABASE_URL_required");
  if (["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"].some(key => Boolean(process.env[key]))) throw new Error("database_override_rejected");
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }] = await Promise.all([
    import("drizzle-orm/postgres-js"), import("../lib/db/schema"), import("../lib/db/pool")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: process.env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:rollout-report" });
  try { return await run(drizzle(client, { schema })); } finally { await client.end({ timeout: 5 }); }
}

export async function reportCliMain(args: readonly string[], stdout: (text: string) => void = text => process.stdout.write(text)): Promise<number> {
  const command = parseReportCliArgs(args);
  const line = (value: unknown) => stdout(`${JSON.stringify(value)}\n`);
  if (command.command === "report") {
    const value = await read(command.artifact), scope = (value as { scope?: unknown } | null)?.scope;
    if (scope === "pipeline_observation") {
      const report = reportPipelineObservation(value);
      stdout(command.json ? `${JSON.stringify(report, null, 2)}\n` : formatPipelineObservation(report));
      return report.violations.length ? 3 : 0;
    }
    if (scope === "dr_drill") {
      const report = reportDrill(value);
      stdout(command.json ? `${JSON.stringify(report, null, 2)}\n` : formatDrillReport(report));
      return 0;
    }
    if (scope === "pipeline_snapshot") { const snapshot = pipelineSnapshotSchema.parse(value); stdout(`${JSON.stringify(snapshot, null, 2)}\n`); return 0; }
    return fail("report_artifact_scope_unknown");
  }
  if (command.command === "snapshot") {
    const { collectPipelineSnapshot } = await import("../lib/operations/pipeline-observation-repository");
    const snapshot = await withDatabase(database => collectPipelineSnapshot(database, command.target));
    await save(command.output, snapshot);
    line({ captured: true, capturedAt: snapshot.capturedAt, roles: snapshot.roles.length, jobs: snapshot.jobs.length });
    return 0;
  }
  if (command.command === "observe") {
    // 기준 스냅숏은 DB를 열기 전에 검증한다.
    const baseline = command.baseline === null ? null : pipelineSnapshotSchema.parse(await read(command.baseline));
    let revision: string;
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { throw new Error("report_revision_unavailable"); }
    const { collectPipelineObservation } = await import("../lib/operations/pipeline-observation-repository");
    const artifact = await withDatabase(database => collectPipelineObservation(database, { runId: command.runId, revision, endedAt: command.endedAt,
      hours: command.hours, target: command.target, baseline }));
    await save(command.output, artifact);
    const report = reportPipelineObservation(artifact);
    line({ collected: true, window: artifact.window, violations: report.violations, evidenceIssues: report.evidenceIssues });
    return 0;
  }
  const { collectDrillReport } = await import("../lib/operations/dr/drill-report-repository");
  const artifact = await withDatabase(database => collectDrillReport(database, { promotionId: command.promotionId, failureAt: command.failureAt,
    target: command.target }));
  await save(command.output, artifact);
  const report = reportDrill(artifact);
  line({ collected: true, rpoMs: report.rpoMs, rtoPromotionMs: report.rtoPromotionMs, unknown: report.unknown });
  return 0;
}

/** URL·SQL·경로·스택은 쓰지 않는다. 고정 code만. */
export function formatReportCliError(error: unknown): string {
  if (error instanceof ZodError) return "invalid_report_artifact";
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:]{2,120}$/.test(error.message) ? error.message : "pipeline_report_failed";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void reportCliMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${formatReportCliError(error)}\n`); process.exitCode = 1;
  });
}
