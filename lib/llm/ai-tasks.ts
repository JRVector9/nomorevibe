/**
 * AI 를 쓰는 작업 목록(2026-11-02 소유자 결정 「작업 ↔ AI 모델 1~3순위」, PR A). 순수 모듈 — 화면 구성 요소도 읽는다.
 *
 * 작업은 기능이라 코드에 둔다. 그러나 **모델 이름·주소·환경변수 이름은 여기 없다** — 무엇을 부를지는 운영자가 「AI 연결」(ai_connections)과
 * 「작업 ↔ 모델」(ai_task_models)에 저장한 것만이다. 여기 있는 것은 작업 id·쉬운 이름·종류(chat·vision·embedding·rerank)·받는 연결 종류·칸 수와,
 * 오늘의 실행 경로를 가리키는 이름(용량 route id·지금 고르기 출처의 단계 id·잡 이름)뿐이다. 이 이름들은 PR B~D 가 실행 쪽을 옮길 때 같은 작업을 찾는 열쇠다.
 *
 * PR B 부터 text 일곱 작업, PR C1 부터 심사 둘(1차·2차)과 Grok 로그인 유지가 이 목록과 표를 읽는다. 나머지는 관리 화면이 저장·비교만 한다.
 */

export const AI_CLI_TOOLS = Object.freeze(["claude", "codex", "grok", "opencode"] as const);
export type AiCliTool = (typeof AI_CLI_TOOLS)[number];
/** CLI 도구 → 오늘 용량 장부·계약의 provider 이름. */
export const AI_CLI_TOOL_PROVIDERS: Readonly<Record<AiCliTool, "claude-cli" | "codex-cli" | "grok-cli" | "opencode-cli">> = Object.freeze({
  claude: "claude-cli", codex: "codex-cli", grok: "grok-cli", opencode: "opencode-cli" });
export const AI_CLI_TOOL_LABELS: Readonly<Record<AiCliTool, string>> = Object.freeze({ claude: "Claude CLI", codex: "Codex CLI", grok: "Grok CLI", opencode: "OpenCode CLI" });
export const aiCliToolOfProvider = (provider: string): AiCliTool | null =>
  (Object.entries(AI_CLI_TOOL_PROVIDERS) as [AiCliTool, string][]).find(([, value]) => value === provider)?.[0] ?? null;

export const AI_TASK_KINDS = Object.freeze(["chat", "vision", "embedding", "rerank"] as const);
export type AiTaskKind = (typeof AI_TASK_KINDS)[number];
export const AI_TASK_KIND_LABELS: Readonly<Record<AiTaskKind, string>> = Object.freeze({ chat: "대화", vision: "이미지 판별", embedding: "벡터", rerank: "재정렬" });

/**
 * API 연결로 부를 때 오늘 실행 쪽이 요구하는 것(PR A 순위 저장이 확인·준비한다):
 * - engine-route: 엔진 직접 계약(경로, 모델; abcllm 형 total-bound)과 정책 route(경로 / abcllm / 모델 / 장비). 없으면 저장이 엔진을 확인하고 만든다.
 * - review-ai1: 1차 — 엔진 직접 계약(abcllm 형 total-bound, transport direct — 없으면 engine-route 처럼 만든다) 또는 이미 있는 local-direct 계약.
 *   같은 모델을 다른 연결에도 두면 연결로 가른 장부 이름(PR C1). CLI 순위는 연결의 CLI 버전으로 CLI 계약 행을 만든다(PR C1).
 * - review-ai2: 2차 — 1차와 같다(PR C1: 2차 계약도 순위 저장이 만든다 — 예전에는 이미 있는 계약만 받았다).
 * - local-direct: 고정 로컬 경로(local-*) — 이미 있는 정책 route 와 로컬 계약(장비 backend)만. 예산·장비 이름이 계약과 같아야 열려 만들지 않는다.
 * - uncapped: 용량 장부를 거치지 않는다(임베딩·재정렬·한국어 Qwen 직접 경로). 확인할 계약·경로가 없다.
 * - deferred: 경로 규칙이 아직 없다(보강 assist 는 작업·장비마다 route 가 다르고, 감사 캠페인은 시작할 때 모델을 굳힌다) — 저장은 받고 확인하지 않았다고 알린다.
 * - audit-direct: 「발행분 감사 · 변경 재판정」(2026-11-09)의 API 순위 — 감사 직접 경로(route local-audit, 잡 audit-qwen)로 부른다. 저장이 그 연결·모델의
 *   검증된 로컬 계약(local-openai-chat-v1, 연결 주소 readback + 1토큰 시험)과 정책 route(local-audit / local-direct / 모델)를 만든다(이미 있으면 그대로 쓴다).
 *   CLI 순위는 감사 경로(routeId product-audit)의 CLI 계약을 만든다(예전 그대로).
 */
