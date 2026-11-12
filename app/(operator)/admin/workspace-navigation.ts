import type { AdminIconName } from "./components/AdminIcon";

/**
 * 관리자 메뉴 여섯(2026-11-12 운영 콘솔 개편 조각 1a) — 홈 · 사람 확인 · 모델 · 수집·작업 · 콘텐츠 · 기록.
 * 화면과 주소는 그대로 두고 묶음만 바꿨다: 옛 작업 공간 7개(탭 28개·고급 편집기 8개)의 모든 주소가 여섯 메뉴 중 하나의 탭(과 2차 메뉴)을 켠다.
 * 한 메뉴에 탭이 많은 곳(사람 확인)은 옛 작업 공간 이름을 탭으로 두고 그 아래 옛 탭을 2차 메뉴(secondary)로 둔다.
 */
export type WorkspaceId = "home" | "people" | "models" | "sources" | "content" | "log";
export type WorkspaceLink = { id: string; label: string; href: string };
export type Workspace = { id: WorkspaceId; label: string; href: string; icon: AdminIconName; tabs: readonly WorkspaceLink[] };
/**
 * secondaryTab — 2차 메뉴에서 켤 항목(없으면 null). 주소만으로 고를 수 없는 것(심사 큐의 stage·state 추정, 요청함의 옛 주소)은
 * 해석하면서 정하고, 나머지는 2차 링크의 주소와 지금 주소를 견줘(secondaryIsActive) 정한다.
 */
export type WorkspaceLocation = { workspace: Workspace; tab: string; detail: "product" | null; secondary: readonly WorkspaceLink[]; secondaryTab: string | null };
type Search = Pick<URLSearchParams, "get">;
const none: Search = { get: () => null };

/** 고급 설정(2026-11-07 PR 5) — 편집기 목록과 「장애 분석」이 있는 화면. 옛 /admin/models?advanced=1 은 여기로 넘긴다(#조각은 브라우저가 지킨다). */
export const MODELS_ADVANCED_HREF = "/admin/models/advanced";
export const MODELS_ADVANCED_LABEL = "고급 설정";
/**
 * 고급 설정 아래 편집기 — 메뉴 이름, 화면 제목(h1·title), 다른 화면의 링크 글자가 모두 이 이름 하나를 쓴다.
 * purpose 는 고급 설정 목록에 보이는 한 줄(무엇을 하고 언제 여는지)이다.
 */
