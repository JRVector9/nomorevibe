/**
 * 방문 분석(Google Analytics 4) 이벤트 목록 — 보내는 이름과 값은 이 파일 하나가 정한다(2026-10-22).
 *
 * 규칙
 * - 이름은 snake_case, GA4 추천 이름이 있으면 그것을 쓴다(page_view·select_item·search·share·login·sign_up·select_content).
 * - 브라우저에서 보내는 것(client)과 서버가 Measurement Protocol 로 보내는 것(server)을 한곳에 둔다.
 *   서버 발신기는 이름을 새로 만들지 않고 여기 있는 것을 쓴다. 이름을 더할 때는 이 파일 끝에 덧붙인다.
 * - 값은 문자열·숫자·참거짓만. 제품은 slug 로 가리킨다(이름·주소를 보내지 않는다).
 * - 보내지 않는 것: 이메일·이름·IP·토큰·비밀이 든 주소·길이 제한을 넘는 자유 입력 검색어.
 *   lib/analytics/sanitize.ts 가 금지 키를 지우고 길이를 자른다 — tests/analytics-*.test.ts 가 이 목록 전체를 검사한다.
 * - 로그인한 사람에게 user_id 를 붙이지 않는다(가명 id 는 서버 발신 작업에서 따로 정한다).
 *
 * GA4 한도: 이벤트 이름 40자, 매개변수 이름 40자, 값 100자, 이벤트당 매개변수 25개.
 */

/** 어느 화면에서 일어났나 — GA 탐색에서 같은 행동을 화면별로 나눠 본다 */
export type AnalyticsSurface =
  | "home" | "browse" | "search" | "product" | "talk" | "popular" | "rising" | "rankings"
  | "launch" | "policy" | "me" | "login" | "feedback" | "header" | "footer" | "mobile_nav"
  | "related" | "dialog" | "other";

/** 화면 갈래 — lib/analytics/routes.ts 의 pageType() 이 주소에서 정한다 */
export type AnalyticsPageType =
  | "home" | "browse" | "search" | "product" | "product_settings" | "talk" | "popular" | "rising"
  | "rankings" | "launch" | "policy" | "me" | "login" | "feedback" | "not_found" | "other";

export type AnalyticsLocale = "ko" | "en" | "zh-Hans" | "zh-Hant";

/* ── 화면 보기 ── */

export type PageViewParams = {
  /** 질의는 허용 목록(via·utm_*·tab·sort·new)만 남기고 # 뒤는 지운 주소 */
  page_location: string;
  /** 주소의 경로 부분(언어 접두 포함) */
  page_path: string;
  page_title: string;
  /** 앞 화면 — 같은 사이트면 page_location 과 같은 규칙으로 정리, 바깥이면 origin+경로만 */
  page_referrer?: string;
  locale: AnalyticsLocale;
  page_type: AnalyticsPageType;
};

/* ── 목록·검색·거르기 ── */

/** 목록의 제품 카드를 눌렀다(GA4 select_item). client.ts 가 items 배열을 함께 만들어 GA 상품 보고서에도 잡힌다 */
export type SelectItemParams = {
  /** 어느 목록인가 — 홈 줄·탭·순위 키(예: home_rising, browse_results, popular_all, rankings_weekly) */
  item_list_id: string;
  /** 사람이 읽는 목록 이름(로캘과 무관한 영어 키) */
  item_list_name: string;
  /** 목록 안 위치(0부터) */
  index: number;
  /** 제품 slug */
  item_id: string;
};

export type SearchParams = {
  /** 소문자·공백 정리·길이 제한(64자)·이메일과 긴 숫자 지움 — sanitizeSearchTerm() */
  search_term: string;
  result_count?: number;
  surface?: AnalyticsSurface;
};

/** 탭·구획 펼치기처럼 '무엇을 골라 봤나'(GA4 select_content) */
export type SelectContentParams = {
  content_type: string;
  content_id: string;
  surface?: AnalyticsSurface;
};

/** 거르기·정렬·탭 바꾸기 */
export type FilterChangeParams = {
  filter_name: string;
  filter_value: string;
  surface: AnalyticsSurface;
};

/* ── 제품 상세의 행동 ── */

export type ShareParams = {
  /** native(기기 공유 창)·copy_link·x·bluesky·threads·facebook·linkedin·kakao·image 등 */
  method: string;
  content_type: "product" | "profile" | "ranking" | "page";
  /** 제품이면 slug */
  item_id: string;
};

/** 제품 사이트·저장소로 나가는 /go 단추를 눌렀다 */
export type OutboundClickParams = {
  link_kind: "site" | "repo";
  product_slug: string;
  surface: AnalyticsSurface;
};

