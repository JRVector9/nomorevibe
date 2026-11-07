import type { AdminIconName } from "./components/AdminIcon";

/** Stable URLs are kept as deep links; only the seven workspace destinations form the primary menu. */
export type WorkspaceId = "home" | "review" | "requests" | "projects" | "models" | "content" | "settings";
export type WorkspaceLink = { id: string; label: string; href: string };
export type Workspace = { id: WorkspaceId; label: string; href: string; icon: AdminIconName; tabs: readonly WorkspaceLink[] };
export type WorkspaceLocation = { workspace: Workspace; tab: string; detail: "product" | null; secondary: readonly WorkspaceLink[] };
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
    purpose: "경로별 출력 토큰·동시 호출·호출 상한, 번역 묶음, 틱 예산을 바꿉니다. 시간 초과가 잦거나 묶음 크기를 바꿀 때 엽니다." },
  { id: "devices", label: "장비 한도", href: "/admin/models/devices",
    purpose: "장비(엔진)마다 동시에 처리하는 칸 수와 역할 순서를 바꿉니다. 한 장비가 늘 가득 차거나 칸 수를 고칠 때 엽니다." },
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
/** 고급 설정 아래 화면(목록 자체 + 편집기) */
const MODELS_ADVANCED_PATHS: readonly string[] = [MODELS_ADVANCED_HREF, ...MODELS_ADVANCED_EDITORS.map(editor => editor.href)];
/** 옛 「LLM 운영」 탭(?tab=) → 새 화면. live·모르는 값은 대시보드, 용량·장비와 연결은 LLM 운영(연결 행에 한도·편집을 합침). */
const MODELS_LEGACY_TABS: Readonly<Record<string, { tab: string; href: string }>> = {
  live: { tab: "dashboard", href: "/admin/models" },
  tasks: { tab: "tasks", href: "/admin/models/tasks" },
  connections: { tab: "llm", href: "/admin/models/llm" },
  capacity: { tab: "llm", href: "/admin/models/llm" },
  history: { tab: "history", href: "/admin/models/history" },
};
/**
 * /admin/models 의 옛 주소를 새 화면으로 넘길 곳. 넘길 것이 없으면 null(그대로 그린다).
 * advanced=1 이 있으면 tab 과 상관없이 고급 설정 화면이다 — 옛 #model-settings 같은 조각은 브라우저가 넘김 뒤에도 지킨다.
 */
export function modelsLegacyTabHref(search: Search): string | null {
  if (search.get("advanced") === "1") return MODELS_ADVANCED_HREF;
  const tab = search.get("tab");
  if (tab === null) return null;
  return MODELS_LEGACY_TABS[tab]?.href ?? "/admin/models";
}