export const MODELS_ADVANCED_EDITORS = [
  { id: "limits", label: "실시간 한도", href: "/admin/models/limits",
    purpose: "AI 작업마다 한 번 호출 상한·한 틱 시간·동시 호출을 24시간 실측과 함께 봅니다. 호출이 잘리거나 틱 끝에서 끊길 때 엽니다." },
  { id: "devices", label: "장비 한도", href: "/admin/models/devices",
    purpose: "장비(엔진)마다 동시에 처리하는 칸 수와 역할 순서를 바꿉니다. 한 장비가 늘 가득 차거나 칸 수를 고칠 때 엽니다." },
  // step 3(2026-11-08): 장비 한도의 칸을 작업 영역마다 보장·상한으로 나누는 배분표 — 장비 한도 바로 다음
  { id: "allocation", label: "칸 배분", href: "/admin/models/allocation",
    purpose: "장비 한 대의 칸을 작업 영역마다 보장·상한으로 나눕니다. 한 작업이 장비를 독차지하거나 다른 작업이 늘 밀릴 때 엽니다." },
  { id: "helpers", label: "도우미·감시자", href: "/admin/models/helpers",
    purpose: "쉬는 장비가 1·2차 검수를 돕는 배정과 Oracle 감시자를 다룹니다. 도우미를 켜거나 자동 정지를 풀 때 엽니다." },
  { id: "assignments", label: "모델 배정 표", href: "/admin/models/assignments",
    purpose: "단계 × 장비 × 모델 배정 표와 배정 표 읽기 스위치입니다. 배정 표로 모델을 고르기 시작하거나 행을 고칠 때 엽니다." },
  { id: "contracts", label: "서빙 계약·등록부", href: "/admin/models/contracts",
    purpose: "모델을 부르는 주소·응답 모델·토큰 한도 계약과 모델 등록부입니다. 엔진을 직접 연결하거나 등록부 값을 고칠 때 엽니다." },
  { id: "human", label: "사람 위임 모델", href: "/admin/models/human",
    purpose: "사람 확인 단계를 모델에 맡기는 스위치와 그 모델입니다. 사람 검토 큐를 모델에 맡기거나 끌 때 엽니다." },
  { id: "search", label: "검색 모델", href: "/admin/models/search",
    purpose: "의미 검색 임베딩·재정렬 모델과 호환성 확인입니다. 검색 서버나 모델을 바꿀 때 엽니다." },
] as const satisfies readonly (WorkspaceLink & { purpose: string })[];
export type ModelsAdvancedEditorId = (typeof MODELS_ADVANCED_EDITORS)[number]["id"];
/** 편집기 하나의 이름·주소 — 하위 화면의 제목과 뒤로 가기·건너가기 링크가 쓴다 */
export const modelsAdvancedEditor = (id: ModelsAdvancedEditorId) => MODELS_ADVANCED_EDITORS.find(editor => editor.id === id)!;
/**
 * 사람 위임 모델은 고급 설정 목록(화면)에는 그대로 남지만 메뉴는 「사람 확인」의 탭이다 — 사람 확인 단계를 모델에 맡기는 스위치라서.
 * 모델 메뉴의 고급 설정 2차 메뉴는 이것을 뺀 편집기 일곱 개다.
 */
const PEOPLE_DELEGATE_EDITOR = modelsAdvancedEditor("human");
/** 수집·작업 · 수집원과 주기 작업(운영 콘솔 개편 조각 4a) — 메뉴 「수집·작업」의 기본 화면. 수집원 추가는 그 아래 /new */
export const SOURCES_HREF = "/admin/sources";
/** 사람 확인 · 묶음(운영 콘솔 개편 조각 3b) — 메뉴 「사람 확인」의 기본 화면. lib/crawl/human-batch-model.ts HUMAN_BATCHES_HREF 와 같다 */
export const PEOPLE_BATCHES_HREF = "/admin/review/batches";
const MODELS_MENU_EDITORS = MODELS_ADVANCED_EDITORS.filter(editor => editor.id !== PEOPLE_DELEGATE_EDITOR.id);
/**
 * 운영 콘솔(2026-11-12 조각 3a): /admin/models 는 모델 목록이 되고, 그 자리에 있던 LLM 운영 대시보드는 이 주소로 옮겼다(화면은 그대로).
 * 대시보드·LLM 운영(연결)은 「고급 설정」의 2차 메뉴에서 연다.
 */
export const MODELS_DASHBOARD_HREF = "/admin/models/dashboard";
export const MODELS_LLM_HREF = "/admin/models/llm";
/** 모델 메뉴 › 목록 아래 화면 — 모델 추가 세 걸음과 표본 비교(조각 3a) */
const MODELS_LIST_PATHS: readonly string[] = ["/admin/models/new", "/admin/models/compare"];
/** 모델 메뉴 › 고급 설정 아래 화면(목록 자체 + 대시보드·LLM 운영 + 편집기 일곱) */
const MODELS_ADVANCED_PATHS: readonly string[] = [MODELS_ADVANCED_HREF, MODELS_DASHBOARD_HREF, MODELS_LLM_HREF, ...MODELS_MENU_EDITORS.map(editor => editor.href)];
/**
 * 옛 「LLM 운영」 탭(?tab=) → 새 화면. live 는 대시보드(이제 고급 설정 아래), 용량·장비와 연결은 LLM 운영(연결 행에 한도·편집을 합침), 모르는 값은 모델 목록.
 * 옛 기록 탭은 기록 메뉴의 「LLM 기록」이다.
 */
