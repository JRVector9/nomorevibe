/** 운영자 제어 CLI(PR06d): stage mode·공통 모델 슬롯·공유 HTTP·job batch control. 절차는 docs/operations/2026-10-17-pipeline-control-runbook.md.
 *   PIPELINE_CONTROL_DATABASE_URL=... node --import tsx scripts/ops/pipeline-control.ts status [--json]
 *   ... stage drain|complete|contract ...   ... capacity policy|mode ...   ... http policy|mode ...   ... batch policy|contract|drain|complete ...
 * 전환 명령은 기대 현재 상태·--operator·--reason이 필수이고 기본 dry-run(읽기 전용, DB 쓰기 0)이다. --execute일 때만 쓴다.
 * DB URL은 환경변수로만 받는다(argv·출력에 쓰지 않음). exit 0=완료·허용, 3=거절(아무것도 쓰지 않음), 1=오류(stderr에 고정 code만). */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatControlResult, formatControlStatus, formatPipelineControlError, parsePipelineControlArgs,
  pipelineControlDatabaseUrl, type ControlOptions, type ModelEnv } from "@/lib/operations/pipeline-control";

const POLICY_FILE_LIMIT = 64 * 1024;
async function readPolicy(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > POLICY_FILE_LIMIT) throw new Error("pipeline_control_invalid_policy_file");
    try { return JSON.parse((await file.readFile()).toString("utf8")) as unknown; }
    catch { throw new Error("pipeline_control_invalid_policy_file"); }
  } finally { await file.close(); }
}

/** 호출 지점과 같은 상수·함수로 이 프로세스 env를 읽는다. 그 역할과 같은 model env로 실행해야 route 판정이 맞다. */
async function currentModelEnv(): Promise<ModelEnv> {
  const [{ reviewModel }, { TRANSLATE_MODEL }, { TAGLINE_MODEL }, { PROFILE_MODEL }, { VERIFY_MODEL }, { INTRO_CHECK_MODEL }] = await Promise.all([
    import("@/lib/crawl/agent-review"), import("@/lib/crawl/translate"), import("@/lib/crawl/tagline"),
    import("@/lib/domain/products/search-profile"), import("@/lib/domain/products/search-verify"), import("@/lib/domain/products/intro-check")]);
  return { crawlReview: reviewModel(), translate: TRANSLATE_MODEL, tagline: TAGLINE_MODEL, profile: PROFILE_MODEL, verify: VERIFY_MODEL,
    introCheck: INTRO_CHECK_MODEL };
}

export async function pipelineControlMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  const command = parsePipelineControlArgs(args);
  const url = pipelineControlDatabaseUrl(env);
  const file = command.name !== "status" ? (command.options as Partial<ControlOptions>).file : undefined;
  const policy = file ? await readPolicy(file) : undefined;
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, repository, models] = await Promise.all([import("drizzle-orm/postgres-js"),
    import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/operations/pipeline-control-repository"), currentModelEnv()]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:pipeline-control" });
  const database = drizzle(client, { schema });
  try {
    if (command.name === "status") {
      const snapshot = await repository.readControlSnapshot(database);
      write(command.json ? `${JSON.stringify({ command: "status", snapshot })}\n` : formatControlStatus(snapshot, models));
      return 0;
    }
    const result = await repository.runPipelineControl(database, command, policy, models);
    write(command.json ? `${JSON.stringify(result)}\n` : formatControlResult(result));
    return result.blocked ? 3 : 0;
  } finally { await client.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void pipelineControlMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${JSON.stringify({ code: formatPipelineControlError(error) })}\n`);
    process.exitCode = 1;
  });
}
