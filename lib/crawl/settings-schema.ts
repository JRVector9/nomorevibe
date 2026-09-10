import { z } from "zod";
import { CATEGORIES, type Category } from "@/lib/domain/products/categories";

/**
 * 크롤 기준.
 *
 * 코드 상수가 아니라 데이터다. 어드민 화면에서 바꿀 수 있어야 하고, 바꾼 뒤 재배포 없이
 * 곧바로 적용돼야 한다. 원본(crawl_documents)을 보관하므로 판정 기준을 바꾸면
 * GitHub을 다시 긁지 않고 재판정된다 — 기준을 실험하는 비용이 거의 없다.
 *
 * 필터를 추가할 때는 이 스키마에 필드 하나와 기본값만 넣으면 된다. 마이그레이션은 없다
 * (jsonb 한 컬럼에 담기므로). 어드민 폼 검증도 같은 스키마를 쓴다.
 */

/** GitHub 검색 정렬. 표본 분포를 크게 바꾼다 */
export const searchSortSchema = z.enum(["relevance", "recent"]).describe(
  // 실측: 같은 100건에서 고유 레포가 relevance 63개 vs recent 2개.
  // recent는 방금 활발히 커밋한 소수 레포에 몰린다.
  "relevance는 레포가 넓게 흩어지고, recent는 최신 활동에 몰린다",
);

const discoverSchema = z.object({
  /** 켜져 있는 검색 신호. 신호별 수율을 비교하려면 개별로 끌 수 있어야 한다 */
  queries: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        /**
         * 어느 검색을 타는지.
         *
         * commits는 커밋 메시지를 찾는다(트레일러 신호). 결과에 레포 메타가 없어 배포 여부를
         * 모른 채 프론티어에 넣고, 그중 상당수가 no_homepage로 거부된다(실측 206건 중 122건).
         * repositories는 결과에 homepage가 실려 오므로 배포된 레포만 골라 넣을 수 있다.
         */
        kind: z.enum(["commits", "repositories"]).default("commits"),
        /** GitHub 검색 문자열. repositories면 `topic:` 같은 레포 검색 수식어를 쓴다 */
        query: z.string().min(1).max(200),
        enabled: z.boolean(),
        /** 이 신호로 발견한 레포의 조사 우선순위 */
        priority: z.number().int().min(0).max(1000),
        /** 검색 설정의 과거 호환용 힌트. 제작 AI 확정이나 공개 builder에 사용하지 않는다. */
        builder: z.string().min(1).max(40).nullable().default(null),
      }),
    )
    .min(1),
  /** 최근 N일 이내의 커밋만 본다 */
  windowDays: z.number().int().min(1).max(3650),
  sort: searchSortSchema,
  /** 한 틱에 볼 검색 페이지 수. rate limit(30회/분)을 고려해 낮게 유지한다 */
  pagesPerTick: z.number().int().min(1).max(10),
  /**
   * Show HN 수집.
   *
   * GitHub 검색과 반대 방향이다 — 만든 사람이 배포했다고 직접 올린 목록에서 시작한다.
   * 다른 수집원과 마찬가지로 배포 없이 끊을 수 있어야 하므로 데이터로 둔다.
   */
  showHn: z.object({
    enabled: z.boolean(),
    /** 스스로 내놓은 것이라 커밋 트레일러로 주운 것보다 먼저 본다 */
    priority: z.number().int().min(0).max(1000),
  }).strict().default({ enabled: true, priority: 120 }),
});