const MODELS_LEGACY_TABS: Readonly<Record<string, { menu: WorkspaceId; tab: string; href: string; secondary?: "dashboard" | "llm" }>> = {
  live: { menu: "models", tab: "advanced", href: MODELS_DASHBOARD_HREF, secondary: "dashboard" },
  tasks: { menu: "models", tab: "tasks", href: "/admin/models/tasks" },
  connections: { menu: "models", tab: "advanced", href: MODELS_LLM_HREF, secondary: "llm" },
  capacity: { menu: "models", tab: "advanced", href: MODELS_LLM_HREF, secondary: "llm" },
  history: { menu: "log", tab: "llm", href: "/admin/models/history" },
};
const modelsLegacyTab = (tab: string | null) => tab !== null && Object.hasOwn(MODELS_LEGACY_TABS, tab) ? MODELS_LEGACY_TABS[tab] : null;
/**
 * /admin/models 의 옛 주소를 새 화면으로 넘길 곳. 넘길 것이 없으면 null(그대로 그린다).
 * advanced=1 이 있으면 tab 과 상관없이 고급 설정 화면이다 — 옛 #model-settings 같은 조각은 브라우저가 넘김 뒤에도 지킨다.
 */
export function modelsLegacyTabHref(search: Search): string | null {
  if (search.get("advanced") === "1") return MODELS_ADVANCED_HREF;
  const tab = search.get("tab");
  if (tab === null) return null;
  return modelsLegacyTab(tab)?.href ?? "/admin/models";
}

/**
 * 메뉴 여섯과 그 탭. 탭 이름은 옛 메뉴의 것을 그대로 쓴다(새로 생긴 탭은 그 화면이 이미 쓰는 이름 — 운영센터의 「작업 흐름」·「크롤러 활동」).
 * - 홈: 운영 홈(할 일·흐름·바꾼 것 지켜보기, 단계 패널 ?stage=)과 흐름 상세(지금까지의 실시간 전체 흐름 — 옛 ?tab=flow 도 이 탭)·시스템 진단·할 일·변경 기록.
 *   오늘 할 일은 「할 일·변경 기록」의 2차 메뉴.
 * - 사람 확인: 묶음(기본 화면, 조각 3b)과 옛 「검수 및 발행」(하나씩 보기)·「요청함」, 품질관리·사람 위임 모델. 검수·요청함·품질관리는 옛 탭을 2차 메뉴로 둔다.
 * - 모델: 옛 「LLM 운영」에서 기록을 뺀 것. 고급 편집기는 「고급 설정」의 2차 메뉴.
 * - 수집·작업: 옛 설정의 수집·판정·분류·근거·외부 연동과 운영센터(/admin/status)의 작업 흐름·크롤러 활동.
 * - 콘텐츠: 옛 「프로젝트」(품질관리 제외)와 「콘텐츠 운영」.
 * - 기록: 운영 기록·변경 기록(작업 로그)·LLM 기록.
 */