/** /go 를 거치지 않는 GitHub 직접 링크 */
export type GithubClickParams = {
  product_slug: string;
  surface: AnalyticsSurface;
};

/** 화제 글의 원문(HN·X·Bluesky)으로 나간다 */
export type SocialOutboundClickParams = {
  source: "hn" | "x" | "bluesky" | "reddit" | "other";
  surface: AnalyticsSurface;
  product_slug?: string;
};

export type ProductSaveParams = {
  product_slug: string;
  action: "save" | "unsave";
  surface: AnalyticsSurface;
};

export type ReactionChangeParams = {
  product_slug: string;
  /** 반응 종류 키(문구가 아니라 코드) */
  reaction_kind: string;
  action: "add" | "remove";
};

/** '써봤어요' 남기기·바꾸기·지우기 */
export type ProductTriedParams = {
  product_slug: string;
  action: "add" | "update" | "remove";
  /** 평가 코드(문구 아님) */
  verdict?: string;
};

export type FollowChangeParams = {
  product_slug: string;
  action: "follow" | "unfollow";
  surface: AnalyticsSurface;
};

/** 우리 앱으로 GitHub 스타 누르기·빼기 */
export type GithubStarParams = {
  product_slug: string;
  action: "star" | "unstar";
};

/** GitHub 로 연결하기를 시작했다(로그인·스타 권한·앱 설치·소유 확인) — 끝났는지는 서버 github_connected 가 센다 */
export type GithubConnectStartParams = {
  kind: "login" | "star" | "app_install" | "claim";
  surface: AnalyticsSurface;
  product_slug?: string;
};

/** 소유 확인·주인 찾기를 시작했다 */
export type ClaimStartParams = {
  product_slug: string;
  step: "claim" | "verify";
};

/** 복사 단추 — 무엇을 복사했는지 코드로(내용은 보내지 않는다) */
export type CopyTextParams = {
  copy_target: string;
  surface: AnalyticsSurface;
  product_slug?: string;
};

/** 상세의 요청 폼을 보냈다(내용·연락처는 보내지 않는다) */
export type FeedbackSubmitParams = {
  product_slug: string;
  feedback_kind: string;
};

/* ── 스킬 설치(/launch) ── */

export type SkillInstallCopyParams = {
  surface: AnalyticsSurface;
  /** 어떤 설치 명령인가(install_sh·npx 등 코드) */
  command: string;
};

export type SkillScriptViewParams = {
  script: "install_sh" | "skill_md";
  surface: AnalyticsSurface;
};

export type LaunchCommandCopyParams = {
  command_kind: "launch" | "verify" | "install" | "other";
  surface: AnalyticsSurface;
};

/** /launch 의 단계 구획이 화면에 들어왔다 */
export type LaunchStepViewParams = {
  step: string;
  step_index: number;
};

/* ── 길 찾기·로그인·오류 ── */

export type NavClickParams = {
  /** 메뉴 항목 키(home·rising·popular·talk·launch·policy·me·login·metrics·listing_policy·search 등) */
  target: string;
  surface: AnalyticsSurface;
};

/** 로그인 단추를 눌렀다 */
export type LoginStartParams = {
  method: "github" | "email";
  surface: AnalyticsSurface;
};

/**
 * 로그인·가입 완료(GA4 login·sign_up) — 수단만 보낸다.
 * login: 이메일은 브라우저가 확인 성공 응답에서, GitHub 는 서버가 OAuth 콜백에서 보낸다(같은 로그인을 양쪽에서 세지 않는다).
 * sign_up: 새 계정인지는 서버만 안다(이메일 확인 응답에 그 표시가 없다) — 두 수단 모두 서버가 보낸다.
 */
export type LoginParams = { method: "github" | "email" };
export type SignUpParams = { method: "github" | "email" };

/** 화면 오류 경계에 걸렸다 — 메시지·스택은 보내지 않고 코드만 */
export type AppErrorParams = {
  error_code: string;
  page_type: AnalyticsPageType;
};

/* ── 서버가 보내는 것(Measurement Protocol) ── */

/** /go/[slug] 가 제품 사이트·저장소로 보냈다 — 실제로 나간 수 */
export type OutboundVisitParams = {
  product_slug: string;
  link_kind: "site" | "repo";
  /** /go?via= 값(허용 목록 문자열) */
  via?: string;
};

/** /install.sh·/skill.md 를 받아 갔다 */
export type SkillScriptDownloadParams = {
  script: "install_sh" | "skill_md";
};

/** 스킬로 등록이 들어왔다 */
export type LaunchSubmittedParams = {
  product_slug: string;
  source: "skill" | "other";
};

/** 소유 확인이 끝났다 */
export type ProductClaimedParams = {
  product_slug: string;
  method: "skill_verify" | "github" | "other";
};