const judgeSchema = z.object({
  /**
   * 스타 상한. 넘으면 개인이 AI로 만든 제품이 아니라고 본다.
   * 하한이 아니라 상한인 것이 요지다 — 갓 배포한 제품은 정당하게 스타가 0개이므로
   * 하한을 두면 우리가 찾으려는 것부터 걸러진다.
   */
  maxStars: z.number().int().min(0).max(1_000_000),
  /** 하한. 0이 기본이다 */
  minStars: z.number().int().min(0).max(100_000),
  /** 마지막 푸시가 이보다 오래되면 죽은 프로젝트로 본다 */
  maxPushAgeDays: z.number().int().min(1).max(3650),
  excludeForks: z.boolean(),
  /**
   * 조직 계정 레포를 제외할지.
   *
   * 기본값이 false인 이유는 실측이다. 표본 341개에서 large_oss로 거른 52건 중 39건이
   * "조직 계정인데 스타 1000 이하"였고, 그 안에 nodetool.ai·smithers.sh·albyhub.com 같은
   * 실제 배포 제품이 섞여 있었다. 규모는 스타 상한이 이미 거른다 — 계정 종류로 한 번 더
   * 거르면 소규모 팀이 통째로 빠진다.
   */
  excludeOrganizations: z.boolean(),
  /**
   * 레포 설명에 이 문구가 있으면 개인 사이트로 본다.
   *
   * 이름과 URL에는 단서가 없는데 설명에만 있는 경우가 있다 — evansstepanov("My very simple
   * personal landing page app"), villoro.com("Personal blog build with Astro")이 그렇게 통과했다.
   * 한 단어짜리는 넣지 않는다. "personal"만 보면 personal-finance-tracker가 걸린다.
   */
  personalSiteKeywords: z.array(z.string().min(3).max(60)).max(100),
  /** homepage가 이 도메인이면 배포물이 아니다 */
  blockedHomepageDomains: z.array(z.string().min(1).max(120)).max(200),
  /** 레포 이름이 이 패턴이면 제외 (* 와일드카드) */
  excludedRepoPatterns: z.array(z.string().min(1).max(120)).max(200),
  /**
   * 이 생성기로 만들어진 페이지는 문서 사이트로 본다.
   *
   * 실측에서 심사 큐의 GitHub Pages 23건 중 10건이 문서 생성기 흔적을 남겼고, 그중 범용
   * 생성기(jekyll·hugo)를 뺀 8건이 실제 문서였다. 사람이 같은 판단을 반복할 이유가 없다.
   */
  docsGenerators: z.array(z.string().min(2).max(40)).max(50),
  /**
   * 페이지 제목이 이것과 정확히 같으면 손대지 않은 스캐폴드다.
   *
   * 프레임워크가 만들어 준 기본 제목을 그대로 배포한 것은 아직 제품이 아니다. 부분 일치가
   * 아니라 정확 일치로 본다 — "Create Next App Alternatives" 같은 진짜 제품을 치지 않게.
   */
  placeholderTitles: z.array(z.string().min(2).max(60)).max(100),
  /**
   * 제목이 스스로 문서라고 말하는 것.
   *
   * 주소와 생성기로는 못 잡는다 — owner.github.io/repo 아래에 문서와 웹앱이 섞여 있어
   * 규칙이 판단을 미루는데, 그중 상당수는 제목만 봐도 문서다.
   * 실측(2026-09-10, 보류 576건): 29건이 걸렸고 눈으로 확인한 오탐은 없었다.
   *
   * 스캐폴드 제목과 달리 정확 일치가 아니라 와일드카드를 쓴다. 대신 제목의 끝만 보고,
   * 짧은 제목에만 건다 — "Documentation Hub"나 "Docsy"처럼 앞이나 안에 품고 있을 뿐인
   * 진짜 제품, 그리고 마지막 단어가 우연히 docs인 한 문장짜리 소개문을 치지 않기 위해서다
   * (그 경계는 기존 테스트가 지키고 있다. rules.ts의 DOCS_TITLE_MAX_WORDS 참고).
   */
  docsTitlePatterns: z.array(z.string().min(2).max(60)).max(50),
  /**
   * 본문이 "설치해서 쓰라"고 말하는 것.
   *
   * 실측(2026-09-10): owner.github.io 하위 경로 509건을 전부 열어 보니 359건이 배포물이
   * 아니라 소개 페이지였다. 제목·주소·생성기로는 하나도 못 걸렀는데, 본문 첫머리에는
   * 그대로 적혀 있었다 — `npm install`, `Download for macOS`, 문서 목차.
   *
   * 소문자로 맞춘 본문에서 찾는다. 정규식이 아니라 그냥 들어 있는지만 본다.
   */
  landingPhrases: z.array(z.string().min(2).max(60)).max(120),
  /**
   * 문서 사이트의 목차 낱말.
   *
   * 한 낱말은 진짜 제품 페이지에도 흔하다("Getting Started" 버튼). 여러 개가 함께 있으면
   * 그것은 목차이고, 목차가 있는 페이지는 읽는 곳이지 쓰는 곳이 아니다.
   */
  docsNavPhrases: z.array(z.string().min(2).max(60)).max(60),
  /** 이 수 이상 함께 나오면 문서 사이트로 본다. 실측에서 3이 오탐 없이 68건을 갈랐다 */
  docsNavThreshold: z.number().int().min(2).max(10),
  /** 규칙으로 못 가르면 needs_review로 보류할지, 그냥 거부할지 */
  holdAmbiguous: z.boolean(),
});