export const WORKSPACES: readonly Workspace[] = [
  { id: "home", label: "홈", href: "/admin/flow", icon: "flow", tabs: [
    { id: "home", label: "운영 홈", href: "/admin/flow" },
    { id: "detail", label: "흐름 상세", href: "/admin/flow?tab=detail" },
    { id: "diagnostics", label: "시스템 진단", href: "/admin/flow?tab=diagnostics" },
    { id: "changes", label: "할 일·변경 기록", href: "/admin/flow?tab=changes" },
  ] },
  // 조각 3b: 기본 화면은 묶음(/admin/review/batches). 옛 목록·상세(검수 및 발행)는 「하나씩 보기」로 그대로 둔다
  { id: "people", label: "사람 확인", href: PEOPLE_BATCHES_HREF, icon: "check", tabs: [
    { id: "batches", label: "묶음", href: PEOPLE_BATCHES_HREF },
    { id: "review", label: "검수 및 발행", href: "/admin/review" },
    { id: "requests", label: "요청함", href: "/admin/requests" },
    { id: "quality", label: "품질관리", href: "/admin/products?tab=quality" },
    { id: "delegate", label: PEOPLE_DELEGATE_EDITOR.label, href: PEOPLE_DELEGATE_EDITOR.href },
  ] },
  // 운영 콘솔(2026-11-12 조각 3a): 기본은 모델 목록(/admin/models). 옛 대시보드·LLM 운영은 「고급 설정」의 2차 메뉴. 옛 ?tab= 주소는 modelsLegacyTabHref 로 넘긴다.
  { id: "models", label: "모델", href: "/admin/models", icon: "sliders", tabs: [
    { id: "list", label: "모델 목록", href: "/admin/models" },
    { id: "tasks", label: "작업 배정", href: "/admin/models/tasks" },
    { id: "advanced", label: MODELS_ADVANCED_LABEL, href: MODELS_ADVANCED_HREF },
  ] },
  // 운영 콘솔(2026-11-12 조각 4a): 기본은 수집원·주기 작업(/admin/sources) — 모델을 쓰지 않는 들어오는 곳과 주기 작업. 옛 설정·작업 흐름 탭은 그대로
  { id: "sources", label: "수집·작업", href: SOURCES_HREF, icon: "pulse", tabs: [
    { id: "sources", label: "수집원·주기 작업", href: SOURCES_HREF },
    { id: "collection", label: "수집·판정", href: "/admin/settings?tab=collection" },
    { id: "crawlers", label: "크롤러 활동", href: "/admin/status?tab=crawlers" },
    { id: "jobs", label: "작업 흐름", href: "/admin/status?tab=jobs" },
    { id: "evidence", label: "분류·근거", href: "/admin/settings?tab=evidence" },
    { id: "integrations", label: "외부 연동", href: "/admin/settings?tab=integrations" },
  ] },
  { id: "content", label: "콘텐츠", href: "/admin/products", icon: "box", tabs: [
    { id: "products", label: "전체 프로젝트", href: "/admin/products" },
    { id: "translations", label: "소개·번역", href: "/admin/products?tab=translations" },
    { id: "social", label: "SNS 화제", href: "/admin/content?tab=social" },
    { id: "news", label: "AI 소식", href: "/admin/content?tab=news" },
    { id: "ranking", label: "랭킹·공개 목록", href: "/admin/content?tab=ranking" },
  ] },
  { id: "log", label: "기록", href: "/admin/settings?tab=history", icon: "clock", tabs: [
    { id: "history", label: "운영 기록", href: "/admin/settings?tab=history" },
    { id: "changes", label: "변경 기록", href: "/admin/activity" },
    { id: "llm", label: "LLM 기록", href: "/admin/models/history" },
  ] },
];
const menu = (id: WorkspaceId) => WORKSPACES.find(workspace => workspace.id === id)!;
export const WORKSPACE_GROUPS = [
  { title: "매일 운영", pages: (["home", "people", "models", "sources"] as const).map(menu) },
  { title: "필요할 때", pages: (["content", "log"] as const).map(menu) },
] as const;

