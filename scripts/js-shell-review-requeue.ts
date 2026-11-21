/**
 * 2차 갈림 보류 중 JS 앱 껍데기(화면 글자가 제목·로딩 문구뿐)를 다시 심사로 보내는 운영 CLI(lib/crawl/js-shell-requeue.ts) — 운영 DB 에는 명시 승인 뒤에만 쓴다.
 *
 *   npx tsx scripts/js-shell-review-requeue.ts count
 *     읽기 전용. 2차 갈림 보류 수, 그중 껍데기 수(꼴별·그린 상태별), 이미 그린 수, 그리지 않고 되돌릴 수 있는 수,
 *     그리기 스위치(실시간 한도 jobs.crawl-agent-review.shellRender — on/off/unreadable)·화면 서버 설정 여부(값은 찍지 않는다), 상태 설명
 *   npx tsx scripts/js-shell-review-requeue.ts dry-run [--limit <1~1000>]
 *     읽기 전용. count 에 더해 apply 가 고를 차례 그대로 앞의 limit 건(기본 30, 그리지 않고 되돌릴 때 빠질지)과 apply 상한
 *   npx tsx scripts/js-shell-review-requeue.ts apply <최대 건수 1~1000> <actor> [--no-render] [--interval-ms <0~60000>] [--batch <1~100>]
 *     기본은 화면 서버로 먼저 그려(SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN 필요 — reviewer 컨테이너에서) 뜻있게 그린 것만 되돌린다.
 *     그리기 사이 --interval-ms(기본 2000), --batch 건(기본 25)마다 한 커밋·operations_audit `js-shell-review-requeue` 한 줄(같은 runId, 마지막 줄 final).
 *     화면 서버 탈·붐빔으로 3건 이어 미루면 멈춘다(stoppedEarly). 그리기 스위치가 꺼져 있으면 거절한다.
 *     --no-render 는 그리지 않고 되돌린다(1차가 그 자리에서 그린다). 되돌린 후보는 규칙 재판정 → 1차 → 2차를 다시 지난다.
 *
 * 운영 DB(PgBouncer)로 돌릴 때는 DB_POOLER_MODE=pgbouncer 를 붙인다.
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyJsShellRequeue, countJsShellRequeue, dryRunJsShellRequeue } from "@/lib/crawl/js-shell-requeue";

const integer = (raw: string | undefined, fallback: number | undefined, error: string) => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(error);
  return value;
};

export async function runJsShellReviewRequeue(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { limit: { type: "string" }, "no-render": { type: "boolean" }, "interval-ms": { type: "string" }, batch: { type: "string" } } });
  const [command, ...args] = positionals;
  const applyOnly = values["no-render"] || values["interval-ms"] !== undefined || values.batch !== undefined;
  if (command === "count" && args.length === 0 && values.limit === undefined && !applyOnly) return countJsShellRequeue();
  if (command === "dry-run" && args.length === 0 && !applyOnly)
    return dryRunJsShellRequeue({ limit: integer(values.limit, 30, "js_shell_requeue_invalid_limit")! });
  if (command === "apply" && args.length === 2 && values.limit === undefined) {
    return applyJsShellRequeue({ limit: Number(args[0]), actor: args[1], render: !values["no-render"],
      intervalMs: integer(values["interval-ms"], undefined, "js_shell_requeue_invalid_interval"),
      batch: integer(values.batch, undefined, "js_shell_requeue_invalid_batch") });
  }
  throw new Error("usage: js-shell-review-requeue.ts count | dry-run [--limit <n>] | apply <limit> <actor> [--no-render] [--interval-ms <ms>] [--batch <n>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runJsShellReviewRequeue(process.argv.slice(2)).then((result) => {
  console.log(JSON.stringify(result, null, 2)); process.exit(0);
}, (error) => { console.error(`js_shell_review_requeue_failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
