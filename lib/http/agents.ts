/**
 * 요청한 프로그램 분류 — User-Agent 만 본다(머리는 누구나 꾸밀 수 있으므로 값싼 첫 거름망일 뿐이다).
 *
 * 사람 확정 정책(2026-11-14): 학습용 AI 봇은 막고, 검색 엔진·AI 검색/답변용 봇은 허용한다.
 *  - "tool": 수집 도구·HTTP 라이브러리·헤드리스 브라우저(curl, python-requests, Scrapy, HeadlessChrome …)
 *  - "training": 학습 데이터 수집 봇(GPTBot, ClaudeBot, CCBot, Bytespider …)
 *  - "search": 검색 엔진·AI 검색/답변 봇(이름을 댄 것뿐 — 진짜인지는 search-bot-verify.ts 가 따로 확인한다)
 *  - "missing": User-Agent 가 없거나 비었다
 *  - "other": 그 밖(일반 브라우저 등)
 *
 * 우리 스킬(skill/SKILL.md)은 curl 로 부르되 `nomorevibe-skill/<버전>` 을 붙인다 — "skill" 로 따로 둔다.
 * 이 이름도 꾸밀 수 있지만 브라우저 이름을 꾸미는 것과 같은 수준이고, 읽기 한도와 함정 차단은 그대로 받는다.
 */
export type AgentKind = "tool" | "training" | "search" | "skill" | "missing" | "other";

/** 학습용 수집 봇. Claude-User·Claude-SearchBot 은 아래 검색 목록이라 ClaudeBot 과 겹치지 않게 단어 경계를 둔다 */
const TRAINING_AGENT = /\b(?:GPTBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Bytespider|Google-Extended|Applebot-Extended|meta-externalagent|meta-externalfetcher|FacebookBot|Diffbot|Omgilibot|omgili|cohere-ai|cohere-training-data-crawler|ImagesiftBot|Timpibot|AI2Bot|Ai2Bot-Dolma|PanguBot|Kangaroo Bot|Amazonbot|img2dataset|Webzio-Extended|DeepSeekBot|SBIntuitionsBot)\b/i;

/** 검색 엔진과 AI 검색·답변(사용자가 시킨 열람) 봇 */
const SEARCH_AGENT = /\b(?:OAI-SearchBot|ChatGPT-User|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|Googlebot(?:-Image|-News|-Video)?|Google-InspectionTool|bingbot|BingPreview|Yeti|Daum(?:oa)?|Applebot|DuckDuckBot|DuckAssistBot)\b/i;

/** 수집 도구와 HTTP 라이브러리, 헤드리스 브라우저 */
const TOOL_AGENT = /(?:^|[\s(;])(?:curl|wget|python-requests|python-urllib|python-httpx|httpx|aiohttp|urllib3|scrapy|go-http-client|okhttp|java|apache-httpclient|libwww-perl|lwp-trivial|php|guzzlehttp|ruby|node-fetch|axios|undici|got|postmanruntime|insomnia|httpie|powershell|winhttp|colly|mechanize|nutch|heritrix|zgrab|masscan|nmap|nikto|sqlmap)\b|^node$|HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|webdriver/i;

const SKILL_AGENT = /^nomorevibe-skill\/[0-9][0-9A-Za-z.+-]{0,30}(?:\s|$)/;

export function agentKind(userAgent: string | null | undefined): AgentKind {
  const value = userAgent?.trim() ?? "";
  if (!value) return "missing";
  if (SKILL_AGENT.test(value)) return "skill";
  // 학습 봇을 먼저 — 학습 봇이 검색 봇 이름을 함께 싣더라도 막는다
  if (TRAINING_AGENT.test(value)) return "training";
  if (SEARCH_AGENT.test(value)) return "search";
  if (TOOL_AGENT.test(value)) return "tool";
  return "other";
}

/** 공개 API 읽기를 거절할 프로그램 — 수집 도구·학습 봇·이름 없음 */
export function refusedApiAgent(userAgent: string | null | undefined): boolean {
  const kind = agentKind(userAgent);
  return kind === "tool" || kind === "training" || kind === "missing";
}

/**
 * 이름으로 확인할 수 있는 검색 봇 — 역방향 DNS 로 끝나야 하는 이름(정방향으로 다시 같은 IP 인지까지 본다).
 * 이 목록에 없는 검색·답변 봇(OAI-SearchBot, Claude-*, Perplexity*, DuckDuckBot)은 DNS 로 확인할 수 없어
 * 보통 방문자와 같은 한도를 받는다. 이 봇들은 robots.txt 의 /api/ Disallow 를 지키므로 API 한도에 걸릴 일이 드물다.
 */
export const VERIFIABLE_SEARCH_BOTS: ReadonlyArray<{ pattern: RegExp; hosts: readonly string[] }> = [
  // 공식 안내(developers.google.com/search/docs/crawling-indexing/verifying-googlebot): 일반 크롤러는 googlebot.com,
  // 특수 크롤러는 google.com. googleusercontent.com 은 넣지 않는다 — 사용자가 시킨 가져오기용(gae.)뿐 아니라
  // GCP VM 의 역방향 이름(*.bc.googleusercontent.com)도 그 아래라, GCP 에서 Googlebot 이름을 대면 확인된 봇이 된다.
  { pattern: /\b(?:Googlebot|Google-InspectionTool)\b/i, hosts: ["googlebot.com", "google.com"] },
  { pattern: /\b(?:bingbot|BingPreview)\b/i, hosts: ["search.msn.com"] },
  { pattern: /\bApplebot\b/i, hosts: ["applebot.apple.com"] },
  { pattern: /\bYeti\b/i, hosts: ["naver.com"] },
  { pattern: /\bDaum(?:oa)?\b/i, hosts: ["daum.net", "kakao.com"] },
];

export function verifiableSearchHosts(userAgent: string | null | undefined): readonly string[] | null {
  if (agentKind(userAgent) !== "search") return null;
  return VERIFIABLE_SEARCH_BOTS.find(({ pattern }) => pattern.test(userAgent!))?.hosts ?? null;
}