export const WORKSPACE_SECONDARY = {
  homeChanges: [
    { id: "inbox", label: "오늘 할 일", href: "/admin/inbox" },
    { id: "changes", label: "변경 기록", href: "/admin/activity?workspace=home&group=settings" },
  ],
  /** 사람 확인 › 검수 및 발행 — 옛 「검수 및 발행」의 탭 넷 */
  review: [
    { id: "human", label: "사람 확인", href: "/admin/review?tab=human" },
    { id: "all", label: "전체 단계", href: "/admin/review?tab=all" },
    { id: "publish", label: "발행 대기", href: "/admin/review?tab=publish&stage=publish" },
    { id: "rejected", label: "반려 기록", href: "/admin/review?tab=rejected&stage=rejected" },
  ],
  /** 사람 확인 › 요청함 — 옛 「요청함」의 탭 여섯 */
  requests: [
    { id: "open", label: "처리 필요", href: "/admin/requests?tab=open" },
    { id: "correction", label: "내림·수정", href: "/admin/requests?tab=correction" },
    { id: "contact", label: "문의", href: "/admin/requests?tab=contact" },
    { id: "posts", label: "글 검수", href: "/admin/requests?tab=posts" },
    { id: "registration", label: "등록·인증 현황", href: "/admin/requests?tab=registration" },
    { id: "history", label: "처리 기록", href: "/admin/requests?tab=history" },
  ],
  /** 고급 설정 — 처음 설정하거나 장애를 분석할 때 여는 편집기. 이름은 MODELS_ADVANCED_EDITORS 하나에서 온다(사람 위임 모델은 사람 확인 메뉴). */
  modelsAdvanced: [
    { id: "overview", label: MODELS_ADVANCED_LABEL, href: MODELS_ADVANCED_HREF },
    // 옛 기본 화면 둘(2026-11-07 LLM 운영 개편 PR 1·2) — 모델 목록이 기본이 된 뒤 여기서 연다(조각 3a)
    { id: "dashboard", label: "대시보드", href: MODELS_DASHBOARD_HREF },
    { id: "llm", label: "LLM 운영", href: MODELS_LLM_HREF },
    ...MODELS_MENU_EDITORS.map(({ id, label, href }) => ({ id, label, href })),
  ],
  /** 사람 확인 › 품질관리 — 옛 주소(감사·공개분 2차·규칙 재검수)에서 보인다. 품질관리 화면 자체는 검사 종류 탭을 직접 그린다 */
  quality: [
    { id: "audit", label: "AI 감사·정책", href: "/admin/audit?tab=audit" },
    { id: "published", label: "공개분 2차 확인", href: "/admin/review?second=published" },
    { id: "recheck", label: "규칙 재검수", href: "/admin/products/recheck" },
  ],
  posts: [
    { id: "feedback", label: "피드백", href: "/admin/feedback" },
    { id: "replies", label: "메이커 답장", href: "/admin/maker-replies" },
    { id: "reactions", label: "써봤어요", href: "/admin/reactions" },
  ],
  evidence: [
    { id: "categories", label: "카테고리 기준", href: "/admin/categories" },
    { id: "evidence", label: "근거 수집 설정", href: "/admin/evidence" },
  ],
  integrations: [
    { id: "accounts", label: "GitHub 수집 자격", href: "/admin/github-accounts" },
    { id: "deliveries", label: "GitHub 전송 운영", href: "/admin/github-integrations" },
  ],
} as const satisfies Record<string, readonly WorkspaceLink[]>;

/** Every old administrator destination remains available in the workspace or its secondary navigation. */
export const WORKSPACE_LEGACY_SCREENS = [
  "/admin/flow", "/admin/inbox", "/admin/status", "/admin/review", "/admin/audit", "/admin/requests",
  "/admin/maker-replies", "/admin/feedback", "/admin/reactions", "/admin/translations", "/admin/github-integrations",
  "/admin/products", "/admin/products/recheck", "/admin/products/[slug]", "/admin/talk", "/admin", "/admin/models",
  "/admin/models/tasks", "/admin/models/limits", "/admin/models/devices", "/admin/models/helpers",
  "/admin/models/assignments", "/admin/models/contracts", "/admin/models/human", "/admin/models/search", "/admin/models/advanced",
  "/admin/models/dashboard", "/admin/models/llm",
  "/admin/categories", "/admin/evidence", "/admin/ranking",
  "/admin/news", "/admin/github-accounts", "/admin/activity", "/admin/login",
] as const;

