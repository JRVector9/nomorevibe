/**
 * README 없이 1차 판단 보류가 된 후보에 README 를 붙이는 운영 CLI(lib/crawl/review-readme-backfill.ts) — 운영 DB 에는 명시 승인 뒤에만 쓴다.
 *
 *   npx tsx scripts/review-readme-backfill.ts count
 *     읽기 전용. 대상 수(설치형·주소 있음)와 README 받기 실패가 적힌 수
 *   npx tsx scripts/review-readme-backfill.ts apply <최대 건수 1~1000> <actor> [--with-url] [--interval-ms <ms>]
 *     README 를 받아 원본에 붙인다(raw.githubusercontent.com 최대 4회/건, GitHub API 0회). 붙은 후보는 다음 1차 틱이 다시 심사한다.
 *     기본은 설치형(주소 없음)만, 간격 1000ms. operations_audit `review-readme-backfill` 한 줄
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyReviewReadmeBackfill, countReviewReadmeBackfill } from "@/lib/crawl/review-readme-backfill";

export async function runReviewReadmeBackfill(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { "with-url": { type: "boolean" }, "interval-ms": { type: "string" } } });
  const [command, ...args] = positionals;
  if (command === "count" && args.length === 0 && !values["with-url"] && !values["interval-ms"]) return countReviewReadmeBackfill();
  if (command === "apply" && args.length === 2) {
    const intervalMs = values["interval-ms"] === undefined ? 1_000 : Number(values["interval-ms"]);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error("review_readme_backfill_invalid_interval");
    return applyReviewReadmeBackfill({ limit: Number(args[0]), actor: args[1], withUrl: values["with-url"] ?? false, intervalMs });
  }
  throw new Error("usage: review-readme-backfill.ts count | apply <limit> <actor> [--with-url] [--interval-ms <ms>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runReviewReadmeBackfill(process.argv.slice(2)).then((result) => {
  console.log(JSON.stringify(result)); process.exit(0);
}, (error) => { console.error(`review_readme_backfill_failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
