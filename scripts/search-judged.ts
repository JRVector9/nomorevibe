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
 * 정답 하나만 세면 "정답만큼 맞는 다른 제품"이 위에 와도 실패가 된다(도메인 조회 → domainstack, gym workout log →
 * 운동 기록 앱 16개). 그래서 질의마다 후보 제품에 적합도를 매겨 둔 것(search-judgments.json — 2 찾는 바로 그것,
 * 1 받아들일 만함, 0 아님)으로 nDCG@10·5위 안 적합 비율·1위 적합도 함께 잰다. 매기지 않은 제품이 상위 10에 들면
 * 그 수를 따로 보인다 — 새 검색 방식이 처음 보는 제품을 올리면 채점을 보태야 한다는 뜻이다.
 *
 * 정답이 20위 밖이면 200위까지 더 보아 "후보에는 있는데 순위가 낮음"과 "아예 안 걸림"을 가른다.
 *
 * 기본은 화면의 관련도순 검색과 같은 길이다(relevance.ts — 낱말 + 의미 검색을 섞고 앞 30 재정렬, 번역은 캐시에 있을 때만).
 * --fts 는 그 전의 낱말 검색만(번역을 기다림), --no-translation 은 옮겨 둔 번역도 쓰지 않는다(처음 들어온 한국어 문장).
 * 의미 검색·재정렬은 EMBEDDING_URL·RERANK_URL 이 있어야 돈다 — 없으면 낱말 검색으로 내므로 결과 줄의 [의미·재정렬] 표시를 본다.
 *
 *   tsx scripts/search-judged.ts [--out=결과.json] [--fts] [--no-translation]
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProductStatus } from "@/lib/db/schema";
import { countProducts, listProducts } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";
import { relevanceWindow, searchRelevance } from "@/lib/domain/products/relevance";

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
/** 정답이 20위 밖일 때 어디까지 더 보나 — 후보에 있는지 가른다 */
const DIAGNOSE_DEPTH = 200;
const JUDGMENTS_FILE = path.join(__dirname, "search-judgments.json");