/**
 * 카테고리 분류 기준.
 *
 * 판정 규칙과 같은 이유로 코드 상수가 아니라 데이터다. 분류가 어긋날 때 고쳐야 하는 것은
 * 이 문장인데, 상수로 두면 한 줄을 고치려고 재배포를 해야 한다.
 *
 * summary는 지금 프롬프트에 있는 문장을 그대로 옮긴 것이다. include/exclude가 비어 있으면
 * 렌더 결과가 기존 프롬프트와 한 글자도 다르지 않다 — 옮기는 것만으로 분류가 바뀌면 안 된다.
 */
export const categoryDefinitionSchema = z.object({
  summary: z.string().min(1).max(300),
  /** 애매할 때 여기에 넣을 것 */
  include: z.array(z.string().min(1).max(120)).max(12),
  /** 잘못 분류된 것을 볼 때마다 쌓는다. "무엇 → 어느 카테고리" 형태로 쓴다 */
  exclude: z.array(z.string().min(1).max(120)).max(12),
}).strict();

/** 열거형 키라 17개가 모두 있어야 하고 모르는 카테고리는 거부된다 */
export const categoryDefinitionsSchema = z.record(z.enum(CATEGORIES), categoryDefinitionSchema);
export type CategoryDefinition = z.infer<typeof categoryDefinitionSchema>;
export type CategoryDefinitions = Record<Category, CategoryDefinition>;

const definition = (summary: string): CategoryDefinition => ({ summary, include: [], exclude: [] });

export const DEFAULT_CATEGORY_DEFINITIONS: CategoryDefinitions = {
  Productivity: definition("개인·팀의 일정, 문서, 메모, 작업 및 워크플로 도구"),
  Dev: definition("코딩, API, SDK, 테스트, 인프라 및 개발자 도구"),
  Design: definition("UI/UX, 그래픽, 3D 및 시각 디자인 도구"),
  Business: definition("CRM, HR, 회사 운영, 프로젝트 운영 및 업무 협업"),
  Marketing: definition("광고, SEO, 영업 지원, 소셜 발행 및 고객 성장"),
  Finance: definition("투자, 은행, 회계, 결제 및 금융 분석"),
  Commerce: definition("쇼핑, 마켓플레이스, 소매, 주문 및 상품 탐색"),
  Education: definition("교육, 학습, 튜터링, 강의 및 학업"),
  Health: definition("신체·정신 건강, 웰니스 및 의료 지원"),
  Media: definition("영상, 오디오, 음악, 스토리 및 뉴스의 제작·편집·소비"),
  Games: definition("비디오게임, 게임 제작 도구 및 게임 커뮤니티"),
  Social: definition("메시징, 커뮤니티, 데이팅 및 소셜 네트워크"),
  Data: definition("분석, 데이터베이스, BI, 데이터 처리 및 시각화"),
  Security: definition("개인정보, 인증, 사이버보안 및 사기 방지"),
  Lifestyle: definition("여행, 음식, 집, 취미 및 개인 생활 서비스"),
  Sports: definition("운동, 스포츠 경기, 팀 운영 및 피트니스"),
  Other: definition("정보가 부족하거나 어느 분류에도 명확히 맞지 않음"),
};

const defaultClassify = { definitions: DEFAULT_CATEGORY_DEFINITIONS };

const defaultAgentEvidence = {
  enabled: false,
  enforceEligibility: false,
  displayObservedFacts: false,
  detectorVersion: "2026-09-06.1",
  policyVersion: "2026-09-06.1",
};

export const crawlSettingsSchema = z.object({
  /** 수집 자체를 멈추는 스위치. 무언가 잘못 돌 때 배포 없이 끊을 수 있어야 한다 */
  enabled: z.boolean(),
  reviewMode: z.enum(["off", "observe", "enforce"]).default("off"),
  discover: discoverSchema,
  judge: judgeSchema,
  classify: z.object({ definitions: categoryDefinitionsSchema }).strict().default(defaultClassify),
  agentEvidence: z.object({
    enabled: z.boolean(),
    enforceEligibility: z.boolean(),
    displayObservedFacts: z.boolean(),
    detectorVersion: z.string().regex(/^[a-zA-Z0-9.-]{1,40}$/),
    policyVersion: z.string().regex(/^[a-zA-Z0-9.-]{1,40}$/),
  }).default(defaultAgentEvidence),
});

export type CrawlSettings = z.infer<typeof crawlSettingsSchema>;
export type AgentDiscoveryQuery = CrawlSettings["discover"]["queries"][number];