export type AiTaskApiWiring = "engine-route" | "review-ai1" | "review-ai2" | "local-direct" | "uncapped" | "deferred" | "audit-direct";
/** 「발행분 감사 · 변경 재판정」의 API 순위가 쓰는 감사 직접 경로(장부 route — local-model-capacity-contract.ts localModelRoute 의 audit 목적) */
export const AUDIT_DIRECT_ROUTE = "local-audit";

export type AiTaskGroup = "review" | "text" | "search" | "audit" | "cli";
export const AI_TASK_GROUP_LABELS: Readonly<Record<AiTaskGroup, string>> = Object.freeze({
  review: "심사", text: "글 짓기·번역", search: "검색", audit: "감사·보강", cli: "CLI 전용" });

export type AiTaskDef = Readonly<{
  id: string;
  label: string;
  group: AiTaskGroup;
  kind: AiTaskKind;
  /** API 연결(주소)을 받는가 */
  api: boolean;
  /** 받는 CLI 도구(빈 목록 = CLI 안 됨) */
  cliTools: readonly AiCliTool[];
  /** 나란한 칸 수(2차 = 투표자 3, 나머지 1) */
  slots: number;
  /** 칸 이름(여러 칸일 때만): 「투표자 1」 */
  slotLabel: string | null;
  /** 오늘의 용량 route id(장부·계약·장비 순위의 이름). 장부를 거치지 않거나 작업·장비마다 다르면 null */
  routeId: string | null;
  wiring: AiTaskApiWiring;
  /** 2·3순위도 1순위와 같은 모델이어야 한다(벡터·점수 공간이 모델마다 다르다) */
  sameModelAcrossRanks: boolean;
  /** 이 작업의 모델은 다른 작업의 1순위 모델과 같아야 한다(검색어 벡터 = 제품 벡터) */
  sameModelAs: string | null;
  /** 이 작업을 하는 카탈로그 잡(웹 요청이 하는 작업은 빈 목록) */
  jobs: readonly string[];
  /** 지금 고르기 출처: 관리자 단계 풀 id(lib/llm/admin-model-stages.ts)·배정 표 단계(lib/llm/capacity-helpers.ts) */
  adminStage: string | null;
  assignmentStage: string | null;
  /** 한 줄 설명(쉬운 말) */
  description: string;
}>;

type Draft = Omit<AiTaskDef, "slots" | "slotLabel" | "routeId" | "sameModelAcrossRanks" | "sameModelAs" | "adminStage" | "assignmentStage" | "cliTools">
  & Partial<Pick<AiTaskDef, "slots" | "slotLabel" | "routeId" | "sameModelAcrossRanks" | "sameModelAs" | "adminStage" | "assignmentStage" | "cliTools">>;
const task = (draft: Draft): AiTaskDef => Object.freeze({ slots: 1, slotLabel: null, routeId: null, sameModelAcrossRanks: false, sameModelAs: null,
  adminStage: null, assignmentStage: null, cliTools: Object.freeze([]), ...draft, jobs: Object.freeze([...draft.jobs]) });
