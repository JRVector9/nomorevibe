/** Qwen-v2 자동 단계 하나를 켜고 끈다 — 화면 없이(운영 승인을 받은 뒤). 화면과 같은 setter(lib/crawl/settings.ts setQwenAutoStep)를 지난다:
 * 지금 값과 견주는 compare-and-set, 켤 때 꼭 받는 사유, 같은 트랜잭션의 작업 로그(operations_audit qwen-auto-settings, 누가 ops:<이름>).
 *   QWEN_AUTO_DATABASE_URL=... node --import tsx scripts/ops/set-qwen-auto.ts --step=<단계> --enable|--disable [--per-tick=N] [--budget-seconds=N]
 *     [--daily-reject-cap=N] --reason="왜" [--by=<이름>] [--dry-run]
 * 단계: auditSecondOpinion(감사 두 번째 의견)·publishedFilter(공개분 2차 거르기)·splitTiebreak(갈림 판가름, --daily-reject-cap 도 — 하루 KST
 * 자동 거부 상한)·heldRetry(보류 재심사, --budget-seconds 도). --enable·--disable 없이 수만 주면 켬/끔은 그대로 둔다. --dry-run 은 읽기 전용 트랜잭션에서 같은 검사만 하고 쓰지 않는다.
 * DB URL 은 환경변수로만 받는다(argv·출력에 쓰지 않음). 출력은 단계·전/후 값·거절 까닭뿐이다. exit 0=바꿈(또는 dry-run 통과), 1=오류·거절. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { QwenAutoStep } from "@/lib/crawl/settings-schema";

const STEPS = ["auditSecondOpinion", "publishedFilter", "splitTiebreak", "heldRetry"] as const satisfies readonly QwenAutoStep[];
const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;

export type SetQwenAutoCommand = { step: QwenAutoStep; enable: boolean | null; perTick: number | null; budgetSeconds: number | null;
  dailyRejectCap: number | null; reason: string | null; by: string; dryRun: boolean };

const value = (args: readonly string[], name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const count = (raw: string | undefined) => {
  if (raw === undefined) return null;
  if (!/^\d{1,3}$/.test(raw)) throw new Error("qwen_auto_invalid_number");
  return Number(raw);
};

export function parseSetQwenAutoArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): SetQwenAutoCommand {
  const known = ["--enable", "--disable", "--dry-run"];
  const named = ["step", "per-tick", "budget-seconds", "daily-reject-cap", "reason", "by"];
  const unknown = args.filter((arg) => !known.includes(arg) && !named.some((name) => arg.startsWith(`--${name}=`)));
  if (unknown.length) throw new Error("qwen_auto_usage");
  const step = value(args, "step");
  if (!step || !(STEPS as readonly string[]).includes(step)) throw new Error("qwen_auto_unknown_step");
  if (args.includes("--enable") && args.includes("--disable")) throw new Error("qwen_auto_usage");
  const enable = args.includes("--enable") ? true : args.includes("--disable") ? false : null;
  const perTick = count(value(args, "per-tick"));
  const budgetSeconds = count(value(args, "budget-seconds"));
  const dailyRejectCap = count(value(args, "daily-reject-cap"));
  if (budgetSeconds !== null && step !== "heldRetry") throw new Error("qwen_auto_usage");
  if (dailyRejectCap !== null && step !== "splitTiebreak") throw new Error("qwen_auto_usage");
  if (enable === null && perTick === null && budgetSeconds === null && dailyRejectCap === null) throw new Error("qwen_auto_nothing_to_change");
  const by = (value(args, "by") ?? env.USER ?? "cli").trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(by)) throw new Error("qwen_auto_invalid_by");
  return { step: step as QwenAutoStep, enable, perTick, budgetSeconds, dailyRejectCap, reason: value(args, "reason")?.trim() || null, by, dryRun: args.includes("--dry-run") };
}

export async function setQwenAutoMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = (line) => { process.stdout.write(line); }): Promise<number> {
  const command = parseSetQwenAutoArgs(args, env);
  const url = env.QWEN_AUTO_DATABASE_URL;
  if (!url) throw new Error("explicit_QWEN_AUTO_DATABASE_URL_required");
  if (OVERRIDES.some((key) => Boolean(env[key]))) throw new Error("database_override_rejected");
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, { setQwenAutoStep, storedQwenAuto }, { eq }] = await Promise.all([
    import("drizzle-orm/postgres-js"), import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/crawl/settings"), import("drizzle-orm")]);
  const client = createDbClient(url, { ...dbPoolConfig({ WORKER_ROLE: "maintenance", DB_POOLER_MODE: env.DB_POOLER_MODE, DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:set-qwen-auto" });
  try {
    const database = drizzle(client, { schema });
    const [row] = await database.select({ values: schema.crawlSettings.values }).from(schema.crawlSettings).where(eq(schema.crawlSettings.id, 1));
    const expected = storedQwenAuto(row?.values)[command.step];
    const next = { ...expected, ...(command.enable === null ? {} : { enabled: command.enable }),
      ...(command.perTick === null ? {} : { perTick: command.perTick }), ...(command.budgetSeconds === null ? {} : { budgetSeconds: command.budgetSeconds }),
      ...(command.dailyRejectCap === null ? {} : { dailyRejectCap: command.dailyRejectCap }) };
    const result = await setQwenAutoStep({ step: command.step, next: next as never, expected: expected as never, actor: `ops:${command.by}`,
      reason: command.reason, actorKind: "token", dryRun: command.dryRun, database: database as never });
    write(`${JSON.stringify(result.ok ? { command: "set-qwen-auto", step: command.step, dryRun: command.dryRun, ok: true, before: result.before, after: result.after }
      : { command: "set-qwen-auto", step: command.step, dryRun: command.dryRun, ok: false, before: expected, issues: result.issues })}\n`);
    return result.ok ? 0 : 1;
  } finally { await client.end({ timeout: 5 }); }
}

/** 고정 code 만 출력한다. URL·SQL·stack 은 쓰지 않는다 */
function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "qwen_auto_failed";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void setQwenAutoMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${JSON.stringify({ code: errorCode(error) })}\n`);
    process.exitCode = 1;
  });
}