/** Discovery hints only: a topic may describe runtime functionality, not AI-assisted development. */
export const ADDITIONAL_AGENT_DISCOVERY_QUERIES: readonly AgentDiscoveryQuery[] = [
  {label:"Grok Build 기여 표기 탐색",kind:"commits",query:"Co-authored-by: Grok",enabled:true,priority:70,builder:null},
  {label:"Kimi CLI 기여 표기 탐색",kind:"commits",query:"Co-authored-by: Kimi",enabled:true,priority:65,builder:null},
  {label:"GLM 관련 저장소 탐색",kind:"repositories",query:"topic:glm",enabled:true,priority:50,builder:null},
  {label:"DeepSeek 관련 저장소 탐색",kind:"repositories",query:"topic:deepseek",enabled:true,priority:45,builder:null},
  {label:"OpenRouter 관련 저장소 탐색",kind:"repositories",query:"topic:openrouter",enabled:true,priority:40,builder:null},
  /**
   * 개발에 AI를 썼다고 스스로 붙인 토픽. 실측 모집단(2026-09-09)을 라벨 옆에 남긴다 —
   * 커밋 검색은 180일에 6,600만 건이라 다 훑을 수 없지만, 이쪽은 4자릿수라 한 주기에 끝난다.
   * 게다가 레포 검색이라 homepage가 실려 와 배포 없는 것을 프론티어에 넣지 않는다.
   * topic:ai-agent(30,341)는 넣지 않았다 — 실행 기능을 설명할 뿐 개발에 AI를 썼다는 뜻이 아니다.
   */
  {label:"Cursor 관련 저장소 탐색",kind:"repositories",query:"topic:cursor-ai",enabled:true,priority:55,builder:null},        // 921
  {label:"Codex CLI 관련 저장소 탐색",kind:"repositories",query:"topic:codex-cli",enabled:true,priority:52,builder:null},     // 2,569
  {label:"AI 생성 표기 저장소 탐색",kind:"repositories",query:"topic:ai-generated",enabled:true,priority:48,builder:null},    // 1,031
  // 가장 크다. 한 주기에 다 못 훑어도 순회가 다른 신호를 굶기지 않으므로 우선순위만 낮춘다.
  {label:"Claude Code 관련 저장소 탐색",kind:"repositories",query:"topic:claude-code",enabled:true,priority:35,builder:null}, // 70,152
];

/** Explicit rollout helper. Reading stored settings never calls this or changes a maker's queries. */
export function mergeAdditionalAgentDiscoveryQueries(existing: readonly AgentDiscoveryQuery[]):AgentDiscoveryQuery[] {
  const merged = existing.map(query => ({...query}));
  const key = (query:AgentDiscoveryQuery) => `${query.kind}:${query.query.trim().replace(/\s+/g," ").toLowerCase()}`;
  for (const query of ADDITIONAL_AGENT_DISCOVERY_QUERIES) {
    if (!merged.some(current => current.label === query.label || key(current) === key(query))) merged.push({...query});
  }
  return merged;
}