const tools = (...values: AiCliTool[]) => Object.freeze(values);

/** 화면 순서 = 이 순서. id 는 바꾸지 않는다(ai_task_models.task 에 저장된다). */
export const AI_TASKS: readonly AiTaskDef[] = Object.freeze([
  // 심사
  task({ id: "first-review", label: "1차 AI 검수", group: "review", kind: "chat", api: true, cliTools: tools("claude", "grok", "opencode"), routeId: "crawl-agent-review",
    wiring: "review-ai1", jobs: ["crawl-agent-review"], assignmentStage: "ai1", description: "수집한 후보를 처음으로 읽고 승인·거절·보류를 정합니다." }),
  task({ id: "second-review", label: "2차 AI 검수", group: "review", kind: "chat", api: true, cliTools: tools("claude", "grok", "opencode"), slots: 3, slotLabel: "투표자",
    routeId: "second-review", wiring: "review-ai2", jobs: ["second-review"], assignmentStage: "ai2",
    description: "1차 결과를 투표자 셋이 다시 봅니다. 투표자마다 1·2·3순위를 따로 정합니다." }),
  task({ id: "human-review", label: "사람 몫 위임 검수", group: "review", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-human-deepseek", wiring: "local-direct",
    jobs: ["human-deepseek-review"], adminStage: "human-review", assignmentStage: "human", description: "사람이 볼 심사 큐를 켜 둔 동안 모델에 맡깁니다." }),
  task({ id: "split-confirm", label: "2차 갈림 재확인", group: "review", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-deepseek-confirm", wiring: "local-direct",
    jobs: ["split-confirm"], adminStage: "split-confirm", description: "2차가 갈린 후보를 한 번 더 확인합니다." }),
  task({ id: "split-tiebreak", label: "2차 갈림 판가름", group: "review", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-qwen-tiebreak", wiring: "local-direct",
    jobs: ["split-tiebreak"], adminStage: "split-tiebreak", description: "2차 투표가 갈린 후보를 가릅니다." }),
  task({ id: "held-review-retry", label: "보류 재심사", group: "review", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-held-qwen", wiring: "local-direct",
    jobs: ["held-qwen-retry"], adminStage: "held-review-retry", description: "보류된 후보를 다시 봅니다." }),
  // 글 짓기·번역
  task({ id: "crawl-tagline", label: "수집 소개 짓기", group: "text", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "crawl-tagline", wiring: "engine-route",
    jobs: ["crawl-tagline"], adminStage: "crawl-tagline", assignmentStage: "tagline", description: "소개가 없는 승인 후보의 한 줄 소개를 짓습니다." }),
  task({ id: "reason-translate", label: "심사 사유 번역", group: "text", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "reason-translate", wiring: "engine-route",
    jobs: ["reason-translate"], adminStage: "reason-translate", assignmentStage: "reason", description: "심사 사유를 번역합니다." }),
  task({ id: "product-translate", label: "제품 다국어 번역", group: "text", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "product-translate", wiring: "engine-route",
    jobs: ["product-translate"], adminStage: "product-translate", assignmentStage: "translate", description: "공개 제품의 글을 여러 언어로 옮깁니다." }),
  task({ id: "product-tagline-ko", label: "한국어 소개 번역", group: "text", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "product-tagline-ko", wiring: "engine-route",
    jobs: ["product-tagline-ko"], adminStage: "product-tagline-ko", assignmentStage: "ko", description: "공개 제품의 한 줄 소개를 한국어로 옮깁니다." }),
  task({ id: "korean-translation-direct", label: "한국어 소개 번역 · 직접 경로", group: "text", kind: "chat", api: true, wiring: "uncapped",
    jobs: ["product-tagline-ko"], adminStage: "korean-translation-direct", description: "직접 API 경로입니다. CLI는 상한이 있는 product-tagline-ko를 씁니다." }),
  // 검색
  task({ id: "search-query-translate", label: "검색어 번역", group: "search", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "search-query-translate", wiring: "engine-route",
    jobs: [], adminStage: "search-query-translate", description: "웹 검색 요청의 검색어를 번역합니다." }),
  task({ id: "product-search-profile", label: "검색 키워드 짓기", group: "search", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "product-search-profile", wiring: "engine-route",
    jobs: ["product-search-profile"], adminStage: "product-search-profile", assignmentStage: "profile", description: "제품마다 검색 키워드·프로필을 짓습니다." }),
  task({ id: "product-search-verify", label: "검색 키워드 검수", group: "search", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "product-search-verify", wiring: "engine-route",
    jobs: ["product-search-verify"], adminStage: "product-search-verify", assignmentStage: "verify", description: "지은 검색 키워드가 맞는지 봅니다." }),
  task({ id: "product-embedding", label: "제품 의미 검색 벡터", group: "search", kind: "embedding", api: true, wiring: "uncapped", sameModelAcrossRanks: true,
    jobs: ["product-embedding"], description: "제품 글을 벡터로 바꿉니다. 모델을 바꾸면 전부 다시 만들어야 해서 2·3순위도 같은 모델이어야 합니다." }),
  task({ id: "search-embedding", label: "검색어 벡터", group: "search", kind: "embedding", api: true, wiring: "uncapped", sameModelAcrossRanks: true,
    sameModelAs: "product-embedding", jobs: [], description: "웹 검색어를 벡터로 바꿉니다. 제품 벡터와 같은 모델이어야 합니다." }),
  task({ id: "search-rerank", label: "검색 재정렬", group: "search", kind: "rerank", api: true, wiring: "uncapped", sameModelAcrossRanks: true,
    jobs: [], description: "웹 검색 결과 앞쪽을 다시 줄 세웁니다." }),
  // 감사·보강
  task({ id: "audit-review", label: "발행분 감사 · 직접 모델", group: "audit", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-audit", wiring: "local-direct",
    jobs: ["audit-qwen"], adminStage: "audit-review", assignmentStage: "audit", description: "공개된 제품을 다시 감사합니다." }),
  task({ id: "audit-second-opinion", label: "감사 두 번째 의견", group: "audit", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-second-opinion", wiring: "local-direct",
    jobs: ["audit-second-opinion"], adminStage: "audit-second-opinion", assignmentStage: "audit-second-opinion", description: "감사 결과에 두 번째 의견을 붙입니다." }),
  task({ id: "published-filter", label: "공개분 추가 검수", group: "audit", kind: "chat", api: true, cliTools: tools("opencode"), routeId: "local-published-filter", wiring: "local-direct",
    jobs: ["audit-second-opinion"], adminStage: "published-filter", description: "규칙만 통과해 공개된 제품을 다시 거릅니다." }),
  task({ id: "screen-review", label: "화면 판별", group: "audit", kind: "vision", api: true, cliTools: tools("opencode"), routeId: "local-screen", wiring: "local-direct",
    jobs: ["audit-screen-review"], adminStage: "screen-review", assignmentStage: "screen", description: "제품 화면 사진을 보고 판별합니다." }),
  // 2026-11-09: 공개분 변경 재판정도 이 순위로 부른다(lib/crawl/published-recheck.ts recheckReviewerPlan) — 받는 CLI 는 감사 경로의 장부 binding(product_audit_cli)이
  // 받는 것(Claude·OpenCode)뿐이다. Codex·Grok 은 장부 규칙(CHECK)·binding 이 없어 받지 않는다.
  // API 연결은 재판정만 받는다 — 감사 직접 경로(route local-audit, 잡 audit-qwen, binding direct:audit:<항목>:audit, CHECK 가지는 이미 있음)로 부른다(wiring audit-direct).
  // 그래서 이 작업의 잡은 둘이다: CLI 순위는 product-audit, API 순위는 audit-qwen 이 묻는다(lib/crawl/published-recheck-lanes.ts 가 순위 차례를 맞춘다)
  task({ id: "product-audit", label: "발행분 감사 · 변경 재판정", group: "audit", kind: "chat", api: true, cliTools: tools("claude", "opencode"), routeId: "product-audit",
    wiring: "audit-direct", jobs: ["product-audit", "audit-qwen"],
    description: "사람이 연 발행분 감사와, 내용이 바뀐 공개 제품의 재판정이 이 순위로 모델을 부릅니다. 재판정은 1·2·3순위를 차례로 씁니다(API 연결은 감사 직접 경로로). 사람이 연 감사는 시작할 때 CLI 순위 중 가장 앞의 것을 고정합니다(API 연결은 재판정만)." }),
  task({ id: "assist-review", label: "LLM 보강", group: "audit", kind: "chat", api: true, cliTools: tools("opencode"), wiring: "deferred", jobs: ["product-llm-assist-review"],
    adminStage: "assist-primary", assignmentStage: "assist", description: "응답 점검·저장소 이동 등 보강 작업을 모델에 묻습니다." }),
  task({ id: "assist-audit", label: "LLM 보강 독립 감사", group: "audit", kind: "chat", api: true, cliTools: tools("opencode"), wiring: "deferred", jobs: ["product-llm-assist-audit-review"],
    adminStage: "assist-audit", assignmentStage: "assist-audit", description: "자동 보강 결과를 다른 모델이 감사합니다." }),
  // CLI 전용
  task({ id: "product-intro-check", label: "소개 검수", group: "cli", kind: "chat", api: false, cliTools: tools("claude", "opencode"), routeId: "product-intro-check",
    wiring: "deferred", jobs: ["product-intro-check"], adminStage: "product-intro-check", assignmentStage: "intro", description: "AI 소개·메이커 소개를 근거와 대조해 고칩니다." }),
  task({ id: "publish-classify", label: "카테고리 분류", group: "cli", kind: "chat", api: true, cliTools: tools("codex", "claude", "opencode"), routeId: "crawl-publish-classify",
    wiring: "engine-route", jobs: ["crawl-publish"], assignmentStage: "publish-classify", description: "발행 전 카테고리 분류: 분산은 API 연결 또는 등록된 OpenCode 엔진을 쓰고, 대체 실행은 기존 connect CLI 설정을 사용합니다." }),
  task({ id: "grok-session-check", label: "Grok 로그인 유지", group: "cli", kind: "chat", api: false, cliTools: tools("grok"), routeId: "grok-session-check",
    wiring: "deferred", jobs: ["grok-session-check"], description: "Grok CLI 로그인이 끊기지 않게 짧게 부릅니다." }),
]);

