import { AI_TASKS } from "@/lib/llm/ai-tasks";
import type { AdminSearchDestination } from "./admin-search-shared";

type Destination = AdminSearchDestination & { keywords: string };
const PAGES: readonly Destination[] = [
  { id: "context", title: "컨텍스트 상한", detail: "LLM 운영 → 해당 연결 펼치기 · 연결 편집 → 컨텍스트 상한(토큰)",
    href: "/admin/models/llm", keywords: "context max_model_len engine_max_len_unknown 최대 길이 문맥 토큰" },
  { id: "connections", title: "LLM 운영 · 엔진과 연결", detail: "API 서버·CLI 연결, 모델 목록과 연결 편집",
    href: "/admin/models/llm", keywords: "엔진 연결 모델 API CLI 서버 engine connection model" },
  { id: "tasks", title: "작업 배정", detail: "작업별 모델·순위·분산 실행 설정", href: "/admin/models/tasks", keywords: "모델 배정 순위 task rank" },
  { id: "devices", title: "장비·동시 실행 한도", detail: "장비별 실행 한도", href: "/admin/models/devices", keywords: "장비 엔진 device capacity slots" },
  { id: "allocation", title: "작업별 칸 배분", detail: "장비와 작업별 보장·상한", href: "/admin/models/allocation", keywords: "배분 할당 allocation quota" },
  { id: "contracts", title: "모델 연결 · 서빙 계약", detail: "엔진 직접 계약과 CLI 계약", href: "/admin/models/contracts", keywords: "서빙 계약 engine contract" },
  { id: "advanced", title: "모델 고급 · 장애 분석", detail: "단계별 모델 상태·내부 제공자·실행 정책", href: "/admin/models/advanced", keywords: "고급 장애 분석 진단 provider abcllm advanced" },
  { id: "history", title: "LLM 기록 · 실패와 재실행", detail: "모델 호출·실패·미확정 기록", href: "/admin/models/history", keywords: "실패 재시도 재실행 retry history" },
  { id: "limits", title: "처리 한도", detail: "운영 실시간 처리 한도", href: "/admin/models/limits", keywords: "제한 limits" },
  { id: "status", title: "파이프라인 · 작업 상태", detail: "수집·심사·발행과 작업 상태", href: "/admin/status", keywords: "파이프라인 상태 일시중지 재개 jobs pipeline" },
  { id: "settings", title: "설정·기록", detail: "수집·판정·외부 연동 설정", href: "/admin/settings", keywords: "설정 settings" },
];

/** Pure local metadata; opening search never probes an engine or dispatches a model. */
export function searchAdminDestinations(term: string): AdminSearchDestination[] {
  const compact = (value: string) => value.toLowerCase().replace(/\s+/g, "");
  const needle = compact(term);
  const tasks: Destination[] = AI_TASKS.map(task => ({ id: `task:${task.id}`, title: task.label,
    detail: `작업 배정 · ${task.id}`, href: `/admin/models/tasks#execution-${task.id}-1`,
    keywords: [task.id, task.routeId, task.description, ...task.jobs].join(" ") }));
  return [...PAGES, ...tasks].filter(item => compact(`${item.title} ${item.detail} ${item.keywords}`).includes(needle))
    .slice(0, 8).map(({ id, title, detail, href }) => ({ id, title, detail, href }));
}