/**
 * 운영 홈(/admin/flow)의 ?tab= → 탭. 비었거나 모르는 값은 운영 홈(할 일 + 흐름)이고, 옛 「실시간 전체 흐름」(?tab=flow)은 흐름 상세다.
 * 화면(flow/page.tsx)도 같은 함수로 무엇을 그릴지 정한다 — 메뉴와 화면이 다른 탭을 켜지 않게.
 */
export type HomeTab = "home" | "detail" | "diagnostics" | "changes";
export function homeTab(tab: string | null | undefined): HomeTab {
  if (tab === "detail" || tab === "flow") return "detail";
  return tab === "diagnostics" || tab === "changes" ? tab : "home";
}

/** 설정 화면(/admin/settings)이 그리는 탭 — 운영 기록(history)만 기록 메뉴다 */
const SETTINGS_SOURCE_TABS: readonly string[] = ["collection", "evidence", "integrations"];
/** 콘텐츠 운영 화면(/admin/content)이 그리는 탭 */
const CONTENT_PAGE_TABS: readonly string[] = ["social", "news", "ranking"];
const pick = (allowed: readonly string[], value: string | null, fallback: string) => value !== null && allowed.includes(value) ? value : fallback;
const ids = (links: readonly WorkspaceLink[]) => links.map(link => link.id);

type Place = { id: WorkspaceId; tab: string; secondary?: readonly WorkspaceLink[]; secondaryTab?: string };