/**
 * 같은 모델 이름을 다른 연결에도 둔 순위의 장부 이름(PR B) — 계약 행·정책 route·장부의 model 열쇠가 (경로, 모델)마다 하나라 연결로 가른다.
 * 엔진에는 계약의 engineModel(= 순위의 모델)이 나간다. 연결 id(uuid)의 앞 8자 — 연결 이름이 바뀌어도 그대로다. 200자를 넘으면 null(만들 수 없다).
 */
export function aiTaskAliasIdentity(model: string, connectionId: string): string | null {
  const alias = `${model}@${connectionId.slice(0, 8)}`;
  return alias.length <= 200 ? alias : null;
}
/**
 * 실행 쪽이 순위를 읽는 심사 작업(PR C1) — 1차 AI 검수(용량 route crawl-agent-review, 칸 1)·2차 AI 검수(route second-review, 투표자 칸 1·2·3).
 * 순위마다 그 연결을 가리키는 계약(API: 끝점 = 연결 주소, CLI: 연결 도구·모델의 CLI 계약)에 묶는다(lib/crawl/review-task-ranks.ts).
 */
export const AI_REVIEW_TASK_IDS = Object.freeze(["first-review", "second-review"] as const);
export type AiReviewTaskId = (typeof AI_REVIEW_TASK_IDS)[number];
export const isAiReviewTask = (id: string): id is AiReviewTaskId => (AI_REVIEW_TASK_IDS as readonly string[]).includes(id);
/** 실행 쪽이 순위를 읽는 text 작업(PR B) — 작업 id = 용량 route id. 나머지 작업은 PR C~D 가 옮긴다. */
export const AI_TEXT_TASK_IDS = Object.freeze(["crawl-tagline", "reason-translate", "product-translate", "product-tagline-ko",
  "search-query-translate", "product-search-profile", "product-search-verify"] as const);