export const WORKSPACES: readonly Workspace[] = [
  { id: "home", label: "운영 홈", href: "/admin/flow", icon: "flow", tabs: [
    { id: "flow", label: "실시간 전체 흐름", href: "/admin/flow" },
    { id: "diagnostics", label: "시스템 진단", href: "/admin/flow?tab=diagnostics" },
    { id: "changes", label: "할 일·변경 기록", href: "/admin/flow?tab=changes" },
  ] },
  { id: "review", label: "검수 및 발행", href: "/admin/review", icon: "check", tabs: [
    { id: "human", label: "사람 확인", href: "/admin/review?tab=human" },
    { id: "all", label: "전체 단계", href: "/admin/review?tab=all" },
    { id: "publish", label: "발행 대기", href: "/admin/review?tab=publish&stage=publish" },
    { id: "rejected", label: "반려 기록", href: "/admin/review?tab=rejected&stage=rejected" },
  ] },
  { id: "requests", label: "요청함", href: "/admin/requests", icon: "inbox", tabs: [
    { id: "open", label: "처리 필요", href: "/admin/requests?tab=open" },
    { id: "correction", label: "내림·수정", href: "/admin/requests?tab=correction" },
    { id: "contact", label: "문의", href: "/admin/requests?tab=contact" },
    { id: "posts", label: "글 검수", href: "/admin/requests?tab=posts" },
    { id: "registration", label: "등록·인증 현황", href: "/admin/requests?tab=registration" },
    { id: "history", label: "처리 기록", href: "/admin/requests?tab=history" },
  ] },
  { id: "projects", label: "프로젝트", href: "/admin/products", icon: "box", tabs: [
    { id: "all", label: "전체 프로젝트", href: "/admin/products" },
    { id: "quality", label: "품질관리", href: "/admin/products?tab=quality" },
    { id: "translations", label: "소개·번역", href: "/admin/products?tab=translations" },
  ] },
  // 2026-11-07 LLM 운영 개편(PR 1·2): 화면 4개 + 고급 설정. 옛 ?tab= 주소는 modelsLegacyTabHref 로 새 화면에 넘긴다.
  { id: "models", label: "LLM 운영", href: "/admin/models", icon: "sliders", tabs: [
    { id: "dashboard", label: "대시보드", href: "/admin/models" },
    { id: "llm", label: "LLM 운영", href: "/admin/models/llm" },
    { id: "tasks", label: "작업 배정", href: "/admin/models/tasks" },
    { id: "history", label: "기록", href: "/admin/models/history" },
    { id: "advanced", label: MODELS_ADVANCED_LABEL, href: MODELS_ADVANCED_HREF },
  ] },
  { id: "content", label: "콘텐츠 운영", href: "/admin/content", icon: "news", tabs: [
    { id: "social", label: "SNS 화제", href: "/admin/content?tab=social" },
    { id: "news", label: "AI 소식", href: "/admin/content?tab=news" },
    { id: "ranking", label: "랭킹·공개 목록", href: "/admin/content?tab=ranking" },
  ] },
  { id: "settings", label: "설정·기록", href: "/admin/settings", icon: "tag", tabs: [
    { id: "collection", label: "수집·판정", href: "/admin/settings?tab=collection" },
    { id: "evidence", label: "분류·근거", href: "/admin/settings?tab=evidence" },
    { id: "integrations", label: "외부 연동", href: "/admin/settings?tab=integrations" },
    { id: "history", label: "운영 기록", href: "/admin/settings?tab=history" },
  ] },
];
export const WORKSPACE_GROUPS = [
  { title: "매일 운영", pages: WORKSPACES.slice(0, 5) },
  { title: "필요할 때", pages: WORKSPACES.slice(5) },
] as const;

