import type { Conveyor, Station, StationKey } from "./conveyor-model";
import type { OperatorDesk } from "./operator-desk-model";
import { LLM_RETRY_HREF } from "./llm-ops-links";

/**
 * 장애 대응 — 전체 흐름의 칸을 누르면 열리는 "이 자리에서 할 일". DB 를 읽지 않는 순수 함수다.
 *
 * 새 쓰기 경로를 만들지 않는다. 할 수 있는 조치는 셋뿐이다:
 * - job: 이미 있는 작업 멈춤·재개(controlJobAction, 운영센터 작업 상세와 같은 폼 — 사유를 적어야 눌린다, 작업 로그에 전·후가 남는다)
 * - link: 그 일을 하는 기존 화면으로 간다(모델 순위·장비 한도·확인 못함 닫기·보류 목록 등)
 * - manual: 화면에 조치가 없다 — 무엇이 없고 어디서(어떤 도구·누구 결정으로) 하는지 적는다. 없는 버튼을 있는 척하지 않는다.
 * risk 는 화면의 표시(읽기 · 되돌릴 수 있음 · 조심)다. 조심은 확인 단계가 있는 화면으로만 보낸다.
 */
export type ResponseRisk = "read" | "safe" | "careful";
export type ResponseStep =
  | { kind: "job"; job: string; label: string; why: string; undo: string }
  | { kind: "link"; label: string; href: string; why: string; risk: ResponseRisk; undo?: string }
  | { kind: "manual"; label: string; why: string; where: string };
export type StationResponse = { checks: string[]; steps: ResponseStep[] };

/** 칸마다 멈추고 다시 켤 수 있는 작업 — 카탈로그 잡 이름. 2차는 AI2 소비자(service)도 돌아 잡 멈춤만으로는 서지 않을 수 있다 */
export const STATION_JOBS: Readonly<Record<StationKey | "human", readonly { job: string; label: string }[]>> = {
  discover: [{ job: "crawl-seed", label: "GitHub 검색" }, { job: "hn-show-seed", label: "Show HN" }, { job: "crawl-ko-apply", label: "한국어 프로젝트" }],
  fetch: [{ job: "crawl-fetch", label: "원본 수집" }],
  judge: [{ job: "crawl-judge", label: "규칙 심사" }],
  first: [{ job: "crawl-agent-review", label: "AI 1차 심사" }],
  second: [{ job: "second-review", label: "AI 2차(잡)" }],
  profile: [{ job: "crawl-tagline", label: "소개 짓기" }],
  publish: [{ job: "crawl-publish", label: "발행·분류" }],
  keywords: [{ job: "product-search-profile", label: "키워드 짓기" }, { job: "product-search-verify", label: "키워드 검수" }],
  human: [{ job: "human-deepseek-review", label: "사람 몫 AI 위임" }, { job: "split-confirm", label: "갈림 재확인" },
    { job: "split-tiebreak", label: "갈림 판가름" }, { job: "held-qwen-retry", label: "보류 재심사" }],
};

/** Public-product translation runs after publication, outside the candidate conveyor. Reuse the same jobs read. */
export const PUBLIC_TRANSLATION_JOBS = [
  { job: "product-tagline-ko", label: "한국어 소개" },
  { job: "product-translate", label: "제품 정보 번역" },
] as const;

const JOB_UNDO = "같은 자리에서 사유를 적고 재개하면 멈추기 전 재시도 시각이 돌아옵니다(작업 로그 job-pause 에 전·후 값).";
const n = (value: number) => value.toLocaleString("ko-KR");

function jobSteps(key: StationKey | "human", why: string): ResponseStep[] {
  return STATION_JOBS[key].map((row) => ({ kind: "job", job: row.job, label: row.label, why, undo: JOB_UNDO }));
}

