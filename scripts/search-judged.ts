/**
 * 검색 정답 평가 — 정답을 아는 질의로 "그 제품이 몇 등에 오는가"를 잰다.
 *
 * search-eval.ts 는 건수와 상위 5개를 눈으로 보는 도구다. 이것은 숫자로 비교한다: 1등·5등 안·10등 안에
 * 든 비율, MRR(정답 순위의 역수 평균), 0건 비율, 한 질의에 걸린 시간. 검색을 고치기 전과 후에 같은
 * DB 에서 같은 질의로 돌려 비교한다.
 *
 * 정답은 2026-09-23 프로드 공개분에서 내용을 직접 확인한 제품이다. 질의에는 제품 이름을 쓰지 않는다 —
 * 사람들은 이름이 아니라 하려는 일로 찾는다. 한국어 질의는 화면처럼 번역을 거친다(캐시 → 게이트웨이).
 *
 *   tsx scripts/search-judged.ts [--out=결과.json]
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import type { ProductStatus } from "@/lib/db/schema";
import { countProducts, listProducts } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";

const JUDGED: [query: string, slug: string][] = [
  // 페이지는 비고 README 만 있는 제품 — README 를 색인하면 달라져야 한다
  ["grocery shopping list offline", "coche"], ["장보기 목록 앱", "coche"],
  ["accessible public toilet map", "restroom-map"], ["휠체어 화장실 지도", "restroom-map"],
  ["plant disease detection", "smartspray"], ["식물 병 진단", "smartspray"],
  ["japanese vocabulary flashcards", "product-589"], ["일본어 단어장", "product-589"],
  ["gym workout log", "opengym"], ["헬스 운동 기록", "opengym"],
  ["internship certificate management", "web-portal"], ["인턴십 관리", "web-portal"],
  ["coding agent cost tracking", "agentacct"], ["코딩 에이전트 비용 추적", "agentacct"],
  ["python sdk image video generation api", "venice-ai-python-sdk"],
  ["multi agent orchestration cli", "cascade-cloud"],
  ["grinding wheel compatibility check", "wheelmatch-ai"], ["숫돌 호환 확인", "wheelmatch-ai"],
  // 소개는 한 줄, 페이지 본문은 풍부
  ["supply chain risk monitoring", "chainsilience-ai"], ["공급망 위험 모니터링", "chainsilience-ai"],
  ["adopt a rescued dog", "hope-for-strays"], ["유기견 입양", "hope-for-strays"],
  ["inspect mcp traffic in vscode", "mcp-shark-viewer-vscode"], ["MCP 트래픽 확인", "mcp-shark-viewer-vscode"],
  ["imdb tv show ratings history", "tv-shows-chart"], ["드라마 평점 차트", "tv-shows-chart"],
  ["whois dns lookup", "whodis"], ["도메인 조회", "whodis"],
  ["algorithmic copy trading", "w2w"],
  ["open banking claude mcp", "bankmcp-2"], ["은행 잔액 확인 AI", "bankmcp-2"],
  ["dhikr counter", "zikirci"], ["이슬람 기도 카운터", "zikirci"],
  ["tech job search", "freehire"], ["개발자 채용 공고 검색", "freehire"],
  ["post to x from coding agent", "capx-cafe"], ["트위터 자동 게시", "capx-cafe"],
  ["order from local farms", "farmerzone"], ["농산물 직거래", "farmerzone"],
  ["slack bot node", "node-slack-sdk"], ["슬랙 봇 만들기", "node-slack-sdk"],
  ["commercial filming middle east", "film-video-production-egypt"],
  ["provision grafana cloud stacks", "grafana-cloud-vending-machine"],
  // 한국어 제품
  ["korea study abroad visa", "product-35"], ["한국 유학 준비", "product-35"],
  ["short form video trends", "pulse"], ["숏폼 트렌드", "pulse"],
  ["football club manager game", "club-season"], ["축구 매니저 게임", "club-season"],
  ["interior design quote comparison", "product-63"], ["인테리어 견적", "product-63"],
  ["medicine side effects lookup", "yoyak"], ["약 부작용 확인", "yoyak"],
  ["algorithm study group", "ssafy-16-4"],
  // 모든 글이 얇은 제품
  ["chess roguelike", "rookies-revenge"], ["체스 게임", "rookies-revenge"],
  ["lab results pdf", "labledger"], ["daycare management", "daycare-portal"], ["어린이집 관리", "daycare-portal"],
  ["focus app task world", "lorestead"],
];

const PUBLIC: ProductStatus[] = ["seeded", "verified"];
const DEPTH = 20;

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const results: { query: string; slug: string; rank: number | null; hits: number; translated: string | null; ms: number }[] = [];
  for (const [query, slug] of JUDGED) {
    const started = Date.now();
    const resolved = await resolveSearchQuery(query);
    const options = { statuses: PUBLIC, query: resolved.queries, excludeDown: true };
    const [hits, rows] = await Promise.all([countProducts(options), listProducts({ ...options, sort: "relevance", limit: DEPTH })]);
    const index = rows.findIndex((row) => row.slug === slug);
    results.push({ query, slug, rank: index >= 0 ? index + 1 : null, hits, translated: resolved.translated, ms: Date.now() - started });
    const r = results.at(-1)!;
    console.log(`${String(r.rank ?? "-").padStart(3)}위  ${String(hits).padStart(5)}건  ${String(r.ms).padStart(5)}ms  ${query}${r.translated ? `  → ${r.translated}` : ""}`);
  }
  const n = results.length;
  const within = (k: number) => results.filter((r) => r.rank !== null && r.rank <= k).length;
  const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    queries: n, top1: within(1), top5: within(5), top10: within(10), top20: within(20),
    mrr: Number(mrr.toFixed(3)), zero: results.filter((r) => r.hits === 0).length,
    medianHits: results.map((r) => r.hits).sort((a, b) => a - b)[Math.floor(n / 2)],
    p50Ms: ms[Math.floor(n / 2)], p95Ms: ms[Math.floor(n * 0.95)],
  };
  console.log(`\n1위 ${summary.top1}/${n} · 5위 안 ${summary.top5} · 10위 안 ${summary.top10} · 20위 안 ${summary.top20} · MRR ${summary.mrr}`
    + ` · 0건 ${summary.zero} · 결과 수 중앙 ${summary.medianHits} · p50 ${summary.p50Ms}ms · p95 ${summary.p95Ms}ms`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ summary, results }, null, 1));
  process.exit(0);
}
main();
