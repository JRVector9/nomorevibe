/** 0097 증거 장부 기록 시작 marker CLI(F1). 절차는 docs/operations/2026-10-15-pipeline-two-times-rollout.md §4.
 *   PIPELINE_CONTROL_DATABASE_URL=... node --import tsx scripts/ops/pipeline-evidence-marker.ts --revision=SHA --operator=NAME [--execute] [--json]
 * 기본 dry-run(읽기 전용, DB 쓰기 0)이다. --execute일 때만 marker를 남기고, 이미 있으면 그대로 둔다(새로 남겼을 때만 관리자 작업 로그).
 * DB URL은 환경변수로만 받는다(argv·출력에 쓰지 않음). exit 0=완료(dry-run·새로 남김·이미 있음), 1=오류(stderr에 고정 code만). */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipelineControlDatabaseUrl } from "@/lib/operations/pipeline-control";
import { formatEvidenceMarkerError, parseEvidenceMarkerArgs } from "@/lib/operations/pipeline-evidence-marker";

export async function pipelineEvidenceMarkerMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  const command = parseEvidenceMarkerArgs(args);
  const url = pipelineControlDatabaseUrl(env);
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, marker] = await Promise.all([import("drizzle-orm/postgres-js"),
    import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/operations/pipeline-evidence-marker")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:pipeline-evidence-marker" });
  const database = drizzle(client, { schema });
  try {
    const result = command.execute
      ? { dryRun: false, ...await marker.recordEvidenceRecorderStart(database, command) }
      : { dryRun: true, ...await marker.readEvidenceRecorder(database), revision: command.revision, operator: command.operator };
    write(command.json ? `${JSON.stringify(result)}\n` : `${Object.entries(result).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n`);
    return 0;
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void pipelineEvidenceMarkerMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${JSON.stringify({ code: formatEvidenceMarkerError(error) })}\n`);
    process.exitCode = 1;
  });
}
