import type { AdminIconName } from "./components/AdminIcon";

/** Stable URLs are kept as deep links; only the seven workspace destinations form the primary menu. */
export type WorkspaceId = "home" | "review" | "requests" | "projects" | "models" | "content" | "settings";
export type WorkspaceLink = { id: string; label: string; href: string };
export type Workspace = { id: WorkspaceId; label: string; href: string; icon: AdminIconName; tabs: readonly WorkspaceLink[] };
export type WorkspaceLocation = { workspace: Workspace; tab: string; detail: "product" | null; secondary: readonly WorkspaceLink[] };
type Search = Pick<URLSearchParams, "get">;
const none: Search = { get: () => null };

export const WORKSPACES: readonly Workspace[] = [
  { id: "home", label: "운영 홈", href: "/admin/flow", icon: "flow", tabs: [
    { id: "flow", label: "실시간 전체 흐름", href: "/admin/flow" },
    { id: "diagnostics", label: "시스템 진단", href: "/admin/status" },
    { id: "changes", label: "할 일·변경 기록", href: "/admin/activity?workspace=home&group=settings" },
  ] },
  { id: "review", label: "검수 및 발행", href: "/admin/review", icon: "check", tabs: [
    { id: "human", label: "사람 확인", href: "/admin/review?stage=human" },
    { id: "all", label: "전체 단계", href: "/admin/review" },
    { id: "publish", label: "발행 대기", href: "/admin/review?stage=publish" },
    { id: "rejected", label: "반려 기록", href: "/admin/review?stage=rejected" },
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
    { id: "quality", label: "품질관리", href: "/admin/audit?tab=audit" },
    { id: "translations", label: "소개·번역", href: "/admin/translations" },
  ] },
  { id: "models", label: "LLM 운영", href: "/admin/models", icon: "sliders", tabs: [
    { id: "live", label: "실시간", href: "/admin/models" },
    { id: "tasks", label: "작업별 모델", href: "/admin/models/tasks" },
    { id: "capacity", label: "용량·장비", href: "/admin/models/devices" },
    { id: "connections", label: "연결", href: "/admin/models/contracts" },
    { id: "history", label: "조치 기록", href: "/admin/activity?workspace=models&group=settings" },
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
  modelsCapacity: [
    { id: "devices", label: "장비 한도", href: "/admin/models/devices" },
    { id: "limits", label: "실시간 한도", href: "/admin/models/limits" },
    { id: "helpers", label: "도우미 장비", href: "/admin/models/helpers" },
  ],
  modelTasks: [
    { id: "tasks", label: "작업별 순위", href: "/admin/models/tasks" },
    { id: "assignments", label: "배정 표·적용 출처", href: "/admin/models/assignments" },
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
  "/admin/models/assignments", "/admin/models/contracts", "/admin/categories", "/admin/evidence", "/admin/ranking",
  "/admin/news", "/admin/github-accounts", "/admin/activity", "/admin/login",
] as const;

const get = (id: WorkspaceId) => WORKSPACES.find(workspace => workspace.id === id)!;
const validTab = (id: WorkspaceId, tab: string | null, fallback: string) => get(id).tabs.some(item => item.id === tab) ? tab! : fallback;

/** Query-aware ownership keeps old bookmarked screens in their new workspace without moving any mutations. */
export function resolveWorkspace(pathname: string, search: Search = none): WorkspaceLocation {
  let id: WorkspaceId = "home", tab = "flow";
  if (pathname === "/admin/activity") {
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
    tab = stage === "human" || stage === "agreed" ? "human" : stage === "publish" || state === "approved" ? "publish" : stage === "rejected" || state === "rejected" ? "rejected" : "all";
  } else if (pathname === "/admin/requests") {
    id = "requests"; tab = validTab(id, search.get("tab"), "open");
  } else if (["/admin/feedback", "/admin/maker-replies", "/admin/reactions"].includes(pathname)) {
    id = "requests"; tab = "posts";
  } else if (pathname === "/admin/translations") {
    id = "projects"; tab = "translations";
  } else if (pathname === "/admin/products" || pathname.startsWith("/admin/products/")) {
    id = "projects"; tab = "all";
  } else if (pathname === "/admin/models/tasks" || pathname === "/admin/models/assignments") {
    id = "models"; tab = "tasks";
  } else if (["/admin/models/devices", "/admin/models/limits", "/admin/models/helpers"].includes(pathname)) {
    id = "models"; tab = "capacity";
  } else if (pathname === "/admin/models/contracts") {
    id = "models"; tab = "connections";
  } else if (pathname === "/admin/models" || pathname.startsWith("/admin/models/")) {
    id = "models"; tab = "live";
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
  const secondary = id === "home" && tab === "changes" ? WORKSPACE_SECONDARY.homeChanges
    : id === "models" && tab === "capacity" ? WORKSPACE_SECONDARY.modelsCapacity
    : id === "models" && tab === "tasks" ? WORKSPACE_SECONDARY.modelTasks
    : id === "projects" && tab === "quality" ? WORKSPACE_SECONDARY.projectQuality
    : id === "requests" && tab === "posts" ? WORKSPACE_SECONDARY.posts
    : id === "settings" && tab === "evidence" ? WORKSPACE_SECONDARY.evidence
    : id === "settings" && tab === "integrations" ? WORKSPACE_SECONDARY.integrations : [];
  return { workspace: get(id), tab, detail: pathname.startsWith("/admin/products/") && pathname !== "/admin/products/recheck" ? "product" : null, secondary };
}

export function secondaryIsActive(link: WorkspaceLink, pathname: string, search: Search): boolean {
  const expected = new URL(link.href, "https://admin.invalid");
  if (expected.pathname !== pathname) return false;
  if (pathname === "/admin/audit" && link.id === "audit") return search.get("tab") !== "requests";
  for (const [key, value] of expected.searchParams) if (search.get(key) !== value) return false;
  return true;
}
