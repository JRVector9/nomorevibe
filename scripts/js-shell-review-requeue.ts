/**
 * 2차 갈림 보류 중 JS 앱 껍데기(화면 글자가 제목·로딩 문구뿐)를 다시 심사로 보내는 운영 CLI(lib/crawl/js-shell-requeue.ts) — 운영 DB 에는 명시 승인 뒤에만 쓴다.
 *
 *   npx tsx scripts/js-shell-review-requeue.ts count
 *     읽기 전용. 2차 갈림 보류 수, 그중 껍데기 수(꼴별·그린 상태별)
 *   npx tsx scripts/js-shell-review-requeue.ts dry-run [--limit <1~1000>]
 *     읽기 전용. apply 가 고를 차례 그대로 앞의 limit 건(기본 30)
 *   npx tsx scripts/js-shell-review-requeue.ts apply <최대 건수 1~1000> <actor> [--no-render] [--interval-ms <ms>]
 *     기본은 화면 서버로 먼저 그려(SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN 필요 — reviewer 컨테이너에서) 뜻있게 그린 것만 되돌린다.
 *     --no-render 는 그리지 않고 되돌린다(1차가 그 자리에서 그린다). 되돌린 후보는 규칙 재판정 → 1차 → 2차를 다시 지난다.
 *     operations_audit `js-shell-review-requeue` 한 줄
 *
 * 운영 DB(PgBouncer)로 돌릴 때는 DB_POOLER_MODE=pgbouncer 를 붙인다.
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyJsShellRequeue, countJsShellRequeue, dryRunJsShellRequeue } from "@/lib/crawl/js-shell-requeue";

export async function runJsShellReviewRequeue(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { limit: { type: "string" }, "no-render": { type: "boolean" }, "interval-ms": { type: "string" } } });
  const [command, ...args] = positionals;
  if (command === "count" && args.length === 0 && !values.limit && !values["no-render"] && !values["interval-ms"]) return countJsShellRequeue();
  if (command === "dry-run" && args.length === 0 && !values["no-render"] && !values["interval-ms"])
    return dryRunJsShellRequeue({ limit: values.limit === undefined ? 30 : Number(values.limit) });
  if (command === "apply" && args.length === 2 && !values.limit) {
    const intervalMs = values["interval-ms"] === undefined ? 1_000 : Number(values["interval-ms"]);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error("js_shell_requeue_invalid_interval");
    return applyJsShellRequeue({ limit: Number(args[0]), actor: args[1], render: !values["no-render"], intervalMs });
  }
  throw new Error("usage: js-shell-review-requeue.ts count | dry-run [--limit <n>] | apply <limit> <actor> [--no-render] [--interval-ms <ms>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runJsShellReviewRequeue(process.argv.slice(2)).then((result) => {
  console.log(JSON.stringify(result)); process.exit(0);
}, (error) => { console.error(`js_shell_review_requeue_failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
