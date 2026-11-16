/**
 * 과다 호출 차단(lib/http/crawl-burst.ts) 운영 CLI — 운영자만, 운영 DB 에는 명시 승인 뒤에만 쓴다.
 *
 *   npx tsx scripts/crawl-burst.ts status
 *     지금 설정(기준 수·창·차단 시간)과 지금 막힌 IP 수·창 안에서 세는 IP 수(읽기 전용)
 *   npx tsx scripts/crawl-burst.ts set <기준 수> <창 초> <차단 초> <actor>
 *     runtime_settings publicApi.burst* 저장(검증·operations_audit runtime-settings-save). 웹은 30초 안에 읽는다 — 재배포 없음. 기준 수 0 = 끔
 *   npx tsx scripts/crawl-burst.ts set detail <읽기 수> <읽기 창 초> <차단 번째> <차단 창 초> <actor>
 *     상세 세 경로의 IP 합산 기준. 기본 60/600초, 20번째/10초. 각 limit 0 = 끔
 *   npx tsx scripts/crawl-burst.ts release <ip> <actor>
 *     그 IP 의 차단을 바로 푼다 + operations_audit `crawl-burst-release` 한 줄
 */
import { pathToFileURL } from "node:url";
import { crawlBurstStatus, releaseCrawlBurst, saveCrawlBurstSettings } from "@/lib/operations/crawl-burst-ops";

export async function runCrawlBurstCommand(argv: string[]) {
  const [command, ...args] = argv;
  if (command === "status" && args.length === 0) return crawlBurstStatus();
  if (command === "set" && args.length === 4) {
    const [burstLimit, burstWindowSeconds, burstBlockSeconds] = args.slice(0, 3).map(Number);
    const result = await saveCrawlBurstSettings({ burstLimit, burstWindowSeconds, burstBlockSeconds }, args[3]);
    if (!result.ok) throw new Error(result.issues.join(","));
    return { burstLimit, burstWindowSeconds, burstBlockSeconds, revision: result.revision };
  }
  if (command === "set" && args[0] === "detail" && args.length === 6) {
    const [detailReadLimit, detailReadWindowSeconds, detailBurstLimit, detailBurstWindowSeconds] = args.slice(1, 5).map(Number);
    const patch = { detailReadLimit, detailReadWindowSeconds, detailBurstLimit, detailBurstWindowSeconds };
    const result = await saveCrawlBurstSettings(patch, args[5]);
    if (!result.ok) throw new Error(result.issues.join(","));
    return { ...patch, revision: result.revision };
  }
  if (command === "release" && args.length === 2) return releaseCrawlBurst(args[0], args[1]);
  throw new Error("usage: crawl-burst.ts status | set <limit> <windowSeconds> <blockSeconds> <actor> | set detail <readLimit> <readWindowSeconds> <burstLimit> <burstWindowSeconds> <actor> | release <ip> <actor>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCrawlBurstCommand(process.argv.slice(2)).then((result) => { console.log(JSON.stringify(result)); process.exit(0); },
  (error) => { console.error(`crawl_burst_cli_failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