export type AiTextTaskId = (typeof AI_TEXT_TASK_IDS)[number];
export const isAiTextTask = (id: string): id is AiTextTaskId => (AI_TEXT_TASK_IDS as readonly string[]).includes(id);
/** 순위를 실행 쪽이 읽는 작업(PR B text 일곱 + PR C1 심사 둘 + Grok 로그인 유지). 화면이 「실행」 줄을 보인다. */
export const isAiLiveTask = (id: string): boolean => isAiTextTask(id) || isAiReviewTask(id) || id === "grok-session-check" || id === "product-audit";
/**
 * 순위가 없거나(no_task_models)·표를 못 읽었거나(task_models_unreadable)·모든 순위를 쓸 수 없을 때(all_ranks_unusable) 잡이 남기는 degraded 코드.
 * 재시작으로 고쳐지지 않는 설정의 일이라 진행 감시가 재시작하지 않는다(lib/operations/worker-progress-query.ts applyAllSkippedBlock).
 */
export const AI_TASK_RANK_DEGRADED_CODES = Object.freeze(["no_task_models", "task_models_unreadable", "all_ranks_unusable"] as const);
/**
 * all_ranks_unusable 의 모든 순위가 「연결에 키가 없음」(connection_key_missing)뿐일 때 degraded 에 싣는 cause. 키 없는 연결은 부르지 않고(②)
 * 같은 주소의 계약 키로 채워지거나(①) 관리자가 다른 모델을 고르면 풀리는 설정의 일이다(2026-11-02 사람 결정 「키 없어도 배포는 되게」) —
 * 진행 감시는 그 단계를 경보·재시작하지 않고(applyKeyMissingHold), OPEN 은 그 경로를 미룸으로 세지 않는다(key_missing). 관리 화면에는 그대로 보인다.
 */
