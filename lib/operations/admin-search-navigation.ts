import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import type { AdminSearchCommand, AdminSearchDestination } from "./admin-search-shared";
import { ADMISSION_HREF, josa } from "./console-tasks";
import { modelHref } from "./model-console";
import { JOB_LABELS } from "./runtime-settings-schema";
import { STAGE_PANELS, stagePanelHref, type StagePanelDef } from "./stage-panel-catalog";

type Destination = AdminSearchDestination & { keywords: string };
/**
 * 화면 바로 가기 — 제목은 「메뉴 › 탭(› 2차)」(메뉴 여섯: 홈 · 사람 확인 · 모델 · 수집·작업 · 콘텐츠 · 기록, workspace-navigation.ts).
 * 옛 메뉴 이름(「설정·기록」·「LLM 운영」·「파이프라인」)은 찾는 말(keywords)에만 남긴다 — 옛 이름으로 쳐도 새 자리가 나온다.
 */
const PAGES: readonly Destination[] = [
  { id: "context", title: "컨텍스트 상한", detail: "모델 › 고급 설정 › LLM 운영 → 해당 연결 펼치기 · 연결 편집 → 컨텍스트 상한(토큰)",
    href: "/admin/models/llm", keywords: "context max_model_len engine_max_len_unknown 최대 길이 문맥 토큰" },
  { id: "home", title: "홈 › 운영 홈", detail: "할 일 네 묶음 · 흐름 · 바꾼 것 지켜보기", href: "/admin/flow", keywords: "홈 할일 흐름 home 운영홈 오늘" },
  { id: "alerts", title: "홈 › 알림", detail: "휴대폰 알림 켜기·끄기 · 조용한 시간 · 보낸 알림", href: "/admin/alerts",
    keywords: "알림 휴대폰 telegram 텔레그램 조용한 시간 push notify" },
  { id: "people", title: "사람 확인 › 묶음", detail: "보류 묶음 · 표본 보고 한 번에 끝내기", href: "/admin/review/batches", keywords: "사람 확인 묶음 batch 보류 human 검수" },
  { id: "models", title: "모델 › 모델 목록", detail: "모델 상세 · 쉬게 하기 · 키 바꾸기 · 모델 추가", href: "/admin/models", keywords: "모델 목록 model 쉬게 키" },
  { id: "connections", title: "모델 › 고급 설정 › LLM 운영", detail: "API 서버·CLI 연결, 모델 목록과 연결 편집",
    href: "/admin/models/llm", keywords: "엔진 연결 모델 API CLI 서버 engine connection model llm운영" },
  { id: "tasks", title: "모델 › 작업 배정", detail: "작업별 모델·순위·분산 실행 설정", href: "/admin/models/tasks", keywords: "모델 배정 순위 task rank" },
  { id: "devices", title: "모델 › 고급 설정 › 장비 한도", detail: "장비별 실행 한도", href: "/admin/models/devices", keywords: "장비 엔진 device capacity slots" },
  { id: "allocation", title: "모델 › 고급 설정 › 칸 배분", detail: "장비와 작업별 보장·상한", href: "/admin/models/allocation", keywords: "배분 할당 allocation quota" },
  { id: "contracts", title: "모델 › 고급 설정 › 서빙 계약·등록부", detail: "엔진 직접 계약과 CLI 계약", href: "/admin/models/contracts", keywords: "서빙 계약 engine contract" },
  { id: "advanced", title: "모델 › 고급 설정", detail: "단계별 모델 상태·내부 제공자·실행 정책·장애 분석", href: "/admin/models/advanced", keywords: "고급 장애 분석 진단 provider abcllm advanced" },
  { id: "limits", title: "모델 › 고급 설정 › 실시간 한도", detail: "운영 실시간 처리 한도", href: "/admin/models/limits", keywords: "제한 limits 한도" },
  { id: "status", title: "수집·작업 › 작업 흐름", detail: "수집·심사·발행 작업 상태 · 작업 멈춤·재개", href: "/admin/status?tab=jobs", keywords: "파이프라인 상태 일시중지 재개 jobs pipeline 작업" },
  { id: "settings", title: "수집·작업 › 수집·판정", detail: "수집·판정 설정", href: "/admin/settings?tab=collection", keywords: "설정 settings 설정·기록 수집 판정" },
  { id: "content", title: "콘텐츠 › 전체 프로젝트", detail: "공개 프로젝트·소개·번역", href: "/admin/products", keywords: "콘텐츠 프로젝트 products 제품" },
  { id: "log", title: "기록 › 바꾼 것", detail: "때 · 한 일 · 누가 · 그 뒤 · 되돌리기", href: "/admin/log", keywords: "기록 log activity 작업 로그 변경 되돌리기 설정·기록" },
  { id: "history", title: "기록 › LLM 기록", detail: "모델 호출·실패·미확정 기록", href: "/admin/models/history", keywords: "실패 재시도 재실행 retry history" },
];

const compact = (value: string) => value.toLowerCase().replace(/\s+/g, "");