/** GitHub 연결이 끝났다(로그인·스타 권한·앱 설치) */
export type GithubConnectedParams = {
  kind: "login" | "star" | "app_install";
};

/** 이벤트 이름 → 매개변수. 새 이름은 이 목록 끝과 ANALYTICS_EVENT_CATALOG 끝에 함께 덧붙인다 */
export interface AnalyticsEventParams {
  page_view: PageViewParams;
  select_item: SelectItemParams;
  search: SearchParams;
  select_content: SelectContentParams;
  filter_change: FilterChangeParams;
  share: ShareParams;
  outbound_click: OutboundClickParams;
  github_click: GithubClickParams;
  social_outbound_click: SocialOutboundClickParams;
  product_save: ProductSaveParams;
  reaction_change: ReactionChangeParams;
  product_tried: ProductTriedParams;
  follow_change: FollowChangeParams;
  github_star: GithubStarParams;
  github_connect_start: GithubConnectStartParams;
  claim_start: ClaimStartParams;
  copy_text: CopyTextParams;
  feedback_submit: FeedbackSubmitParams;
  skill_install_copy: SkillInstallCopyParams;
  skill_script_view: SkillScriptViewParams;
  launch_command_copy: LaunchCommandCopyParams;
  launch_step_view: LaunchStepViewParams;
  nav_click: NavClickParams;
  login_start: LoginStartParams;
  login: LoginParams;
  sign_up: SignUpParams;
  app_error: AppErrorParams;
  outbound_visit: OutboundVisitParams;
  skill_script_download: SkillScriptDownloadParams;
  launch_submitted: LaunchSubmittedParams;
  product_claimed: ProductClaimedParams;
  github_connected: GithubConnectedParams;
}

export type AnalyticsEventName = keyof AnalyticsEventParams;

/** 이름과 매개변수의 짝 — track(name, params) 의 인자를 하나로 묶은 꼴 */
export type AnalyticsEvent = {
  [Name in AnalyticsEventName]: { name: Name; params: AnalyticsEventParams[Name] };
}[AnalyticsEventName];

export type AnalyticsParamKind = "string" | "number" | "boolean";

/** 누가 보내나 — client: 브라우저 track(), server: Measurement Protocol, both: 수단에 따라 갈린다(login·sign_up) */
export type AnalyticsEventSource = "client" | "server" | "both";

type ParamSpec = { kind: AnalyticsParamKind; optional?: true; values?: readonly string[] };
type EventSpec<Params> = {
  source: AnalyticsEventSource;
  /** 운영 문서·GA 화면에서 읽는 한 줄 설명 */
  description: string;
  params: { [Key in keyof Params]-?: ParamSpec };
};

const SURFACES = ["home", "browse", "search", "product", "talk", "popular", "rising", "rankings", "launch", "policy", "me",
  "login", "feedback", "header", "footer", "mobile_nav", "related", "dialog", "other"] as const satisfies readonly AnalyticsSurface[];
const PAGE_TYPES = ["home", "browse", "search", "product", "product_settings", "talk", "popular", "rising", "rankings", "launch",
  "policy", "me", "login", "feedback", "not_found", "other"] as const satisfies readonly AnalyticsPageType[];

const text = { kind: "string" } as const;
const optionalText = { kind: "string", optional: true } as const;
const count = { kind: "number" } as const;
const oneOf = (values: readonly string[]) => ({ kind: "string", values }) as const;
const surface = oneOf(SURFACES);

/**
 * 실행 중에 읽는 목록 — 문서 표·시험·개발 중 경고가 이것을 본다.
 * 매개변수 키는 위 타입과 컴파일 때 맞춰진다(빠지거나 남으면 tsc 가 막는다).
 */
