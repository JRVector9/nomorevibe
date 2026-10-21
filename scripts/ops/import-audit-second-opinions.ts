/** 감사 답의 두 번째 의견(grok 일괄 JSONL)을 product_audit_second_opinions 에 옮겨 적는다(0110, lib/crawl/audit-second-opinion-import.ts).
 *   AUDIT_SECOND_OPINIONS_DATABASE_URL=... node --import tsx scripts/ops/import-audit-second-opinions.ts <file.jsonl> [--dry-run] [--source=grok-cli-batch]
 * 줄마다 auditResultId·productId·grokDecision·grokConfidence·grokReason·model·inputHash·error 를 읽는다. 오류가 적힌 줄, 없는 항목,
 * 이제 열린 거절이 아닌 항목은 건너뛴다. 같은 (항목, 모델)은 덮어써서 몇 번 돌려도 같다. 승인 의견이 지금 그 항목으로 보류된 제품에 오면
 * 거절 의견이 남지 않았을 때 보류를 푼다(released, 누가 import:<source>). --dry-run 은 읽기 전용 트랜잭션에서 셈만 한다(released 는 풀 수).
 * DB URL 은 환경변수로만 받는다(argv·출력에 쓰지 않음). 출력은 수만 — 사유 문장은 쓰지 않는다. 운영 DB 에 돌리는 것은 따로 승인을 받는다.
 * 옮겨 적은 두 번째 거절은 감사 잡의 쓸기가 다음 틱부터 분당 20건씩 보류한다(lib/crawl/product-audit-hold.ts). exit 0=완료, 1=오류. */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecondOpinionLine } from "@/lib/crawl/audit-second-opinion-import";

/** 2,755줄 × 사유 2천 자에도 넉넉하다 — 그보다 크면 잘못 고른 파일이다 */
const FILE_LIMIT = 64 * 1024 * 1024;
const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;

export function parseImportArgs(args: readonly string[]): { file: string; dryRun: boolean; source: string } {
  const files = args.filter((arg) => !arg.startsWith("--"));
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--dry-run" && !arg.startsWith("--source="));
  if (files.length !== 1 || unknown.length) throw new Error("second_opinions_usage");
  const source = args.find((arg) => arg.startsWith("--source="))?.slice("--source=".length).trim() || "grok-cli-batch";
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(source)) throw new Error("second_opinions_invalid_source");
  return { file: files[0], dryRun: args.includes("--dry-run"), source };
}

/** JSONL 을 줄로 — 빈 줄은 건너뛰고, JSON 이 아닌 줄은 모양이 틀린 줄로 넘긴다(가져오기가 'invalid' 로 센다) */
export async function readSecondOpinionLines(path: string): Promise<SecondOpinionLine[]> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error("second_opinions_invalid_file");
    return (await file.readFile()).toString("utf8").split("\n").filter((line) => line.trim()).map((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? value as SecondOpinionLine : {};
      } catch { return {}; }
    });
  } finally { await file.close(); }
}

export async function importSecondOpinionsMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = (line) => { process.stdout.write(line); }): Promise<number> {
  const command = parseImportArgs(args);
  const url = env.AUDIT_SECOND_OPINIONS_DATABASE_URL;
  if (!url) throw new Error("explicit_AUDIT_SECOND_OPINIONS_DATABASE_URL_required");
  if (OVERRIDES.some((key) => Boolean(env[key]))) throw new Error("database_override_rejected");
  const lines = await readSecondOpinionLines(command.file);
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, { importAuditSecondOpinions }] = await Promise.all([
    import("drizzle-orm/postgres-js"), import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/crawl/audit-second-opinion-import")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:audit-second-opinions" });
  try {
    const result = await importAuditSecondOpinions(drizzle(client, { schema }), lines, { dryRun: command.dryRun, source: command.source });
    write(`${JSON.stringify({ command: "import-audit-second-opinions", source: command.source, ...result })}\n`);
    return 0;
  } finally { await client.end({ timeout: 5 }); }
}

/** 고정 code 만 출력한다. URL·SQL·stack 은 쓰지 않는다 */
function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "second_opinions_failed";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void importSecondOpinionsMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${JSON.stringify({ code: errorCode(error) })}\n`);
    process.exitCode = 1;
  });
}