/** 장비·장부 쪽 조치 — 어느 칸이든 모델을 부르는 칸이 막혔을 때 같이 본다 */
function equipmentSteps(desk: OperatorDesk | null): { checks: string[]; steps: ResponseStep[] } {
  const ledger = desk?.equipment?.ledger;
  const checks: string[] = []; const steps: ResponseStep[] = [];
  if (ledger?.reasons.includes("dispatch_stuck")) {
    const devices = desk!.equipment!.devices.filter((device) => device.stuck > 0).map((device) => `${device.name} ${device.stuck}칸`).join(" · ");
    checks.push(`전송 중(dispatched)에 멈춘 호출 ${n(ledger.stuckDispatched)}건이 장비 칸을 잡고 있습니다${devices ? ` — ${devices}` : ""}`);
    steps.push({ kind: "manual", label: "소유 프로세스가 사라진 전송 중 행을 미확정으로 바꾸기",
      why: "워커가 다시 떠 옛 프로세스가 끝낼 수 없는 호출입니다. 미확정으로 바꾸면 보낸 지 유지 시간(실시간 한도 「모델 장부 점유」)이 지난 뒤 칸이 풀리고 사람 검토로 닫습니다",
      where: "화면 조치 없음 — scripts/ops/model-owner-gone.ts mark → close-review(PR #800). 판정 근거를 확인한 뒤 운영자가 실행" });
  }
  if (ledger && (ledger.reasons.includes("review_backlog") || ledger.reasons.includes("review_stale") || ledger.reviewCount > 0)) {
    steps.push({ kind: "link", label: `확인 못함(미확정) ${n(ledger.reviewCount)}건 다시 대기열에 넣거나 닫기`, href: LLM_RETRY_HREF, risk: "careful",
      why: "미확정 행이 쌓이면 review_backlog·review_stale 경보가 납니다(보낸 뒤 유지 시간 동안은 칸도 차지합니다)", undo: "닫은 행은 다시 열리지 않습니다(유지 시간 안의 행이면 그 칸이 바로 풀립니다) · 다시 넣은 작업은 그 단계가 다시 실행합니다" });
  }
  return { checks, steps };
}

/**
 * 모델 사정에서 나온 점검과 조치 — 칸이 부르는 작업의 순위가 비었거나(no_task_models)·모두 못 쓰거나·다른 순위로 넘어갔을 때.
 * 순위를 바꾸는 길은 「작업 ↔ AI 모델」 화면 하나뿐이라 링크로 보낸다. 이 화면에는 쓰기를 더하지 않는다.
 */
function modelResponse(station: { llm: Station["llm"] } | undefined, steps: ResponseStep[]): string[] {
  const llm = station?.llm;
  if (!llm || llm.kind !== "llm") return [];
  const front: string[] = []; const back: string[] = [];
  for (const task of llm.tasks) {
    if (task.state === "none") front.push(`「${task.label}」 순위가 비어 있어 이 작업이 돌지 않습니다(no_task_models) — 작업 로그에 ai-task-models-save 가 있으면 그 시각과 이 칸이 멈춘 시각을 견주고, after 에 빈 순위가 남았는지 봅니다`);
    else if (task.state === "stuck") front.push(`「${task.label}」 ${task.note ?? "쓸 수 있는 순위가 없습니다"}`);
    else if (task.state === "fallback" || task.state === "other") back.push(`「${task.label}」 ${task.note ?? "설정과 다른 모델이 쓰이고 있습니다"}`);
  }
  const needsRanks = llm.tasks.some((task) => task.state === "none" || task.state === "stuck")
    || llm.tasks.some((task) => task.state === "fallback" || task.state === "other");
  if (needsRanks && !steps.some((step) => step.kind === "link" && step.href.startsWith("/admin/models/tasks"))) {
    steps.unshift({ kind: "link", label: "작업 ↔ AI 모델에서 순위 고치기", href: "/admin/models/tasks#tasks", risk: "careful",
      why: "이 칸이 부르는 작업의 1·2·3순위를 정하는 화면입니다", undo: "「최근 기록」에 이전 순위가 남습니다 — 같은 화면에서 이전 값으로 다시 저장" });
  }
  if (llm.stopped.length && !steps.some((step) => step.kind === "link" && step.href.startsWith("/admin/activity"))) {
    steps.push({ kind: "link", label: "누가 언제 순위를 바꿨나", href: "/admin/activity?group=settings", risk: "read", why: "작업 로그의 설정·연결 갈래" });
  }
  return [...front, ...back];
}

/**
 * 칸 하나의 대응 — 칸의 판정(tone·reason)과 책상(장부·역할)을 보고 점검 순서와 조치를 세운다.
 * 2026-11-02 사고 넷(2차 같은 모델 보류·1차 순위 지워짐·죽은 dispatched·M3 재부팅)이 각각 어느 칸에서 어떤 조치로 이어지는지가 기준이다.
 */
