/** 응답 점검 제품 단위 분담(split-v1) 운영 제어. 절차·중단 조건·되돌리기는 docs/runbooks/uptime-split.md.
 *   UPTIME_SPLIT_DATABASE_URL=... node --import tsx scripts/ops/uptime-split.ts status [--json]
 *   ... policy --file=policy.json --expect-epoch=N --expect-policy-hash=HASH|none --operator=NAME --reason=TEXT [--execute] [--json]
 *   ... mode --to=claims|legacy --from-mode=legacy|claims --expect-epoch=N --operator=NAME --reason=TEXT [--execute] [--json]
 * 전환 명령은 기대 현재 상태·--operator·--reason이 필수이고 기본 dry-run(읽기 전용, DB 쓰기 0)이다. --execute일 때만 한 TX로 쓰고
 * 관리자 작업 로그를 남긴다. DB URL은 환경변수로만 받는다(argv·출력에 쓰지 않음). exit 0=완료·허용, 3=거절(아무것도 쓰지 않음),
 * 1=오류(stderr에 고정 code만). */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUptimeSplitError, formatUptimeSplitResult, formatUptimeSplitStatus, parseUptimeSplitArgs,
  uptimeSplitDatabaseUrl } from "@/lib/operations/uptime-split";

const POLICY_FILE_LIMIT = 16 * 1024;
async function readPolicy(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > POLICY_FILE_LIMIT) throw new Error("uptime_split_invalid_policy_file");
    try { return JSON.parse((await file.readFile()).toString("utf8")) as unknown; }
    catch { throw new Error("uptime_split_invalid_policy_file"); }
  } finally { await file.close(); }
}

export async function uptimeSplitMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  const command = parseUptimeSplitArgs(args);
  const url = uptimeSplitDatabaseUrl(env);
  const policy = command.name === "policy" ? await readPolicy(command.file) : undefined;
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, repository] = await Promise.all([import("drizzle-orm/postgres-js"),
    import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/operations/uptime-split-repository")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:uptime-split" });
  const database = drizzle(client, { schema });
  try {
    if (command.name === "status") {
      const snapshot = await repository.readUptimeSplitSnapshot(database);
      write(command.json ? `${JSON.stringify({ command: "status", snapshot })}\n` : formatUptimeSplitStatus(snapshot));
      return 0;
    }
    const result = await repository.runUptimeSplitControl(database, command, policy);
    write(command.json ? `${JSON.stringify(result)}\n` : formatUptimeSplitResult(result));
    return result.blocked ? 3 : 0;
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void uptimeSplitMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${JSON.stringify({ code: formatUptimeSplitError(error) })}\n`);
    process.exitCode = 1;
  });
}
