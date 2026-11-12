import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { STATION_TASKS } from "./conveyor-llm";

export type FlowModelStageId =
  | "discover" | "fetch" | "judge" | "first" | "second" | "human"
  | "profile" | "publish" | "public" | "keywords" | "support";
export type FlowModelStagePhase =
  | "수집" | "검수" | "발행 준비" | "공개" | "결과" | "공개 후";

export type FlowModelStage = Readonly<{
  id: FlowModelStageId;
  label: string;
  phase: FlowModelStagePhase;
  taskIds: readonly string[];
  llm: boolean;
  editHref: string;
}>;

const HUMAN_TASKS = new Set<string>(STATION_TASKS.human);
const SEARCH_VECTOR_TASKS = new Set(["product-embedding", "search-embedding", "search-rerank"]);
const NO_LLM_STAGE_IDS = new Set<FlowModelStageId>(["discover", "fetch", "judge", "public"]);
const profileTasks = STATION_TASKS.profile;

const stage = (id: FlowModelStageId, label: string, phase: FlowModelStagePhase, taskIds: readonly string[], editHref: string): FlowModelStage =>
  Object.freeze({ id, label, phase, taskIds: Object.freeze([...taskIds]), llm: !NO_LLM_STAGE_IDS.has(id), editHref });

/** 흐름 화면과 모델 화면이 함께 읽는 단계 표시표. 실행 묶음(STATION_TASKS)은 바꾸지 않고 표시용으로만 나눈다. */
export const FLOW_MODEL_STAGES: readonly FlowModelStage[] = Object.freeze([
  stage("discover", "발굴", "수집", STATION_TASKS.discover, "/admin/flow?tab=diagnostics"),
  stage("fetch", "원본 수집", "수집", STATION_TASKS.fetch, "/admin/flow?tab=diagnostics"),
  stage("judge", "규칙 판정", "검수", STATION_TASKS.judge, "/admin/flow?tab=diagnostics"),
  stage("first", "AI 1차", "검수", STATION_TASKS.first, "/admin/models#execution-first-review-1"),
  stage("second", "AI 2차", "검수", STATION_TASKS.second, "/admin/models#execution-second-review-1"),
  stage("human", "사람 확인 · AI 보조", "검수", STATION_TASKS.human, "/admin/models/human#human-review"),
  stage("profile", "프로필 준비", "발행 준비", profileTasks.filter(id => id === "crawl-tagline"), "/admin/models#execution-crawl-tagline-1"),
  stage("publish", "발행", "공개", STATION_TASKS.publish, "/admin/models#execution-publish-classify-1"),
  stage("public", "공개 완료", "결과", [], "/admin/products"),
  stage("keywords", "검색·후처리", "공개 후", STATION_TASKS.keywords, "/admin/models#execution-product-search-profile-1"),
  stage("support", "공개 후 소개·번역", "공개 후", profileTasks.filter(id => id !== "crawl-tagline"), "/admin/models#execution-product-tagline-ko-1"),
]);

export function flowModelStage(id: string): FlowModelStage | null {
  return FLOW_MODEL_STAGES.find(stage => stage.id === id) ?? null;
}

export function flowModelTaskStage(taskId: string): FlowModelStage | null {
  return FLOW_MODEL_STAGES.find(stage => stage.taskIds.includes(taskId)) ?? null;
}

/**
 * 작업별 실제 편집 원본의 단일 표.
 * live 작업은 작업 순위 편집기의 실행 칸으로 보낸다. 사람 위임 작업은 사람 확인 편집기,
 * 검색 벡터·재정렬은 검색 모델 화면, 소개 검수는 읽기 전용 CLI env 계약의 실행 설정으로 보낸다.
 * 나머지 nonlive 작업은 저장된 순위를 실제 적용으로 오해하지 않도록 단계 풀·CLI·감사 원본으로 보낸다.
 */
export function flowModelTaskHref(taskId: string): string {
  if (HUMAN_TASKS.has(taskId)) return `/admin/models/human#${taskId}`;
  if (taskId === "publish-classify") return "/admin/models#execution-publish-classify-1";
  if (taskId === "product-intro-check") return "/admin/models/advanced#model-settings";
  if (isAiLiveTask(taskId)) return `/admin/models#execution-${taskId}-1`;
  if (SEARCH_VECTOR_TASKS.has(taskId) || aiTask(taskId)?.kind === "embedding" || aiTask(taskId)?.kind === "rerank") return "/admin/models/search";
  if (aiTask(taskId)?.group === "audit") return "/admin/audit";
  return "/admin/models/advanced#model-settings";
}
