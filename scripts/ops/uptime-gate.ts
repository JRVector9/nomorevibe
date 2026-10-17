/** uptime raw→gate 전환 운영 도구(PR09b). 절차·확인 쿼리·중단 조건은 docs/runbooks/uptime-gate-transition.md.
 *   UPTIME_GATE_DATABASE_URL=... node --import tsx scripts/ops/uptime-gate.ts status
 *   ... plan raw-only --sources=sources.json | plan gate
 *   ... apply raw-only|gate --expect-revision=N --operator=NAME [--sources=sources.json] [--apply]
 *   ... rollback --expect-revision=N --operator=NAME [--apply]
 * DB URL은 환경변수로만 받는다(argv·출력에 쓰지 않음). 쓰기 명령은 기본 dry-run(같은 TX를 실행한 뒤 ROLLBACK)이고
 * --apply가 있어야 commit한다. exit 0=완료, 3=근거 부족으로 거절, 1=오류(고정 code만 stderr). */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUptimeGateError, parseUptimeGateArgs, planUptimeTransition, uptimeGateDatabaseUrl } from "@/lib/operations/uptime-gate";

const SOURCES_FILE_LIMIT = 16 * 1024;
async function readSources(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > SOURCES_FILE_LIMIT) throw new Error("uptime_gate_invalid_sources_file");
    try { return JSON.parse((await file.readFile()).toString("utf8")) as unknown; }
    catch { throw new Error("uptime_gate_invalid_sources_file"); }
  } finally { await file.close(); }
}

export async function uptimeGateMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = line => { process.stdout.write(line); }): Promise<number> {
  const command = parseUptimeGateArgs(args);
  const url = uptimeGateDatabaseUrl(env);
  const sources = "sourcesPath" in command && command.sourcesPath ? await readSources(command.sourcesPath) : undefined;
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, repository] = await Promise.all([import("drizzle-orm/postgres-js"),
    import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/operations/uptime-gate-repository")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:uptime-gate" });
  const database = drizzle(client, { schema });
  const out = (result: unknown, blocked: boolean) => {
    write(`${JSON.stringify({ command: command.command, dryRun: "apply" in command ? !command.apply : true, blocked, result })}\n`);
    return blocked ? 3 : 0;
  };
  try {
    switch (command.command) {
      case "status": return out(await repository.readUptimeGateSnapshot(database), false);
      case "plan": {
        const snapshot = await repository.readUptimeGateSnapshot(database);
        const plan = planUptimeTransition(command.target, snapshot, sources);
        return out({ plan, snapshot }, !plan.allowed);
      }
      case "apply": {
        const result = await repository.applyUptimeTransition(database, { target: command.target, expectRevision: command.expectRevision,
          sources, operator: command.operator, apply: command.apply });
        return out(result, result.kind === "blocked");
      }
      case "rollback": {
        const result = await repository.rollbackUptimeTransition(database, command);
        return out(result, result.kind === "blocked");
      }
    }
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void uptimeGateMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${JSON.stringify({ code: formatUptimeGateError(error) })}\n`);
    process.exitCode = 1;
  });
}
