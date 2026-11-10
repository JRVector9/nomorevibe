/** 사람 몫 위임 검수의 확신 문턱 미리보기(lib/operations/delegate-threshold-preview.ts) — 읽기만 한다(복제본 우선·읽기 전용 TX·문장 5초).
 * DB 는 환경의 DATABASE_URL(READ_DATABASE_URL 이 있으면 복제본)로 붙는다. 프로드 PgBouncer 로 붙을 때는 DB_POOLER_MODE=pgbouncer 를 함께 준다.
 * 쓰기: npx tsx scripts/ops/delegate-threshold-preview.ts [--hours=24]  → 결과 JSON 을 stdout 에 쓴다. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DELEGATE_THRESHOLD_MAX_HOURS, readDelegateThresholdPreview } from "@/lib/operations/delegate-threshold-preview";

export function parseDelegateThresholdArgs(args: readonly string[]): { hours: number } {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: { hours: { type: "string" } } });
  const hours = values.hours === undefined ? 24 : Number(values.hours);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > DELEGATE_THRESHOLD_MAX_HOURS) throw new Error("delegate_threshold_preview_invalid_hours");
  return { hours };
}

export async function delegateThresholdPreviewMain(args: readonly string[]): Promise<void> {
  const { hours } = parseDelegateThresholdArgs(args);
  if (!process.env.DATABASE_URL) throw new Error("delegate_threshold_preview_database_required");
  process.stdout.write(JSON.stringify(await readDelegateThresholdPreview(hours), null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 오류는 메시지 첫 줄만 JSON 으로 — 쌓인 호출 경로·드라이버 상세는 내보내지 않는다
  delegateThresholdPreviewMain(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const code = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "delegate_threshold_preview_failed";
    process.stderr.write(JSON.stringify({ code }) + "\n");
    process.exit(1);
  });
}