/** 질의 → 제품 → 적합도(0·1·2) */
type Judgments = Record<string, Record<string, number>>;
const gain = (grade: number) => 2 ** grade - 1;
/** nDCG@k — 매기지 않은 제품은 0 으로 센다(그래서 unjudged 를 따로 보인다) */
function ndcg(grades: readonly number[], ideal: readonly number[], k: number): number {
  const dcg = (list: readonly number[]) => list.slice(0, k).reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);
  const best = dcg([...ideal].sort((a, b) => b - a));
  return best ? dcg(grades) / best : 0;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, fts: { type: "boolean" }, "no-translation": { type: "boolean" } } });
  const judgments: Judgments = existsSync(JUDGMENTS_FILE) ? JSON.parse(readFileSync(JUDGMENTS_FILE, "utf8")) : {};
  const results: {
    query: string; slug: string; rank: number | null; deepRank: number | null; hits: number; translated: string | null; ms: number;
    semantic?: boolean; reranked?: boolean;
    ndcg10?: number; relevantTop5?: number; top1Grade?: number | null; unjudgedTop10?: number;
  }[] = [];
  for (const [query, slug] of JUDGED) {
    const started = Date.now();
    const resolved = values["no-translation"] ? { queries: [query], translated: null, translationPending: false }
      : await resolveSearchQuery(query, { waitForTranslation: Boolean(values.fts) });
    const options = { statuses: PUBLIC, query: resolved.queries, excludeDown: true };
    let hits: number, rows: { slug: string }[], deepen: () => Promise<{ slug: string }[]>, mode: { semantic?: boolean; reranked?: boolean } = {};
    if (values.fts) {
      [hits, rows] = await Promise.all([countProducts(options), listProducts({ ...options, sort: "relevance", limit: DEPTH })]);
      deepen = () => listProducts({ ...options, sort: "relevance", limit: DIAGNOSE_DEPTH });
    } else {
      // 화면과 같은 길 — 원문으로 0건이면 번역을 기다려 다시(--no-translation 이면 다시 찾지 않는다)
      const ranked = await searchRelevance(query, resolved, {}, () => values["no-translation"]
        ? Promise.resolve(resolved) : resolveSearchQuery(query, { waitForTranslation: true }));
      hits = ranked.total;
      rows = (await relevanceWindow(ranked, ranked.plan, {}, 0, DEPTH)).map((slug) => ({ slug }));
      deepen = async () => (await relevanceWindow(ranked, ranked.plan, {}, 0, DIAGNOSE_DEPTH)).map((slug) => ({ slug }));
      mode = { semantic: ranked.semantic, reranked: ranked.reranked };
    }
    const ms = Date.now() - started;
    const index = rows.findIndex((row) => row.slug === slug);
    // 20위 밖이면 더 깊이 — 시간에는 넣지 않는다(화면은 이만큼 보지 않는다)
    const deep = index >= 0 ? index : (await deepen()).findIndex((row) => row.slug === slug);
    const judged = judgments[query];
    const graded = judged ? {
      ndcg10: ndcg(rows.map((row) => judged[row.slug] ?? 0), Object.values(judged), 10),
      relevantTop5: rows.slice(0, 5).filter((row) => (judged[row.slug] ?? 0) >= 1).length,
      top1Grade: rows[0] ? judged[rows[0].slug] ?? null : null,
      unjudgedTop10: rows.slice(0, 10).filter((row) => !(row.slug in judged)).length,
    } : {};
    results.push({ query, slug, rank: index >= 0 ? index + 1 : null, deepRank: deep >= 0 ? deep + 1 : null, hits, translated: resolved.translated, ms, ...mode, ...graded });
    const r = results.at(-1)!;
    const where = r.rank ? `${r.rank}위` : r.deepRank ? `(${r.deepRank}위)` : "후보 없음";
    const flags = values.fts ? "" : `[${r.semantic ? "의미" : "-"}·${r.reranked ? "재정렬" : "-"}] `;
    console.log(`${where.padStart(8)}  ${String(hits).padStart(5)}건  ${String(ms).padStart(5)}ms  ${flags}${r.ndcg10 !== undefined ? `nDCG ${r.ndcg10.toFixed(2)}  ` : ""}${query}${r.translated ? `  → ${r.translated}` : ""}`);
  }
  const n = results.length;
  const within = (k: number) => results.filter((r) => r.rank !== null && r.rank <= k).length;
  const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const gradedRows = results.filter((r) => r.ndcg10 !== undefined);
  const avg = (pick: (r: (typeof results)[number]) => number) => gradedRows.length ? gradedRows.reduce((sum, r) => sum + pick(r), 0) / gradedRows.length : 0;
  const summary = {
    queries: n, top1: within(1), top5: within(5), top10: within(10), top20: within(20),
    mrr: Number(mrr.toFixed(3)), zero: results.filter((r) => r.hits === 0).length,
    medianHits: results.map((r) => r.hits).sort((a, b) => a - b)[Math.floor(n / 2)],
    p50Ms: ms[Math.floor(n / 2)], p95Ms: ms[Math.floor(n * 0.95)],
    // 정답이 20위 밖인 것 중 후보(200위 안)에는 있는 것과 아예 안 걸린 것
    outside20InPool: results.filter((r) => r.rank === null && r.deepRank !== null).length,
    notMatched: results.filter((r) => r.deepRank === null).length,
    graded: gradedRows.length,
    ndcg10: Number(avg((r) => r.ndcg10!).toFixed(3)),
    relevantTop5: Number(avg((r) => r.relevantTop5! / 5).toFixed(3)),
    top1Relevant: gradedRows.filter((r) => (r.top1Grade ?? 0) >= 1).length,
    top1Exact: gradedRows.filter((r) => r.top1Grade === 2).length,
    unjudgedTop10: gradedRows.reduce((sum, r) => sum + r.unjudgedTop10!, 0),
  };
  console.log(`\n1위 ${summary.top1}/${n} · 5위 안 ${summary.top5} · 10위 안 ${summary.top10} · 20위 안 ${summary.top20} · MRR ${summary.mrr}`
    + ` · 0건 ${summary.zero} · 결과 수 중앙 ${summary.medianHits} · p50 ${summary.p50Ms}ms · p95 ${summary.p95Ms}ms`);
  console.log(`정답이 20위 밖: 후보에는 있음 ${summary.outside20InPool} · 아예 안 걸림 ${summary.notMatched}`);
  if (summary.graded) console.log(`다중 정답(${summary.graded}개 질의): nDCG@10 ${summary.ndcg10} · 5위 안 적합 비율 ${summary.relevantTop5}`
    + ` · 1위가 적합 ${summary.top1Relevant} (딱 맞음 ${summary.top1Exact}) · 상위 10의 미채점 ${summary.unjudgedTop10}`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ summary, results }, null, 1));
  process.exit(0);
}
main();