export const WORKSPACE_SECONDARY = {
  homeChanges: [
    { id: "inbox", label: "오늘 할 일", href: "/admin/inbox" },
    { id: "changes", label: "변경 기록", href: "/admin/activity?workspace=home&group=settings" },
  ],
  /** 고급 설정 — 처음 설정하거나 장애를 분석할 때 여는 편집기. 이름은 MODELS_ADVANCED_EDITORS 하나에서 온다. */
  modelsAdvanced: [
    { id: "overview", label: MODELS_ADVANCED_LABEL, href: MODELS_ADVANCED_HREF },
    ...MODELS_ADVANCED_EDITORS.map(({ id, label, href }) => ({ id, label, href })),
  ],
  projectQuality: [
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
  "/admin/categories", "/admin/evidence", "/admin/ranking",
  "/admin/news", "/admin/github-accounts", "/admin/activity", "/admin/login",
] as const;

const get = (id: WorkspaceId) => WORKSPACES.find(workspace => workspace.id === id)!;
const validTab = (id: WorkspaceId, tab: string | null, fallback: string) => get(id).tabs.some(item => item.id === tab) ? tab! : fallback;

/** Query-aware ownership keeps old bookmarked screens in their new workspace without moving any mutations. */
export function resolveWorkspace(pathname: string, search: Search = none): WorkspaceLocation {
  let id: WorkspaceId = "home", tab = "flow";
  if (pathname === "/admin/flow") {
    tab = validTab("home", search.get("tab"), "flow");
  } else if (pathname === "/admin/activity") {
    const requested = search.get("workspace");
    id = requested === "home" ? "home" : requested === "models" ? "models" : "settings";
    tab = id === "home" ? "changes" : "history";
  } else if (pathname === "/admin/status" && search.get("tab") === "manual") {
    id = "review"; tab = "publish";
  } else if (pathname === "/admin/status") {
    tab = "diagnostics";
  } else if (pathname === "/admin/inbox") {
    tab = "changes";
  } else if (pathname === "/admin/audit" && search.get("tab") === "requests") {
    id = "requests"; tab = "correction";
  } else if (pathname === "/admin/audit" || pathname === "/admin/products/recheck" || (pathname === "/admin/review" && search.get("second") === "published")) {
    id = "projects"; tab = "quality";
  } else if (pathname === "/admin/review") {
    id = "review";
    const stage = search.get("stage"), state = search.get("state");
    const inferred = stage === "human" || stage === "agreed" ? "human" : stage === "publish" || state === "approved" ? "publish" : stage === "rejected" || state === "rejected" ? "rejected" : stage || state ? "all" : "human";
    tab = validTab(id, search.get("tab"), inferred);
  } else if (pathname === "/admin/requests") {
    id = "requests";
    const requested = search.get("tab");
    // Match the server adapter: old state/offset-only bookmarks open contacts; an explicit invalid tab opens the queue.
    const fallback = requested === null && (search.get("state") !== null || search.get("offset") !== null) ? "contact" : "open";
    tab = validTab(id, requested, fallback);
  } else if (["/admin/feedback", "/admin/maker-replies", "/admin/reactions"].includes(pathname)) {
    id = "requests"; tab = "posts";
  } else if (pathname === "/admin/translations") {
    id = "projects"; tab = "translations";
  } else if (pathname === "/admin/products") {
    id = "projects"; tab = validTab(id, search.get("tab"), "all");
  } else if (pathname.startsWith("/admin/products/")) {
    id = "projects"; tab = "all";
  } else if (pathname === "/admin/models/tasks") {
    id = "models"; tab = "tasks";
  } else if (pathname === "/admin/models/llm") {
    id = "models"; tab = "llm";
  } else if (pathname === "/admin/models/history") {
    id = "models"; tab = "history";
  } else if (MODELS_ADVANCED_PATHS.includes(pathname)) {
    id = "models"; tab = "advanced";
  } else if (pathname === "/admin/models") {
    id = "models";
    const legacy = search.get("tab");
    tab = search.get("advanced") === "1" ? "advanced" : legacy !== null ? MODELS_LEGACY_TABS[legacy]?.tab ?? "dashboard" : "dashboard";
  } else if (pathname.startsWith("/admin/models/")) {
    id = "models"; tab = "dashboard";
  } else if (pathname === "/admin/content") {
    id = "content"; tab = validTab(id, search.get("tab"), "social");
  } else if (["/admin/talk", "/admin/news", "/admin/ranking"].includes(pathname)) {
    id = "content"; tab = pathname === "/admin/news" ? "news" : pathname === "/admin/ranking" ? "ranking" : "social";
  } else if (pathname === "/admin/settings") {
    id = "settings"; tab = validTab(id, search.get("tab"), "collection");
  } else if (["/admin/categories", "/admin/evidence"].includes(pathname)) {
    id = "settings"; tab = "evidence";
  } else if (["/admin/github-accounts", "/admin/github-integrations"].includes(pathname)) {
    id = "settings"; tab = "integrations";
  } else if (pathname === "/admin") {
    id = "settings"; tab = "collection";
  }
  const secondary = id === "home" && tab === "changes" && pathname !== "/admin/flow" ? WORKSPACE_SECONDARY.homeChanges
    : id === "models" && tab === "advanced" ? WORKSPACE_SECONDARY.modelsAdvanced
    : id === "projects" && tab === "quality" && pathname !== "/admin/products" ? WORKSPACE_SECONDARY.projectQuality
    : id === "requests" && tab === "posts" && pathname !== "/admin/requests" ? WORKSPACE_SECONDARY.posts
    : id === "settings" && tab === "evidence" && pathname !== "/admin/settings" ? WORKSPACE_SECONDARY.evidence
    : id === "settings" && tab === "integrations" && pathname !== "/admin/settings" ? WORKSPACE_SECONDARY.integrations : [];
  return { workspace: get(id), tab, detail: pathname.startsWith("/admin/products/") && pathname !== "/admin/products/recheck" ? "product" : null, secondary };
}

export function secondaryIsActive(link: WorkspaceLink, pathname: string, search: Search): boolean {
  const expected = new URL(link.href, "https://admin.invalid");
  if (expected.pathname !== pathname) return false;
  if (pathname === "/admin/audit" && link.id === "audit") return search.get("tab") !== "requests";
  for (const [key, value] of expected.searchParams) if (search.get(key) !== value) return false;
  return true;
}