/** Pure local metadata; opening search never probes an engine or dispatches a model. */
export function searchAdminDestinations(term: string): AdminSearchDestination[] {
  const needle = compact(term);
  const tasks: Destination[] = AI_TASKS.map(task => ({ id: `task:${task.id}`, title: task.label,
    detail: `모델 › 작업 배정 · ${task.id}`, href: `/admin/models/tasks#execution-${task.id}-1`,
    keywords: [task.id, task.routeId, task.description, ...task.jobs].join(" ") }));
  return [...PAGES, ...tasks].filter(item => compact(`${item.title} ${item.detail} ${item.keywords}`).includes(needle))
    .slice(0, 8).map(({ id, title, detail, href }) => ({ id, title, detail, href }));
}

// ── ⌘K 찾기·바꾸기(운영 콘솔 개편 조각 4b, 시안 흐름 7) ───────────────────────────────────────────────

/** 찾은 모델(연결) — 검색 경로가 저장된 목록에서 읽는다. stages 는 이 모델을 순위·작업 분산에 둔 작업 수(모르면 null) */
export type CommandModel = { id: string; label: string; enabled: boolean; deviceId: string; stages: number | null };
/** 잡 상태 — 사람이 멈췄는가. 못 읽었으면 목록 대신 null(조치는 「멈춤·재개」로 적는다) */
export type CommandJob = { name: string; paused: boolean };

/** 기록 화면에서 그 이름을 찾는 주소(조각 4b 기록 화면 — 작업 로그의 대상·내용·사람에서 찾는다) */
export const logSearchHref = (term: string) => `/admin/log?q=${encodeURIComponent(term.trim().slice(0, 100))}`;
const jobHref = (job: string) => `/admin/status?tab=jobs&job=${encodeURIComponent(job)}`;
const COMMAND_LIMIT = 14;

/** 잡 이름 → 사람 말(단계 패널의 이름 → 실시간 한도의 이름 → 잡 이름) */
function jobLabel(job: string): string {
  for (const panel of STAGE_PANELS) { const found = panel.jobs.find(row => row.job === job); if (found) return found.label; }
  return JOB_LABELS[job] ?? job;
}
/** 수집원 — 탐색 단계 패널의 잡(GitHub 검색·Show HN·Show GN·한국어 프로젝트) */
const SOURCE_PANEL = STAGE_PANELS.find(panel => panel.key === "discover")!;

const matches = (needle: string, ...values: (string | null | undefined)[]) => values.some(value => !!value && compact(value).includes(needle));

function panelMatches(panel: StagePanelDef, needle: string): boolean {
  return matches(needle, panel.label, panel.key) || panel.key !== "discover" && panel.jobs.some(row => matches(needle, row.label, row.job))
    || panel.tasks.some(task => matches(needle, task, AI_TASKS.find(def => def.id === task)?.label));
}

/** 이 말로 찾을 때 상태를 읽어야 하는 잡 — 없으면 검색 경로가 잡 표를 읽지 않는다 */
export function commandJobNames(term: string): string[] {
  const needle = compact(term);
  if ([...needle].length < 2) return [];
  const names = new Set<string>();
  for (const panel of STAGE_PANELS) {
    if (panel.key === "discover") panel.jobs.filter(row => matches(needle, row.label, row.job)).forEach(row => names.add(row.job));
    else if (panelMatches(panel, needle)) panel.jobs.forEach(row => names.add(row.job));
  }
  for (const job of JOB_CATALOG) if (job.role !== "scheduler" && matches(needle, job.name, JOB_LABELS[job.name])) names.add(job.name);
  return [...names];
}

/** 멈춤·재개 — 잡 상태를 알면 지금 할 수 있는 쪽, 모르면 둘 다 적는다 */
function pauseWord(job: string, jobs: readonly CommandJob[] | null): string {
  const state = jobs?.find(row => row.name === job);
  return !state ? "멈춤·재개" : state.paused ? "재개" : "잠시 멈춤";
}

/**
 * 이름(모델 · 단계 · 수집원 · 잡)으로 찾은 것 — ① 그 화면 열기 ② 조치(그 조치가 있는 화면의 그 자리로 보낸다 — 여기서 실행하지 않는다.
 * 저장 전 확인·사유 입력은 그 자리의 폼이 그대로 받는다) ③ 그 이름이 나온 기록. 순수 함수 — 검색 경로가 모델 목록과 잡 상태를 넘긴다.
 * 차례는 시안대로 이름마다 열기 → 조치 → 기록이다.
 */
