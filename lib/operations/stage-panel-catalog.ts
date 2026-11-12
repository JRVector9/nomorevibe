import type { StationKey } from "./conveyor-model";
import { STATION_JOBS } from "./flow-response";

/**
 * 단계 패널(운영 콘솔 개편 조각 2a)이 여는 단계 — 홈 「흐름」 표의 줄과 같은 열쇠다(/admin/flow?stage=<열쇠>).
 * 칸마다 그 단계를 이루는 것(흐름 칸 · 워커 진행 단계 · 잡 · 배정된 AI 작업 · 관련 설정 화면)을 한곳에 적는다. DB 를 읽지 않는다.
 * 모델을 쓰지 않는 단계(탐색·원본 수집·규칙 심사)는 tasks 가 비어 있다 — 패널은 같은 틀에 주기·마지막 성공·대기·관련 설정을 낸다.
 */
export type StagePanelKey =
  | "discover" | "fetch" | "judge" | "first" | "second" | "profile" | "publish" | "keywords"
  | "tagline-ko" | "product-translate" | "reason-translate" | "intro-check";

export type StagePanelDef = Readonly<{
  key: StagePanelKey;
  /** 흐름 표가 쓰지 못할 때의 이름(흐름 칸이 있으면 그 칸의 이름을 쓴다) */
  label: string;
  /** 전체 흐름(readConveyor)의 칸 — 공개 뒤 단계는 null */
  station: StationKey | null;
  /** 워커 진행(readWorkerProgress)의 단계 열쇠 */
  progress: readonly string[];
  /** 이 단계의 잡(작업 멈춤·마지막 실행·멈춘 사람) */
  jobs: readonly { job: string; label: string }[];
  /** 배정된 AI 작업(AI_TASKS id) — 비면 모델을 쓰지 않는 단계 */
  tasks: readonly string[];
  /** 관련 설정·목록 화면 */
  links: readonly { label: string; href: string }[];
}>;

const jobHref = (job: string) => `/admin/status?tab=jobs&job=${encodeURIComponent(job)}`;
const COLLECTION = { label: "수집·판정 설정", href: "/admin/settings?tab=collection" };

export const STAGE_PANELS: readonly StagePanelDef[] = Object.freeze([
  { key: "discover", label: "탐색", station: "discover", progress: [], jobs: STATION_JOBS.discover, tasks: [],
    links: [COLLECTION, { label: "크롤러 활동", href: "/admin/status?tab=crawlers" }] },
  { key: "fetch", label: "원본 수집", station: "fetch", progress: ["fetch"], jobs: STATION_JOBS.fetch, tasks: [],
    links: [COLLECTION, { label: "작업 상세", href: jobHref("crawl-fetch") }] },
  { key: "judge", label: "규칙 심사", station: "judge", progress: ["judge"], jobs: STATION_JOBS.judge, tasks: [],
    links: [COLLECTION, { label: "규칙 심사 보류", href: "/admin/review?tab=all&stage=judge" }] },
  { key: "first", label: "AI 1차", station: "first", progress: ["first"], jobs: STATION_JOBS.first, tasks: ["first-review"],
    links: [{ label: "1차 대상 보기", href: "/admin/review?tab=all&stage=ai" }] },
  { key: "second", label: "AI 2차", station: "second", progress: ["second"], jobs: STATION_JOBS.second, tasks: ["second-review"],
    links: [{ label: "2차 대상 보기", href: "/admin/review?tab=all&stage=second" }] },
  { key: "profile", label: "프로필 준비", station: "profile", progress: ["crawl-tagline"], jobs: STATION_JOBS.profile, tasks: ["crawl-tagline"],
    links: [{ label: "발행 대기 보기", href: "/admin/review?tab=publish&stage=publish" }] },
  { key: "publish", label: "발행", station: "publish", progress: ["publish"], jobs: STATION_JOBS.publish, tasks: ["publish-classify"],
    links: [{ label: "발행 대기 보기", href: "/admin/review?tab=publish&stage=publish" }] },
  { key: "keywords", label: "키워드 등록", station: "keywords", progress: ["keywords", "keyword-verify"], jobs: STATION_JOBS.keywords,
    tasks: ["product-search-profile", "product-search-verify"], links: [{ label: "검색 반영 진단", href: "/admin/status?tab=diagnostics" }] },
  { key: "tagline-ko", label: "한국어 소개", station: null, progress: ["tagline-ko"], jobs: [{ job: "product-tagline-ko", label: "한국어 소개" }],
    tasks: ["product-tagline-ko"], links: [{ label: "소개·번역", href: "/admin/products?tab=translations" }] },
  { key: "product-translate", label: "공개 번역", station: null, progress: ["product-translate"], jobs: [{ job: "product-translate", label: "공개 번역" }],
    tasks: ["product-translate"], links: [{ label: "공개 번역 한도", href: "/admin/translations#limits" }, { label: "소개·번역", href: "/admin/products?tab=translations" }] },
  { key: "reason-translate", label: "사유 번역", station: null, progress: ["reason-translate"], jobs: [{ job: "reason-translate", label: "사유 번역" }],
    tasks: ["reason-translate"], links: [] },
  { key: "intro-check", label: "소개 검수", station: null, progress: ["intro-check"], jobs: [{ job: "product-intro-check", label: "소개 검수" }],
    tasks: ["product-intro-check"], links: [{ label: "소개·번역", href: "/admin/products?tab=translations" }] },
] satisfies StagePanelDef[]);

export const stagePanel = (key: string | null | undefined): StagePanelDef | null => STAGE_PANELS.find(panel => panel.key === key) ?? null;

/** 흐름 칸 열쇠·워커 진행 단계 열쇠 → 패널 열쇠(키워드 검수 → 키워드 등록, 수집 소개 짓기 → 프로필 준비). 없으면 null */
export function stagePanelKeyOf(stage: string): StagePanelKey | null {
  return stagePanel(stage)?.key ?? STAGE_PANELS.find(panel => panel.progress.includes(stage))?.key ?? null;
}

/** 단계 패널 주소 — 새로고침·공유해도 같은 패널이 열린다. part 는 패널 안의 구역(#sp-models 등) */
export function stagePanelHref(stage: string, part?: "models" | "limits"): string {
  const key = stagePanelKeyOf(stage) ?? stage;
  return `/admin/flow?stage=${encodeURIComponent(key)}${part ? `#sp-${part}` : ""}`;
}