export function stationResponse(key: StationKey | "human", conveyor: Conveyor, desk: OperatorDesk | null): StationResponse {
  const station: Station | undefined = key === "human" ? undefined : conveyor.stations.find((row) => row.key === key);
  const blocked = station ? station.tone === "jam" || station.tone === "slow" : conveyor.human?.tone === "slow";
  const checks: string[] = []; const steps: ResponseStep[] = [];
  const roleTrouble = desk?.window?.roles.filter((role) => !role.ok) ?? [];
  if (roleTrouble.length) {
    checks.push(`역할 lease: ${roleTrouble.map((role) => `${role.role} ${role.text}${role.host ? `(${role.host})` : ""}`).join(" · ")} — 장비 재시작 뒤 예비가 쥐고 놓지 않는지 먼저 봅니다`);
    steps.push({ kind: "manual", label: "예비가 쥔 역할을 주에게 돌려주기", why: "예비는 스스로 양보하지 않습니다(role-leader)",
      where: "화면 조치 없음 — 배포 runbook 의 예비 scale 0 → lease 가 m3-* 로 → scale 1 (docs/operations/independent-workers-runbook.md)" });
  }

  switch (key) {
    case "discover":
      checks.push("탐색 잡의 마지막 성공·오류(아래 사실 칸)와 크롤 설정의 수집 켜짐");
      steps.push({ kind: "link", label: "검색 신호·수집 규칙", href: "/admin#signals", risk: "careful", why: "검색어·신호를 바꾸면 들어오는 양이 바뀝니다", undo: "작업 로그 settings-save 의 이전 값으로 다시 저장" });
      steps.push(...jobSteps("discover", "들어오는 양을 잠시 멈춰 뒤 칸이 비게 할 때"));
      break;
    case "fetch":
      checks.push("원본 수집 실패(보류 '원본 재수집 실패') 증가와 GitHub 수집 계정 한도");
      steps.push({ kind: "link", label: "GitHub 수집 계정 한도", href: "/admin/github-accounts", risk: "read", why: "토큰 한도가 바닥나면 원본 수집이 멈춥니다" });
      steps.push({ kind: "link", label: "크롤러 활동", href: "/admin/status?tab=crawlers", risk: "read", why: "수집기별 실패·대기" });
      steps.push(...jobSteps("fetch", "같은 오류가 되풀이될 때 잠시 멈춤"));
      break;
    case "judge":
      steps.push({ kind: "link", label: "판정 규칙", href: "/admin#judge", risk: "careful", why: "규칙으로 못 가른 보류가 늘면 규칙을 봅니다", undo: "작업 로그 settings-save 의 이전 값으로 다시 저장" });
      steps.push(...jobSteps("judge", "규칙을 고치는 동안 잠시 멈춤"));
      break;
    case "first": {
      checks.push("「작업 ↔ AI 모델」의 1차 AI 검수 1순위가 비어 있지 않은지(비면 1차가 no_task_models 로 0건)");
      checks.push("최근 바뀐 설정에 ai-task-models-save 가 있는지 — 있으면 그 시각과 1차가 0이 된 시각을 견줍니다");
      steps.push({ kind: "link", label: "1차 모델 순위 확인·바꾸기", href: "/admin/models/tasks", risk: "careful", why: "1차를 부를 모델이 이 순위에서 정해집니다",
        undo: "「최근 기록」에 이전 순위가 남습니다 — 같은 화면에서 이전 값으로 다시 저장" });
      steps.push({ kind: "link", label: "누가 언제 순위를 바꿨나", href: "/admin/activity?group=settings", risk: "read", why: "작업 로그의 설정·연결 갈래" });
      steps.push({ kind: "link", label: "1차 상세(운영센터)", href: "/admin/status#first-review-status", risk: "read", why: "1시간 실패 호출·모델별 결과" });
      steps.push(...jobSteps("first", "모델을 바꾸는 동안 실패 호출이 쌓이지 않게 잠시 멈춤"));
      break;
    }
    case "second": {
      const splits = station?.holds.filter((hold) => hold.reason.startsWith("second_review_split")) ?? [];
      const total = splits.reduce((sum, hold) => sum + hold.count, 0);
      checks.push("2차 실행 설정과 실제 호출·결과 저장을 확인합니다 — 1차와 같은 모델도 쓸 수 있지만 별도 2차 결과가 필요합니다");
      checks.push("2차 진행은 잡 관측이 아니라 2차 표(second_reviews) 생성 수로 봅니다 — 이 칸 「처리량」의 숫자와 그래프가 그 수입니다");
      steps.push({ kind: "link", label: "2차 실행 설정 확인·바꾸기", href: "/admin/models/tasks", risk: "careful",
        why: "2차가 사용할 모델과 실행 방식을 확인합니다", undo: "「최근 기록」의 이전 순위로 다시 저장" });
      if (total > 0) {
        steps.push({ kind: "link", label: `'2차 갈림' 보류 ${n(total)}건 보기`, href: "/admin/review?cause=second_review_split#review-list", risk: "read", why: "모델을 바꿔도 이미 보류된 건은 저절로 다시 돌지 않습니다" });
        steps.push({ kind: "manual", label: `이미 보류된 ${n(total)}건을 2차로 다시 보내기`, why: "관문 행 없이 보류된 건은 자동 재개 대상이 아닙니다(reopenOrphanedGateHolds 가 일부러 건드리지 않음)",
          where: "화면 조치 없음 — 보류 묶음 재개는 사람 결정 뒤 별도 도구로. 그 전까지는 심사 큐의 「갈림 판가름」 스위치나 사람 심사로 줄입니다" });
      }
      steps.push(...jobSteps("second", "2차 잡만 멈춥니다 — AI2 소비자(service)는 단계 제어로 따로 멈춥니다"));
      break;
    }
    case "profile":
      checks.push("분류 보류(1시간마다 재분류)와 소개 짓기 대기 — 소개 선이 0이면 text 워커·소개 모델 순위를 봅니다");
      steps.push({ kind: "link", label: "소개 짓기 모델 순위", href: "/admin/models/tasks", risk: "careful", why: "소개 짓기(crawl-tagline)를 부를 모델", undo: "「최근 기록」의 이전 순위로 다시 저장" });
      steps.push({ kind: "link", label: "카테고리 기준", href: "/admin/categories", risk: "careful", why: "분류가 계속 비면 정의 문장을 봅니다", undo: "작업 로그의 이전 정의로 다시 저장" });
      steps.push({ kind: "link", label: "'소개 문구 없음' 보류", href: "/admin/review?cause=no_description#review-list", risk: "read", why: "사람이 소개를 보고 가릅니다" });
      steps.push(...jobSteps("profile", "소개 모델을 바꾸는 동안 잠시 멈춤"));
      break;
    case "publish":
      checks.push("발행 워커(publisher) 생존과 분류 보류 — 분류가 안 정해지면 승인 후보가 발행을 기다립니다");
      steps.push({ kind: "link", label: "제품 목록", href: "/admin/products", risk: "read", why: "막 발행된 것과 내려간 것" });
      steps.push(...jobSteps("publish", "잘못된 발행이 이어질 때 잠시 멈춤"));
      break;
    case "keywords":
      steps.push({ kind: "link", label: "검색 데이터 점검", href: "/admin/status?tab=diagnostics", risk: "read", why: "짓기·검수 대기와 재시도 한도" });
      steps.push(...jobSteps("keywords", "키워드 모델을 바꾸는 동안 잠시 멈춤"));
      break;
    case "human":
      checks.push("직접 판단 수와 24시간 사람 결정 수 — 자동 판가름이 꺼져 있으면 사람 몫이 늘기만 합니다");
      steps.push({ kind: "link", label: "직접 판단 처리", href: "/admin/review?stage=human&sort=wait#review-list", risk: "safe", why: "오래 기다린 것부터", undo: "결정 직후 10초 되돌리기 · 작업 로그 candidate-undo" });
      steps.push({ kind: "link", label: "확정만 하면 됨", href: "/admin/review?stage=agreed#review-list", risk: "safe", why: "1·2차 결과가 같은 결론을 낸 후보", undo: "결정 직후 10초 되돌리기" });
      steps.push(...jobSteps("human", "자동 판가름·재심사를 잠시 멈춤"));
      break;
  }
  // 모델 사정(순위 비어 멈춤·모두 못 씀·다른 순위로 넘어감)은 근본 원인이라 점검 맨 앞에 둔다
  const modelChecks = key === "human" ? modelResponse(conveyor.human ? { llm: conveyor.human.llm } : undefined, steps) : modelResponse(station, steps);
  checks.unshift(...modelChecks);
  // 모델을 부르는 칸이 막혔으면 장비·장부도 본다
  if (blocked && key !== "discover" && key !== "fetch" && key !== "judge") {
    const equipment = equipmentSteps(desk);
    checks.push(...equipment.checks); steps.push(...equipment.steps);
  }
  return { checks, steps };
}