export function searchConsoleCommands(term: string, context: { models: readonly CommandModel[]; jobs: readonly CommandJob[] | null }): AdminSearchCommand[] {
  const needle = compact(term);
  if ([...needle].length < 2) return [];
  const out: AdminSearchCommand[] = [];
  const push = (command: AdminSearchCommand) => { if (!out.some(row => row.id === command.id)) out.push(command); };

  // 모델 — 열기 · 쓰는 단계 · 쉬게 하기(또는 다시 켜기) · 기록
  for (const model of context.models.slice(0, 3)) {
    const href = modelHref(model.id);
    push({ id: `model:${model.id}`, kind: "open", title: `모델 ${model.label} 열기`, detail: `${model.enabled ? "켜짐" : "쉬는 중"} · 장비 ${model.deviceId}`, href });
    if (model.stages) push({ id: `model-stages:${model.id}`, kind: "open", title: `${josa(model.label, "을/를")} 쓰는 단계 ${model.stages}개`,
      detail: "모델 상세의 「쓰는 단계」", href: `${href}#model-stages` });
    push({ id: `model-rest:${model.id}`, kind: "action", title: model.enabled ? `${model.label} 쉬게 하기` : `${model.label} 다시 켜기`,
      detail: "모델 상세의 조치 — 저장 전 확인을 거칩니다", href: `${href}#model-actions` });
    push({ id: `model-log:${model.id}`, kind: "log", title: `${josa(model.label, "이/가")} 나온 기록`, detail: "기록 › 바꾼 것", href: logSearchHref(model.label) });
  }

  // 단계 — 패널 열기 · 잡 멈춤/재개(패널의 작업 칸) · 모델 바꾸기(패널의 모델 칸) · 기록. 탐색은 수집원으로 따로 본다
  for (const panel of STAGE_PANELS.filter(panel => panel.key !== "discover" && panelMatches(panel, needle)).slice(0, 3)) {
    push({ id: `stage:${panel.key}`, kind: "open", title: `${panel.label} 단계 열기`, detail: "홈 › 단계 패널", href: stagePanelHref(panel.key) });
    for (const row of panel.jobs) push({ id: `job-control:${row.job}`, kind: "action", title: `${row.label} ${pauseWord(row.job, context.jobs)}`,
      detail: "단계 패널의 작업 칸 — 사유를 적어야 바뀝니다", href: stagePanelHref(panel.key, "jobs") });
    if (panel.tasks.length) push({ id: `stage-models:${panel.key}`, kind: "action", title: `${panel.label} 모델 바꾸기`,
      detail: "단계 패널의 모델 칸 — 저장 전 확인을 거칩니다", href: stagePanelHref(panel.key, "models") });
    push({ id: `stage-log:${panel.key}`, kind: "log", title: `${josa(panel.label, "이/가")} 나온 기록`, detail: "기록 › 바꾼 것", href: logSearchHref(panel.label) });
  }

  // 수집원 — 탐색 패널의 그 잡(수집 멈춤·재개는 패널의 작업 칸)
  for (const source of SOURCE_PANEL.jobs.filter(row => matches(needle, row.label, row.job)).slice(0, 2)) {
    push({ id: `source:${source.job}`, kind: "open", title: `수집원 ${source.label} 보기`, detail: "홈 › 단계 패널 › 탐색", href: stagePanelHref("discover") });
    push({ id: `job-control:${source.job}`, kind: "action", title: `${source.label} 수집 ${pauseWord(source.job, context.jobs)}`,
      detail: "단계 패널의 작업 칸 — 사유를 적어야 바뀝니다", href: stagePanelHref("discover", "jobs") });
    push({ id: `source-log:${source.job}`, kind: "log", title: `${josa(source.label, "이/가")} 나온 기록`, detail: "기록 › 바꾼 것", href: logSearchHref(source.job) });
  }

  // 잡 — 단계·수집원에 없는 것(감사·근거·관리 잡 등). 작업 흐름의 그 줄에서 멈춤·재개
  const covered = new Set(STAGE_PANELS.flatMap(panel => panel.jobs.map(row => row.job)));
  for (const job of JOB_CATALOG.filter(job => job.role !== "scheduler" && !covered.has(job.name) && matches(needle, job.name, JOB_LABELS[job.name])).slice(0, 3)) {
    const label = jobLabel(job.name);
    push({ id: `job:${job.name}`, kind: "open", title: `작업 ${label} 보기`, detail: `수집·작업 › 작업 흐름 · ${job.name}`, href: jobHref(job.name) });
    push({ id: `job-control:${job.name}`, kind: "action", title: `${label} ${pauseWord(job.name, context.jobs)}`, detail: "작업 흐름의 그 줄 — 사유를 적어야 바뀝니다",
      href: jobHref(job.name) });
    push({ id: `job-log:${job.name}`, kind: "log", title: `${josa(label, "이/가")} 나온 기록`, detail: "기록 › 바꾼 것", href: logSearchHref(job.name) });
  }

  // 모델 접수 — 머리줄의 접수와 같은 곳(사유 필수)
  if (matches(needle, "접수", "admission", "drain", "접수중단", "접수열기")) push({ id: "admission", kind: "action", title: "모델 접수 멈추기·열기",
    detail: "모델 › 고급 설정 › 대시보드의 접수 칸 — 사유를 적어야 바뀝니다", href: ADMISSION_HREF });

  return out.slice(0, COMMAND_LIMIT);
}