export const ANALYTICS_EVENT_CATALOG: { [Name in AnalyticsEventName]: EventSpec<AnalyticsEventParams[Name]> } = {
  page_view: { source: "client", description: "화면을 열었다(첫 화면과 앱 안 이동마다)", params: {
    page_location: text, page_path: text, page_title: text, page_referrer: optionalText,
    locale: oneOf(["ko", "en", "zh-Hans", "zh-Hant"]), page_type: oneOf(PAGE_TYPES) } },
  select_item: { source: "client", description: "목록의 제품 카드를 눌렀다", params: {
    item_list_id: text, item_list_name: text, index: count, item_id: text } },
  search: { source: "client", description: "검색했다(검색어는 정리·길이 제한)", params: {
    search_term: text, result_count: { kind: "number", optional: true }, surface: { ...surface, optional: true } } },
  select_content: { source: "client", description: "탭·구획을 골라 봤다", params: {
    content_type: text, content_id: text, surface: { ...surface, optional: true } } },
  filter_change: { source: "client", description: "거르기·정렬을 바꿨다", params: { filter_name: text, filter_value: text, surface } },
  share: { source: "client", description: "공유했다(수단별)", params: {
    method: text, content_type: oneOf(["product", "profile", "ranking", "page"]), item_id: text } },
  outbound_click: { source: "client", description: "제품 방문하기·저장소 열기(/go)를 눌렀다", params: {
    link_kind: oneOf(["site", "repo"]), product_slug: text, surface } },
  github_click: { source: "client", description: "GitHub 직접 링크를 눌렀다", params: { product_slug: text, surface } },
  social_outbound_click: { source: "client", description: "화제 글 원문(HN·X·Bluesky)으로 나갔다", params: {
    source: oneOf(["hn", "x", "bluesky", "reddit", "other"]), surface, product_slug: optionalText } },
  product_save: { source: "client", description: "제품을 저장·저장 취소했다", params: {
    product_slug: text, action: oneOf(["save", "unsave"]), surface } },
  reaction_change: { source: "client", description: "반응을 남기거나 지웠다", params: {
    product_slug: text, reaction_kind: text, action: oneOf(["add", "remove"]) } },
  product_tried: { source: "client", description: "써봤어요를 남기거나 바꾸거나 지웠다", params: {
    product_slug: text, action: oneOf(["add", "update", "remove"]), verdict: optionalText } },
  follow_change: { source: "client", description: "제품을 팔로·팔로 취소했다", params: {
    product_slug: text, action: oneOf(["follow", "unfollow"]), surface } },
  github_star: { source: "client", description: "우리 앱으로 GitHub 스타를 누르거나 뺐다", params: {
    product_slug: text, action: oneOf(["star", "unstar"]) } },
  github_connect_start: { source: "client", description: "GitHub 연결을 시작했다", params: {
    kind: oneOf(["login", "star", "app_install", "claim"]), surface, product_slug: optionalText } },
  claim_start: { source: "client", description: "소유 확인을 시작했다", params: { product_slug: text, step: oneOf(["claim", "verify"]) } },
  copy_text: { source: "client", description: "복사 단추를 눌렀다(대상 코드만)", params: {
    copy_target: text, surface, product_slug: optionalText } },
  feedback_submit: { source: "client", description: "상세 요청 폼을 보냈다(종류만)", params: { product_slug: text, feedback_kind: text } },
  skill_install_copy: { source: "client", description: "스킬 설치 명령을 복사했다", params: { surface, command: text } },
  skill_script_view: { source: "client", description: "설치 스크립트를 열어 봤다", params: {
    script: oneOf(["install_sh", "skill_md"]), surface } },
  launch_command_copy: { source: "client", description: "등록·확인 명령을 복사했다", params: {
    command_kind: oneOf(["launch", "verify", "install", "other"]), surface } },
  launch_step_view: { source: "client", description: "/launch 의 단계 구획까지 봤다", params: { step: text, step_index: count } },
  nav_click: { source: "client", description: "헤더·푸터·모바일 메뉴를 눌렀다", params: { target: text, surface } },
  login_start: { source: "client", description: "로그인 단추를 눌렀다", params: { method: oneOf(["github", "email"]), surface } },
  login: { source: "both", description: "로그인했다(이메일은 브라우저, GitHub 는 서버)", params: { method: oneOf(["github", "email"]) } },
  sign_up: { source: "server", description: "처음 가입했다(새 계정은 서버만 안다 — 두 수단 모두 서버)", params: { method: oneOf(["github", "email"]) } },
  app_error: { source: "client", description: "화면 오류 경계에 걸렸다(코드만)", params: { error_code: text, page_type: oneOf(PAGE_TYPES) } },
  outbound_visit: { source: "server", description: "/go 가 제품 사이트·저장소로 보냈다", params: {
    product_slug: text, link_kind: oneOf(["site", "repo"]), via: optionalText } },
  skill_script_download: { source: "server", description: "/install.sh·/skill.md 를 받아 갔다", params: {
    script: oneOf(["install_sh", "skill_md"]) } },
  launch_submitted: { source: "server", description: "스킬로 등록이 들어왔다", params: { product_slug: text, source: oneOf(["skill", "other"]) } },
  product_claimed: { source: "server", description: "소유 확인이 끝났다", params: {
    product_slug: text, method: oneOf(["skill_verify", "github", "other"]) } },
  github_connected: { source: "server", description: "GitHub 연결이 끝났다", params: { kind: oneOf(["login", "star", "app_install"]) } },
};

export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENT_CATALOG) as AnalyticsEventName[];

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && Object.hasOwn(ANALYTICS_EVENT_CATALOG, value);
}