/** 기본값. 실측을 근거로 잡았다 (수율 42%, 노이즈는 대형 OSS와 개인 홈페이지) */
export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = {
  enabled: false, // 켜는 것은 명시적 행위여야 한다
  reviewMode: "off",
  agentEvidence: defaultAgentEvidence,
  classify: defaultClassify,
  discover: {
    queries: [
      { label: "Claude 커밋 트레일러", kind: "commits", query: "Co-authored-by: Claude", enabled: true, priority: 100, builder: "Claude" },
      // 실측으로 켰다. 표본 132개에서 통과율 23%로 Claude 신호(19%)보다 높았고,
      // 두 신호가 같이 찾은 레포는 5%뿐이라 거의 겹치지 않는 집합을 데려온다.
      { label: "Codex 커밋 트레일러", kind: "commits", query: "Co-authored-by: Codex", enabled: true, priority: 90, builder: "Codex" },
      // 실측(2026-08-29, 최근 180일): 4,326개 레포, 상위 100건 중 52%에 homepage. 커밋 신호의
      // 41%보다 높고, 레포 검색이라 homepage 없는 것은 애초에 넣지 않는다. topic은 어떤 AI가
      // 만들었는지 말하지 않으므로 builder는 비운다. claude-code(61k, 43%)·cursor-ai(575, 46%)·
      // codex-cli(2.3k, 33%)·ai-generated(596, 41%)는 같은 방식으로 /admin에서 더할 수 있다.
      { label: "vibe-coding 토픽", kind: "repositories", query: "topic:vibe-coding", enabled: true, priority: 80, builder: null },
      ...ADDITIONAL_AGENT_DISCOVERY_QUERIES.map(query => ({...query})),
    ],
    windowDays: 3,
    sort: "relevance",
    pagesPerTick: 10,
    showHn: { enabled: true, priority: 120 },
  },
  judge: {
    maxStars: 1000,
    minStars: 0,
    maxPushAgeDays: 180,
    excludeForks: true,
    excludeOrganizations: false,
    personalSiteKeywords: [
      "personal blog",
      "personal site",
      "personal website",
      "personal landing",
      "my portfolio",
      "portfolio website",
      "개인 블로그",
      "개인 홈페이지",
    ],
    blockedHomepageDomains: [
      "github.com",
      "instagram.com",
      "x.com",
      "twitter.com",
      "linkedin.com",
      "medium.com",
      "notion.site",
      "youtube.com",
      "discord.gg",
      // 패키지·모드 등록처. 배포물이 아니라 배포물의 등록 페이지다 (실데이터에서 넷 다 나왔다)
      "npmjs.com",
      "crates.io",
      "modrinth.com",
      "pypi.org",
      "wordpress.org",
      // 같은 성격인데 빠져 있었다 — 발행된 제품에서 rubygems 패키지 페이지가 나왔다
      "rubygems.org",
      "packagist.org",
      "nuget.org",
      "hex.pm",
      "pub.dev",
      "hub.docker.com",
      "marketplace.visualstudio.com",
      "chromewebstore.google.com",
      "addons.mozilla.org",
      // 문서 호스팅. docs 라벨 규칙에 안 걸리는 형태다 (suews.readthedocs.io를 봤다)
      "readthedocs.io",
    ],
    excludedRepoPatterns: [
      "*.github.io",
      "documentation",
      "dotfiles",
      "awesome-*",
      "*-portfolio",
      "*-blog",
      "*-resume",
      // 회사·단체 소개 사이트와 학술 패키지 (juxt/astro-website, Pathfinder.jl을 실제로 봤다)
      "*-website",
      "*.jl",
      "*-personal-site",
      "*-personal-website",
    ],
    /**
     * 실측(2026-08-30, 원본 1445건): 정확히 이 제목으로 배포된 것이 5건 있었고 전부 발행돼
     * 목록에 "Create Next App"이 셋, "Document"와 "Svelte app"이 하나씩 올라 있었다.
     * "Home"은 5건이 걸렸지만 진짜 제목일 수 있어 넣지 않는다 — 이미 다른 규칙이 처리했다.
     * 지금 걸리는 것이 없는 항목도 프레임워크 기본값이라 넣어 둔다.
     */
    placeholderTitles: [
      "create next app",
      "next app",
      "react app",
      "vite app",
      "vite + react",
      "vite + react + ts",
      "vite + vue",
      "vite + svelte",
      "nuxt app",
      "svelte app",
      "document",
      "untitled",
      // 리다이렉트 껍데기. 실측 보류 576건에서 3건 (2026-09-10)
      "redirecting",
    ],
    /**
     * 실측 509건에 걸어 고른 것만 남겼다(2026-09-10). 확실한 것만 넣는다 —
     * "다운로드"·"下载"·"on this page"·"view on github"는 진짜 앱 페이지에도 흔해서 뺐다.
     * 이 목록으로 509건 중 136건이 갈렸고 그중 3건이 오탐이었다(2.2%).
     */
    landingPhrases: [
      // 설치 명령 — 실물은 CLI·플러그인·라이브러리다
      "npm install", "npm i -g", "npm i @", "npx ", "pnpm add", "yarn add",
      "pip install", "pipx install", "cargo install", "go install", "brew install",
      "winget install", "scoop install", "choco install", "docker run", "uvx ", "curl -fsSL",
      // 내려받기 — 실물은 데스크톱·모바일 앱이다
      "download for mac", "download for windows", "download for linux",
      // 문서·넘김 껍데기
      "skip to main content", "keyboard shortcuts press", "if it does not open automatically",
    ],
    docsNavPhrases: [
      "getting started", "quick start", "quickstart", "installation", "api reference",
      "cli reference", "configuration", "changelog", "troubleshooting", "reference",
      "시작하기", "설치",
    ],
    docsNavThreshold: 3,
    docsTitlePatterns: [
      // 끝에 오는 것만 본다. "Documentation Hub"처럼 앞에 오면 진짜 제품일 수 있다
      "*documentation",
      "documentation",
      "* docs",
      "docs",
    ],
    docsGenerators: [
      "mkdocs",
      "docusaurus",
      "sphinx",
      "pkgdown",
      "vitepress",
      "docsify",
      "gitbook",
      "mdbook",
      "quarto",
      "bookdown",
      "readthedocs",
      "starlight",
      "nextra",
    ],
    holdAmbiguous: true,
  },
};
