export const JUDGED: readonly (readonly [query: string, slug: string])[] = [
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

const gain = (grade: number) => 2 ** grade - 1;
/** nDCG@k — 매기지 않은 제품은 0 으로 센다(그래서 unjudged 를 따로 보인다) */
export function ndcg(grades: readonly number[], ideal: readonly number[], k: number): number {
  const dcg = (list: readonly number[]) => list.slice(0, k).reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);
  const best = dcg([...ideal].sort((a, b) => b - a));
  return best ? dcg(grades) / best : 0;
}