export const AI_TASK_KEY_MISSING_CAUSE = "connection_key_missing" as const;
/** 순위 까닭 목록이 비어 있지 않고 모두 connection_key_missing 인가(그때만 cause 를 싣는다 — 다른 까닭이 하나라도 섞이면 예전처럼 경보다). */
export const onlyKeyMissing = (reasons: readonly (string | null | undefined)[]): boolean =>
  reasons.length > 0 && reasons.every(reason => reason === AI_TASK_KEY_MISSING_CAUSE);

export const AI_TASK_RANK_MAX = 3;
export const AI_TASK_SLOT_MAX = 8;
export const aiTask = (id: string): AiTaskDef | null => AI_TASKS.find(row => row.id === id) ?? null;
/** 작업 × 칸 목록(화면 줄 순서). */
export const aiTaskSlots = (): { task: AiTaskDef; slot: number }[] =>
  AI_TASKS.flatMap(row => Array.from({ length: row.slots }, (_, index) => ({ task: row, slot: index + 1 })));
export const aiTaskSlotLabel = (row: AiTaskDef, slot: number): string => row.slotLabel ? `${row.label} · ${row.slotLabel} ${slot}` : row.label;
/** 이 작업이 이 연결을 받는가(종류·도구). */
export function aiTaskAccepts(row: Pick<AiTaskDef, "api" | "cliTools">, connection: { kind: "api" | "cli"; cliTool: string | null }): boolean {
  return connection.kind === "api" ? row.api : (row.cliTools as readonly string[]).includes(connection.cliTool ?? "");
}