/** 주소 하나 → 메뉴·탭·2차 메뉴. 화면과 쓰기 동작은 옮기지 않고, 옛 즐겨찾기 주소도 새 메뉴의 제자리에 켠다. */
function place(pathname: string, search: Search): Place {
  const tab = search.get("tab");
  switch (pathname) {
    case "/admin/flow": return { id: "home", tab: homeTab(tab) };
    case "/admin/inbox": return { id: "home", tab: "changes", secondary: WORKSPACE_SECONDARY.homeChanges, secondaryTab: "inbox" };
    case "/admin/activity":
      // 홈의 「할 일·변경 기록」에서 연 변경 기록(?workspace=home)은 홈에 남는다. 나머지(LLM 기록에서 연 것 포함)는 기록 메뉴
      return search.get("workspace") === "home"
        ? { id: "home", tab: "changes", secondary: WORKSPACE_SECONDARY.homeChanges, secondaryTab: "changes" }
        : { id: "log", tab: "changes" };
    case "/admin/status":
      if (tab === "manual") return { id: "people", tab: "review", secondary: WORKSPACE_SECONDARY.review, secondaryTab: "publish" };
      if (tab === "jobs" || tab === "crawlers") return { id: "sources", tab };
      return { id: "home", tab: "diagnostics" };
    case PEOPLE_BATCHES_HREF: return { id: "people", tab: "batches" };
    case "/admin/review": {
      if (search.get("second") === "published") return { id: "people", tab: "quality", secondary: WORKSPACE_SECONDARY.quality };
      const stage = search.get("stage"), state = search.get("state");
      const inferred = stage === "human" || stage === "agreed" ? "human" : stage === "publish" || state === "approved" ? "publish"
        : stage === "rejected" || state === "rejected" ? "rejected" : stage || state ? "all" : "human";
      return { id: "people", tab: "review", secondary: WORKSPACE_SECONDARY.review, secondaryTab: pick(ids(WORKSPACE_SECONDARY.review), tab, inferred) };
    }
    case "/admin/requests": {
      // Match the server adapter: old state/offset-only bookmarks open contacts; an explicit invalid tab opens the queue.
      const fallback = tab === null && (search.get("state") !== null || search.get("offset") !== null) ? "contact" : "open";
      return { id: "people", tab: "requests", secondary: WORKSPACE_SECONDARY.requests, secondaryTab: pick(ids(WORKSPACE_SECONDARY.requests), tab, fallback) };
    }
    case "/admin/audit":
      return tab === "requests"
        ? { id: "people", tab: "requests", secondary: WORKSPACE_SECONDARY.requests, secondaryTab: "correction" }
        : { id: "people", tab: "quality", secondary: WORKSPACE_SECONDARY.quality };
    case "/admin/products/recheck": return { id: "people", tab: "quality", secondary: WORKSPACE_SECONDARY.quality };
    case "/admin/feedback": case "/admin/maker-replies": case "/admin/reactions":
      return { id: "people", tab: "requests", secondary: WORKSPACE_SECONDARY.posts };
    case PEOPLE_DELEGATE_EDITOR.href: return { id: "people", tab: "delegate" };
    case "/admin/products":
      return tab === "quality" ? { id: "people", tab: "quality" } : { id: "content", tab: tab === "translations" ? "translations" : "products" };
    case "/admin/translations": return { id: "content", tab: "translations" };
    case "/admin/content": return { id: "content", tab: pick(CONTENT_PAGE_TABS, tab, "social") };
    case "/admin/talk": return { id: "content", tab: "social" };
    case "/admin/news": return { id: "content", tab: "news" };
    case "/admin/ranking": return { id: "content", tab: "ranking" };
    case "/admin/models": {
      if (search.get("advanced") === "1") return { id: "models", tab: "advanced", secondary: WORKSPACE_SECONDARY.modelsAdvanced };
      const legacy = modelsLegacyTab(tab);
      return !legacy ? { id: "models", tab: "list" } : legacy.secondary
        ? { id: legacy.menu, tab: legacy.tab, secondary: WORKSPACE_SECONDARY.modelsAdvanced, secondaryTab: legacy.secondary } : { id: legacy.menu, tab: legacy.tab };
    }
    case "/admin/models/tasks": return { id: "models", tab: "tasks" };
    case "/admin/models/history": return { id: "log", tab: "llm" };
    case "/admin/settings": return tab === "history" ? { id: "log", tab: "history" } : { id: "sources", tab: pick(SETTINGS_SOURCE_TABS, tab, "collection") };
    case "/admin": return { id: "sources", tab: "collection" };
    case SOURCES_HREF: case "/admin/sources/new": return { id: "sources", tab: "sources" };
    case "/admin/categories": case "/admin/evidence": return { id: "sources", tab: "evidence", secondary: WORKSPACE_SECONDARY.evidence };
    case "/admin/github-accounts": case "/admin/github-integrations": return { id: "sources", tab: "integrations", secondary: WORKSPACE_SECONDARY.integrations };
  }
  if (MODELS_ADVANCED_PATHS.includes(pathname)) return { id: "models", tab: "advanced", secondary: WORKSPACE_SECONDARY.modelsAdvanced };
  if (MODELS_LIST_PATHS.includes(pathname) || pathname.startsWith("/admin/models/")) return { id: "models", tab: "list" };
  if (pathname.startsWith("/admin/products/")) return { id: "content", tab: "products" };
  return { id: "home", tab: "home" };
}

/** Query-aware ownership keeps old bookmarked screens in their new menu without moving any mutations. */
export function resolveWorkspace(pathname: string, search: Search = none): WorkspaceLocation {
  const found = place(pathname, search);
  const secondary = found.secondary ?? [];
  const secondaryTab = found.secondaryTab ?? secondary.find(link => secondaryIsActive(link, pathname, search))?.id ?? null;
  return { workspace: menu(found.id), tab: found.tab, secondary, secondaryTab,
    detail: pathname.startsWith("/admin/products/") && pathname !== "/admin/products/recheck" ? "product" : null };
}

export function secondaryIsActive(link: WorkspaceLink, pathname: string, search: Search): boolean {
  const expected = new URL(link.href, "https://admin.invalid");
  if (expected.pathname !== pathname) return false;
  if (pathname === "/admin/audit" && link.id === "audit") return search.get("tab") !== "requests";
  for (const [key, value] of expected.searchParams) if (search.get(key) !== value) return false;
  return true;
}
