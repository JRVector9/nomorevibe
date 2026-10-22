import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACK_ACTION, ACK_DAYS, BACKLOG_KEYS, UNACK_ACTION, type AttentionAck, type AttentionSample } from "@/lib/operations/attention";
import { actionCounts, buildActions, deriveStatus, rememberCriticalCount, splitActions, type ActionInputs, type DerivedStatus } from "@/app/(operator)/admin/status/attention";
import { ACTION_LINKS, jobHref } from "@/app/(operator)/admin/status/action-links";
import { AttentionList, type ActionItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { ACTION_NOW, brokenActionInputs, brokenWorkerProgress, unreadableActionInputs } from "./fixtures/operations-actions";
import { humanOverview } from "./fixtures/human-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

/**
 * 조치 계약 — 운영센터 "지금 조치 · 쌓인 일"이 오늘(2026-10-18, main 1c23c829) 보이는 것을 고정한다(운영센터 개편 v8 PR1).
 *
 * 개편은 새 요소만 더하고 지금 블록의 글자·규칙은 그대로 둔다. 이 파일이 깨지면 조치 키·급·문구·가는 곳·나누는 규칙 중
 * 하나가 바뀐 것이다 — 일부러 바꾼 것이면 표를 고치고 PR 에 그 까닭을 적는다.
 *
 * 워커 진행 판단(buildWorkerProgress)은 worker-progress 테스트가 맡는다. 여기서는 그 결과를 받아 buildActions 가 세우는 줄만 본다.
 */
beforeAll(() => {
  // 검색 점검 관측의 신선도(readSearchHealth)는 Date.now() 로 잰다 — 시계만 고정하고 타이머는 그대로 둔다
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ACTION_NOW);
});
afterAll(() => vi.useRealTimers());

const derive = (inputs: ActionInputs, workerProgress: DerivedStatus["workerProgress"]): DerivedStatus =>
  ({ ...deriveStatus({ ...inputs, throughput: null }), workerProgress });
const build = (inputs: ActionInputs, workerProgress: DerivedStatus["workerProgress"] = null) => buildActions(inputs, derive(inputs, workerProgress));

/** 보이는 글자 — 태그를 빼고 React 가 이스케이프한 글자를 되돌린다(툴팁 title 속성은 태그와 함께 빠진다) */
const text = (node: React.ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node)).replace(/<[^>]*>/g, "")
  .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type ContractRow = [key: string, tone: ActionItem["tone"], count: number | string, unit: string, title: string, detail: string, label: string, href: string];
const row = (item: ActionItem): ContractRow =>
  [item.key, item.tone, item.count, item.unit, item.title, text(item.detail), item.action?.label ?? "", item.action?.href ?? ""];

const RECHECK = "조회 실패는 정상이나 대기 0건을 뜻하지 않습니다. 새로고침 뒤에도 계속되면 DB·서비스 로그를 확인합니다.";
const WEB = "M3·mini 웹의 두 관측 ID와 45초 이내 시각·릴리스를 확인합니다. 개별 웹 복제본 상태는 Dokploy에서 확인합니다.";
const ROLE_TAIL = "역할 표의 주·예비 릴리스와 담당 기한을 확인합니다.";

/** 거의 모든 것이 나쁠 때 — 넣는 차례(막는 순서) 그대로 */
const BROKEN_CONTRACT: ContractRow[] = [
  ["web", "hold", "확인 필요", "상태", "두 웹 릴리스 불일치", WEB, "웹 관측", ACTION_LINKS.roles],
  ["search-hash", "critical", 1, "건", "갱신 큐에 없는 검색 해시 불일치", "원본과 생성 입력이 다릅니다. 프로필 복구 점검이 필요합니다.", "점검 작업", ACTION_LINKS.jobs],
  ["search-copies", "critical", 4, "건", "검색 키워드 사본 불일치", "생성·검수 결과와 실제 검색 데이터가 다릅니다.", "점검 작업", ACTION_LINKS.jobs],
  ["search-missing", "critical", 2, "건", "검색 프로필이 오래 누락된 제품", "공개 후 30분이 지났지만 프로필이 없습니다.", "점검 작업", ACTION_LINKS.jobs],
  ["search-exhausted", "critical", 5, "건", "검색 생성·검수 재시도 한도 도달", "자동 재시도가 멈춘 제품입니다. 오류 원인을 확인하세요.", "점검 작업", ACTION_LINKS.jobs],
  ["search-repeated", "hold", 3, "건", "검색 생성·검수 반복 실패", "현재 오류가 남아 있고 실패 횟수가 3회 이상입니다.", "점검 작업", ACTION_LINKS.jobs],
  ["search-generation-stalled", "hold", 10, "건", "검색 프로필 갱신이 진행되지 않습니다", "대기가 남아 있는데 30분 이상 갱신 진행을 관측하지 못했습니다.", "점검 작업", ACTION_LINKS.jobs],
  ["search-verification-wait", "hold", 6, "건", "검색 키워드 검수가 지연됩니다", "가장 오래된 미검수 프로필은 생성 후 50분입니다. 재시도 대기도 포함합니다.", "점검 작업", ACTION_LINKS.jobs],
  ["ai-account", "hold", "1/2", "계정", "Codex 계정이 실패합니다 — 예비 모델이 대신 분류 중",
    "Codex access_denied · 12:38 (1시간 전) — 다시 인증하고 모델을 검사·적용합니다.", "다시 인증", ACTION_LINKS.ai],
  ["ai-apply", "hold", "대기", "상태", "새 인증으로 모델 검사·적용이 남았습니다", "그때까지 기존 설정(gpt-5.5 → sonnet)으로 분류를 계속합니다.", "검사·적용", ACTION_LINKS.ai],
  ["model-servers", "hold", 1, "대", "검색 모델 서버가 응답하지 않습니다",
    "embedding ECONNREFUSED — 검색은 단어 검색으로만 나가고, 새 제품의 의미 검색 벡터가 밀립니다(M3 launchd bot.brut.nmv-*).", "의미 검색 벡터", jobHref("product-embedding")],
  ["jobs", "critical", 2, "개", "마지막 회차가 실패한 작업", "제품 근거 갱신, 서비스 응답 점검 — 실패한 작업 뒤의 단계는 새 일감을 받지 못합니다.", "작업 흐름", ACTION_LINKS.jobs],
  // attention.tsx:234 — 2주 넘은 판정
  ["review", "hold", 2_270, "건", "사람이 가려야 할 후보 — 직접 판단",
    "판정 뒤 최장 20일 · 24h +40 · 처리 30. 그중 300건은 판정한 지 2주가 넘었습니다 — 갈래별로 묶으면 한 번에 처리할 수 있습니다.", "심사 큐", ACTION_LINKS.reviewHuman],
  // attention.tsx:242
  ["second", "hold", 16, "건", "2차 심사 확인",
    "확정만 하면 됨 12건(거부 0 · 승인 12, 그중 만장일치 0)은 한 번에 확정 · 공개분 4건은 사람이 봅니다. 엇갈린 것은 직접 판단에 들어 있습니다.", "2차 심사", ACTION_LINKS.reviewAgreed],
  ["second-failed", "critical", 5, "건", "2차 심사가 실패하고 있습니다",
    "최근 24시간 미해결 오류 · qwen3.6 timeout 4건 · 모델 미상 model_unavailable 1건 — 설정한 모델을 게이트웨이가 더 이상 갖고 있지 않습니다.", "2차 심사 설정", ACTION_LINKS.secondSettings],
  // attention.tsx:268
  ["held", "hold", 5, "건", "분류를 못 정해 발행이 멈춘 후보",
    "승인은 끝났고 카테고리만 없습니다. 1시간 뒤 저절로 다시 분류합니다 — 다음 14:19 (41분 후). 급하면 수동으로 지정합니다.", "수동 분류", ACTION_LINKS.manual],
  ["down", "critical", 3, "건", "응답하지 않는 공개 제품",
    "3회 넘게 연속으로 실패해 공개 목록에서 빠져 있습니다. 지우거나 차단하지는 않습니다 — 다시 열리면 그대로 돌아옵니다. 끝난 서비스인지는 사람이 보고 정합니다.", "응답 없음 목록", ACTION_LINKS.productsDown],
  ["standby", "critical", 1, "개", "예비가 일하고 있는 역할", "생존 확인·지표 집계 — 현재 담당·주 관측·격리 사유를 확인하고 외부 runbook의 주 복귀 절차를 따릅니다.", "역할 표", ACTION_LINKS.roles],
  ["role-reviewer", "critical", "담당 기한 지남", "상태", "후보 심사 · 담당 기한 지남", `현재 담당 m3 · 담당 차례 7 — ${ROLE_TAIL}`, "역할 표", ACTION_LINKS.roles],
  ["role-publisher", "hold", "주·예비 릴리스 불일치", "상태", "제품 발행 · 주·예비 릴리스 불일치", `현재 담당 m3 · 담당 차례 2 — ${ROLE_TAIL}`, "역할 표", ACTION_LINKS.roles],
  ["role-text", "critical", "역할 관측 없음", "상태", "소개·사유 번역 · 역할 관측 없음", `현재 담당 미확인 · 담당 차례 미확인 — ${ROLE_TAIL}`, "역할 표", ACTION_LINKS.roles],
  ["liveness", "critical", 2, "개", "워커 관측이 끊겼거나 반복 재시작 중", "제품 발행 5분 내 반복 재시작 · 소개·사유 번역 관측 끊김", "작업 흐름", ACTION_LINKS.jobs],
  ["restarts", "hold", 3, "회", "최근 1시간 안에 다시 뜬 워커",
    "제품 발행 2회 · 소개·사유 번역 1회 — 배포가 아닌 재시작입니다. 컨테이너 로그(supervisor.stopping 사유)를 봅니다.", "역할 표", ACTION_LINKS.roles],
  ["scheduler-replicas", "hold", "1/2", "대", "스케줄러 복제 관측이 부족합니다", "최근 관측 1대 — scheduler 앱의 두 복제본과 로그를 확인합니다.", "역할 표", ACTION_LINKS.roles],
  ["scheduler", "critical", 2, "개", "스케줄러 예약이 밀렸습니다", "서비스 응답 점검, 수집 대상 탐색", "작업 흐름", ACTION_LINKS.jobs],
  ["stage-progress", "critical", 1, "단계", "워커는 살아 있는데 단계가 나아가지 않습니다", "AI 1차 심사 — 오래 기다린 후보가 있는데 5분간 저장 진행이 없습니다.", "작업 흐름", ACTION_LINKS.jobs],
  ["model-failures", "hold", 1, "자리", "모델 호출이 자주 실패합니다",
    "2차 투표 Qwen3.8-27B-NVFP4 실패 24% (8/34) — 재시도와 예비 모델이 받아 주지만 처리량이 줄고 지연이 늘어납니다.", "모델 연결", ACTION_LINKS.models],
  ["takedowns", "critical", 3, "건", "내려달라는 요청 — 24시간 넘음 1", "대기 3 · 최장 1일 6시간 — 내릴 후보에서 처리", "처리", ACTION_LINKS.takedowns],
  ["audit", "hold", 7, "건", "감사가 거절 판정한 발행분이 처리되지 않았습니다", "발행 뒤 감사가 “제품 아님”으로 본 것 — 사람이 내리거나 유지로 정해야 합니다.", "내릴 후보", ACTION_LINKS.audit],
  ["audit-stalled", "hold", 5_176, "건", "발행분 감사가 멈춰 있습니다",
    "감사 #3은 프롬프트 2026-09-19.3로 시작했는데 지금 코드와 달라 매 틱 건너뜁니다 — 남은 5,176건은 사람이 중단하고 새 감사를 열어야 다시 봅니다.", "감사", ACTION_LINKS.audit],
  ["cdn-purge", "hold", 2, "건", "내린 제품의 CDN 캐시가 지워지지 않았습니다",
    "10분 넘게 확인되지 않은 지우기 요청 — 발행 워커의 CLOUDFLARE_ZONE_ID·CLOUDFLARE_PURGE_TOKEN 을 확인합니다. 그동안 내린 페이지가 Cloudflare 에 남습니다.", "작업 흐름", ACTION_LINKS.jobs],
  ["evidence-backlog", "hold", 39_749, "건", "제품 근거 갱신이 밀렸습니다",
    "기한 지난 출처 39,749건 · 가장 오래된 것 8일 — 제품 근거 갱신 처리량이 출처 수를 못 따라갑니다.", "근거 갱신 작업", jobHref("product-evidence-refresh")],
  ["health-overdue", "clear", 172, "건", "생존 확인이 6시간 넘게 밀린 제품", "서비스 응답 점검 처리량이 목표(시간당 6,796)에 못 미치면 쌓입니다.", "응답 점검 작업", jobHref("uptime-ping")],
  ["intro", "hold", 9, "건", "소개 확인이 필요한 제품", "소개 검수가 근거로는 알 수 없다고 한 것 — 검수 잡은 멈춰 있습니다.", "제품 관리", ACTION_LINKS.productsIntro],
  // attention.tsx:419 — 48시간 넘게 처리 안 된 것이 있어 critical
  ["repo-gone", "critical", 141, "건", "저장소가 사라진 공개 제품 — 48시간 넘게 처리 안 됨",
    "GitHub 저장소가 없거나 빈 채로 하루 넘게 이어짐 — 설치형 0건은 목록에서 가려짐 · 웹 141건은 GitHub 표시만 뺌. 잡이 github.com 을 다시 열어 정말 없으면 내립니다(하루 100건까지): 확인 대기 0 · 내릴 후보 44 · 사람 확인(옮겨 간 흔적) 97 · 저장소 다시 열림 0 · 가장 오래 기다린 것 206시간.",
    "제품 관리", ACTION_LINKS.productsRepoGone],
  ["spam-auto-ban", "critical", 50, "건", "스팸 자동 차단이 하루 한도(50건)에 닿아 멈췄습니다",
    "지난 24시간에 50건을 내렸습니다(판정 2026-10-08.2). 더 걸린 것은 내리지 않고 기다립니다 — 판정이 잘못 바뀌지 않았는지 내린 목록부터 보세요. 자동 차단으로 남아 있는 것 257건.",
    "자동 차단 목록", ACTION_LINKS.productsSpamBanned],
  ["repo-coverage", "hold", 4, "%", "저장소 확인 범위가 95% 아래입니다",
    "GitHub 저장소가 있는 공개 제품 1,000개 중 지난 24시간에 확인한 것 40개 — GitHub 저장소·스타 확인 작업이 밀리거나 GitHub 한도에 걸렸습니다.", "작업 흐름", ACTION_LINKS.jobs],
  ["settings-apply", "hold", 2, "개", "설정을 저장했는데 워커 2개가 아직 옛 판으로 돕니다", "후보 심사 · 제품 발행", "적용 확인", ACTION_LINKS.settingsApply],
  ["quota", "hold", 1, "자격", "일부 수집 자격의 core 잔량이 적습니다",
    "PAT first 120/5,000 · 14:38 (1시간 후) 초기화 — 다른 자격과 환경 토큰은 별도입니다. 풀 전체 고갈을 뜻하지 않습니다.", "수집 계정", ACTION_LINKS.githubAccounts],
];

/** 어느 집계도 읽지 못했을 때 — "0건"이 아니라 "미확인"으로 선다 */
const UNREADABLE_CONTRACT: ContractRow[] = [
  ["roles-unknown", "hold", "미확인", "상태", "역할·예비 상태를 읽지 못했습니다", RECHECK, "상태 확인", ACTION_LINKS.roles],
  ["models-unknown", "hold", "미확인", "상태", "모델 상태를 읽지 못했습니다", RECHECK, "상태 확인", ACTION_LINKS.models],
  ["throughput-unknown", "hold", "미확인", "상태", "저장 진행 상태를 읽지 못했습니다", RECHECK, "상태 확인", ACTION_LINKS.jobs],
  ["attention-unknown", "hold", "미확인", "상태", "제품 운영 집계 상태를 읽지 못했습니다", RECHECK, "상태 확인", ACTION_LINKS.jobs],
  ["web", "hold", "확인 필요", "상태", "웹 관측 0/2 · 누락", WEB, "웹 관측", ACTION_LINKS.roles],
  ["ai", "critical", "끊김", "상태", "AI 연결 서비스 관측이 끊겼습니다",
    "AI 연결·분류 실행 마지막 관측 없음 — 발행 워커가 카테고리를 정하지 못해 승인 후보를 1시간씩 보류합니다.", "연결 상태", ACTION_LINKS.ai],
  ["search-health-missing", "hold", "모름", "상태", "검색 데이터 점검 결과가 없습니다",
    "마지막 점검 없음 — 45분이 지나면 결과를 믿지 않습니다. 키워드 대기 수도 알 수 없습니다.", "점검 작업", ACTION_LINKS.jobs],
  ["quota-unknown", "hold", "미확인", "상태", "GitHub 수집 자격 일부를 읽지 못했습니다",
    "PAT·App의 저장된 core 관측을 모두 읽어야 합니다. 환경 토큰·인증·search·GraphQL 가용성은 이 집계로 판단하지 않습니다.", "수집 계정", ACTION_LINKS.githubAccounts],
];

/** 쌓인 일이 모두 hold 인 상태 — 저장소 사라짐은 48시간 안, 스팸 자동 차단은 하루 한도 아래 */
const calmInputs = (): ActionInputs => {
  const inputs = brokenActionInputs();
  return { ...inputs, attention: { ...inputs.attention!, repoReview: { ...inputs.attention!.repoReview, oldestHours: 30 }, spamAutoBans: { day: 3, banned: 257 } } };
};

describe("조치 계약 — 키·급·숫자·단위·제목·설명·가는 곳", () => {
  it("거의 모든 것이 나쁠 때 세우는 줄과 차례", () => {
    expect(build(brokenActionInputs(), brokenWorkerProgress()).map(row)).toEqual(BROKEN_CONTRACT);
  });

  it("집계를 읽지 못했을 때 세우는 줄과 차례", () => {
    expect(build(unreadableActionInputs()).map(row)).toEqual(UNREADABLE_CONTRACT);
  });

  it("조치 키는 겹치지 않는다 — 숨김·24시간 변화·화면 key 가 모두 이 열쇠로 묶인다", () => {
    for (const contract of [BROKEN_CONTRACT, UNREADABLE_CONTRACT]) {
      const keys = contract.map(([key]) => key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  /** 같은 열쇠의 다른 갈래 — 급·제목·설명이 입력에 따라 바뀌는 곳 */
  const broken = brokenActionInputs();
  const agent = (value: Record<string, unknown>, observedAt = ACTION_NOW): ActionInputs => ({ ...broken, ops: { ...broken.ops, serviceInstances: [
    ...broken.ops.serviceInstances.filter((item) => item.role !== "connect-agent"),
    { key: "service:connect-agent:m3", role: "connect-agent", instanceId: "m3", observedAt: observedAt.toISOString(), value: { config: { primary: { model: "gpt-5.5" }, fallback: { model: "sonnet" } }, ...value } },
  ] } } as ActionInputs);
  const attention = (patch: Partial<NonNullable<ActionInputs["attention"]>>) => ({ ...broken, attention: { ...broken.attention!, ...patch } }) as ActionInputs;
  const variants: Array<[name: string, inputs: ActionInputs, key: string, expected: Partial<ContractRow>, workerProgress?: DerivedStatus["workerProgress"]]> = [
    ["AI 관측이 2분 넘게 끊김", agent({ classifyReady: true, configReady: true }, new Date(ACTION_NOW.getTime() - 3 * 60_000)), "ai",
      ["ai", "critical", "끊김", "상태", "AI 연결 서비스 관측이 끊겼습니다", "AI 연결·분류 실행 마지막 관측 13:35 (3분 전) — 발행 워커가 카테고리를 정하지 못해 승인 후보를 1시간씩 보류합니다.", "연결 상태", ACTION_LINKS.ai]],
    ["적용한 모델 설정이 없어 분류를 받지 않음", agent({ classifyReady: false, configReady: false, configVersion: 0 }), "ai",
      ["ai", "critical", "멈춤", "상태", "AI 분류를 받지 않습니다", "적용한 모델 설정이 없습니다 — 적용할 때까지 발행 워커가 승인 후보를 1시간씩 보류합니다.", "검사·적용", ACTION_LINKS.ai]],
    ["새 인증 뒤 적용 전이라 분류를 받지 않음", agent({ classifyReady: false, configReady: false, configVersion: 3 }), "ai",
      ["ai", "critical", "멈춤", "상태", "AI 분류를 받지 않습니다", "새 인증 뒤 모델 검사·적용이 남았습니다 — 적용할 때까지 발행 워커가 승인 후보를 1시간씩 보류합니다.", "검사·적용", ACTION_LINKS.ai]],
    ["설정한 계정이 모두 실패", agent({ classifyReady: true, configReady: true, accounts: { codex: { result: "access_denied" }, claude: { result: "rate_limit" } } }), "ai-account",
      ["ai-account", "critical", "2/2", "계정", "설정한 AI 계정이 모두 실패합니다", "Codex access_denied · Claude rate_limit — 다시 인증하고 모델을 검사·적용합니다.", "다시 인증", ACTION_LINKS.ai]],
    ["2차 실패 — 모델은 아직 있음", { ...broken, secondFailures: [{ model: "[MLX] qwen3.6", errorCode: "timeout", count: 4 }] } as ActionInputs, "second-failed",
      ["second-failed", "hold", 4, "건", "2차 심사가 실패하고 있습니다", "최근 24시간 미해결 오류 · qwen3.6 timeout 4건", "2차 심사 설정", ACTION_LINKS.secondSettings]],
    ["2차 확정할 것 없이 공개분만", { ...broken, overview: humanOverview({ human: 1, oldestDays: 1, published: 4 }) } as ActionInputs, "second",
      ["second", "hold", 4, "건", "2차 심사 확인", "확정만 하면 됨 0건(거부 0 · 승인 0, 그중 만장일치 0)은 한 번에 확정 · 공개분 4건은 사람이 봅니다. 엇갈린 것은 직접 판단에 들어 있습니다.", "2차 심사", ACTION_LINKS.reviewPublished]],
    ["직접 판단에 2주 넘은 것이 없음", { ...broken, overview: humanOverview({ human: 3, oldestDays: 2, in24h: 3, decided: 1 }) } as ActionInputs, "review",
      ["review", "hold", 3, "건", "사람이 가려야 할 후보 — 직접 판단", "판정 뒤 최장 2일 · 24h +3 · 처리 1.", "심사 큐", ACTION_LINKS.reviewHuman]],
    ["다음 재분류 시각을 모름", { ...broken, ops: { ...broken.ops, heldNextRetryAt: null } } as ActionInputs, "held",
      ["held", "hold", 5, "건", "분류를 못 정해 발행이 멈춘 후보", "승인은 끝났고 카테고리만 없습니다. 1시간 뒤 저절로 다시 분류합니다. 급하면 수동으로 지정합니다.", "수동 분류", ACTION_LINKS.manual]],
    ["실패한 작업이 하나면 그 작업 상세로", { ...broken, jobStates: [broken.jobStates[0]] } as ActionInputs, "jobs",
      ["jobs", "critical", 1, "개", "마지막 회차가 실패한 작업", "제품 근거 갱신 — 실패한 작업 뒤의 단계는 새 일감을 받지 못합니다.", "작업 흐름", jobHref("product-evidence-refresh")]],
    ["검색 점검 작업이 실패", { ...broken, jobStates: [{ ...broken.jobStates[0], name: "product-search-health" }] } as ActionInputs, "search-health-missing",
      ["search-health-missing", "hold", "모름", "상태", "검색 데이터 점검 결과가 없습니다", "점검 작업이 마지막 회차에 실패했습니다. 키워드 대기 수도 알 수 없습니다.", "점검 작업", ACTION_LINKS.jobs]],
    ["스케줄러 관측 0대", { ...broken, roles: { ...broken.roles!, scheduler: { freshReplicas: 0, alarm: true } } } as ActionInputs, "scheduler-replicas",
      ["scheduler-replicas", "critical", "0/2", "대", "스케줄러 복제 관측이 부족합니다", "최근 관측 0대 — scheduler 앱의 두 복제본과 로그를 확인합니다.", "역할 표", ACTION_LINKS.roles]],
    ["밀린 예약이 하나면 그 작업 상세로", broken, "scheduler",
      ["scheduler", "critical", 1, "개", "스케줄러 예약이 밀렸습니다", "서비스 응답 점검", "작업 흐름", jobHref("uptime-ping")],
      { ...brokenWorkerProgress(), scheduler: { role: "scheduler", reason: "scheduler_missed", alarm: true, overdueJobs: ["uptime-ping"] } }],
    ["예약 시각을 모르는 작업", broken, "scheduler-unknown",
      ["scheduler-unknown", "hold", "모름", "상태", "스케줄러 예약 상태를 확인할 수 없습니다", "다음 예약 시각이 없는 작업이 있습니다 — 스케줄러 관측과 작업 표를 확인합니다.", "작업 흐름", ACTION_LINKS.jobs],
      { ...brokenWorkerProgress(), scheduler: { role: "scheduler", reason: "unknown_schedule", alarm: false, overdueJobs: [] } }],
    ["내려달라는 요청 — 24시간 안·몰림", { ...broken, takedowns: { pending: 2, overdue: 0, oldestHours: 0.5, lastHour: { requests: 10 } } } as ActionInputs, "takedowns",
      ["takedowns", "hold", 2, "건", "내려달라는 요청", "대기 2 · 최장 30분 · 지난 1시간 10건 몰림 — 내릴 후보에서 처리", "처리", ACTION_LINKS.takedowns]],
    ["생존 확인이 5,000건 넘게 밀림", attention({ healthOverdue: 5_001 }), "health-overdue",
      ["health-overdue", "hold", 5_001, "건", "생존 확인이 6시간 넘게 밀린 제품", "서비스 응답 점검 처리량이 목표(시간당 6,796)에 못 미치면 쌓입니다.", "응답 점검 작업", jobHref("uptime-ping")]],
    ["소개 검수 잡이 돌고 있음", { ...broken, jobStates: broken.jobStates.filter((item) => item.name !== "product-intro-check") } as ActionInputs, "intro",
      ["intro", "hold", 9, "건", "소개 확인이 필요한 제품", "소개 검수가 근거로는 알 수 없다고 한 것.", "제품 관리", ACTION_LINKS.productsIntro]],
    ["저장소 사라짐 — 48시간 안·기다린 것 없음", attention({ repoReview: { pending: 3, delistCandidates: 0, human: 0, kept: 1, oldestHours: null } }), "repo-gone",
      ["repo-gone", "hold", 141, "건", "저장소가 사라진 공개 제품",
        "GitHub 저장소가 없거나 빈 채로 하루 넘게 이어짐 — 설치형 0건은 목록에서 가려짐 · 웹 141건은 GitHub 표시만 뺌. 잡이 github.com 을 다시 열어 정말 없으면 내립니다(하루 100건까지): 확인 대기 3 · 내릴 후보 0 · 사람 확인(옮겨 간 흔적) 0 · 저장소 다시 열림 1.",
        "제품 관리", ACTION_LINKS.productsRepoGone]],
    ["스팸 자동 차단 — 하루 한도 아래", attention({ spamAutoBans: { day: 3, banned: 257 } }), "spam-auto-ban",
      ["spam-auto-ban", "hold", 3, "건", "스팸 패턴으로 자동 차단한 공개 제품",
        "지난 24시간에 3건을 내렸습니다(판정 2026-10-08.2). 잘못 내려간 것은 차단 해제하면 재검사가 다시 내리지 않습니다. 자동 차단으로 남아 있는 것 257건.",
        "자동 차단 목록", ACTION_LINKS.productsSpamBanned]],
  ];
  it.each(variants)("%s", (_name, inputs, key, expected, workerProgress) => {
    const found = build(inputs, workerProgress ?? brokenWorkerProgress()).find((item) => item.key === key);
    expect(found && row(found)).toEqual(expected);
  });

  it("문턱 — 근거는 72시간 넘게, 저장소 확인은 95% 아래, 모델 실패는 10번 이상 호출에 20% 이상, 생존 확인은 5,000건 넘으면 hold", () => {
    const keys = (inputs: ActionInputs) => build(inputs, brokenWorkerProgress()).map((item) => item.key);
    expect(keys({ ...broken, evidenceSummary: { ...broken.evidenceSummary, oldestDueHours: 72 } })).not.toContain("evidence-backlog");
    expect(keys({ ...broken, evidenceSummary: { ...broken.evidenceSummary, oldestDueHours: 72.1 } })).toContain("evidence-backlog");
    expect(keys(attention({ repoHealth: { ...broken.attention!.repoHealth, checked24h: 950 } }))).not.toContain("repo-coverage");
    expect(keys(attention({ repoHealth: { ...broken.attention!.repoHealth, checked24h: 949 } }))).toContain("repo-coverage");
    const model = (calls1h: number, failed1h: number) => ({ ...broken, models: [{ ...broken.models![0], calls1h, failed1h }] }) as ActionInputs;
    expect(keys(model(10, 2))).toContain("model-failures");
    expect(keys(model(10, 1))).not.toContain("model-failures");
    expect(keys(model(9, 9))).not.toContain("model-failures");
    expect(keys(attention({ repoReview: { ...broken.attention!.repoReview, oldestHours: 48 } }))).toContain("repo-gone");
    expect(build(attention({ repoReview: { ...broken.attention!.repoReview, oldestHours: 48 } }), brokenWorkerProgress())
      .find((item) => item.key === "repo-gone")?.tone).toBe("hold");
    expect(build(attention({ spamAutoBans: { day: 49, banned: 0 } }), brokenWorkerProgress()).find((item) => item.key === "spam-auto-ban")?.tone).toBe("hold");
    expect(build(attention({ healthOverdue: 5_000 }), brokenWorkerProgress()).find((item) => item.key === "health-overdue")?.tone).toBe("clear");
  });
});

describe("지금 조치 · 쌓인 일 나누기 계약", () => {
  it("쌓인 일 열쇠는 이 열세 개다 — x-status 는 운영센터 v8 PR9(X 보고)가, x-candidates 는 무음 실패 점검(이틀째 후보 0)이 더했다", () => {
    expect([...BACKLOG_KEYS].sort()).toEqual([
      "audit", "audit-stalled", "evidence-backlog", "health-overdue", "held", "intro", "repo-coverage", "repo-gone", "review", "second", "spam-auto-ban",
      "x-candidates", "x-status",
    ]);
  });

  it("쌓인 일 열쇠마다 buildActions 가 세우는 줄이 있다 — 죽은 열쇠가 없다", () => {
    // x-status 줄은 받는 주소가 켜져 있고(비밀 설정) 보고가 끊기거나 깨졌을 때만 선다 — 여기서는 오류를 보고한 실제 수집 한 줄을 더한다.
    // x-candidates 는 끝난 실제 수집이 이틀 잇달아 후보 0 일 때 선다(x-status:runs)
    vi.stubEnv("X_STATUS_REPORT_SECRET", "x".repeat(40));
    try {
      const inputs = calmInputs();
      const hourAgo = new Date(ACTION_NOW.getTime() - 3_600_000).toISOString();
      const withX: ActionInputs = { ...inputs, ops: { ...inputs.ops, observations: [...inputs.ops.observations,
        { key: "x-status", value: { v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 0, lastRunAt: hourAgo, lastSuccessAt: null,
          error: "http_error", sentAt: Math.floor(ACTION_NOW.getTime() / 1000) - 3_600, signedWith: "current" }, observedAt: hourAgo },
        { key: "x-status:runs", value: { zeroRuns: 2, zeroSince: hourAgo, lastCompletedRunAt: hourAgo, lastCandidates: 0 }, observedAt: hourAgo }] } };
      const keys = new Set(build(withX, brokenWorkerProgress()).map((item) => item.key));
      for (const key of BACKLOG_KEYS) expect(keys.has(key), key).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("critical·쌓인 일 열쇠가 아닌 것은 지금 조치, 나머지는 쌓인 일 — 급한 것부터, 같은 급은 넣은 차례", () => {
    const split = splitActions(build(brokenActionInputs(), brokenWorkerProgress()), { samples: [], acks: new Map(), now: ACTION_NOW });
    expect(split.urgent.map((item) => item.key)).toEqual([
      "search-hash", "search-copies", "search-missing", "search-exhausted", "jobs", "second-failed", "down", "standby", "role-reviewer", "role-text",
      "liveness", "scheduler", "stage-progress", "takedowns", "repo-gone", "spam-auto-ban",
      "web", "search-repeated", "search-generation-stalled", "search-verification-wait", "ai-account", "ai-apply", "model-servers", "role-publisher",
      "restarts", "scheduler-replicas", "model-failures", "cdn-purge", "settings-apply", "quota",
    ]);
    // 쌓인 일 열쇠라도 critical 이면(저장소 사라짐 48시간·스팸 한도) 지금 조치에 선다
    expect(split.backlog.map((item) => item.key)).toEqual(["review", "second", "held", "audit", "audit-stalled", "evidence-backlog", "intro", "repo-coverage", "health-overdue"]);
    expect(split.hidden).toEqual([]);
    // 기록이 없으면 새로 생긴 것으로 보지 않고 변화도 달지 않는다
    expect([...split.urgent, ...split.backlog].every((item) => !item.fresh && item.trend === null)).toBe(true);
  });

  it("24시간 변화 — 1시간~24.5시간 전 가장 오래된 기록과 견주고, 그때 없던 쌓인 일은 '새로 생김'으로 지금 조치에 선다", () => {
    const actions = build(calmInputs(), brokenWorkerProgress());
    const counts = actionCounts(actions);
    const withoutIntro = Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "intro"));
    const samples: AttentionSample[] = [
      { at: new Date(ACTION_NOW.getTime() - 30 * 3_600_000).toISOString(), counts: {} },
      { at: new Date(ACTION_NOW.getTime() - 23 * 3_600_000).toISOString(), counts: { ...withoutIntro, review: 2_000, "evidence-backlog": 40_000 } },
      { at: new Date(ACTION_NOW.getTime() - 0.5 * 3_600_000).toISOString(), counts: {} },
    ];
    const split = splitActions(actions, { samples, acks: new Map(), now: ACTION_NOW });
    expect(split.urgent.filter((item) => item.fresh && BACKLOG_KEYS.has(item.key)).map((item) => item.key)).toEqual(["intro"]);
    expect(split.backlog.some((item) => item.fresh)).toBe(false);
    // 상태 글자 줄(확인 필요·1/2·담당 기한 지남)은 시간별 기록에 남지 않아, 기준이 있으면 늘 '새로 생김'이다 — 오늘 그대로
    expect(split.urgent.filter((item) => item.fresh && !BACKLOG_KEYS.has(item.key)).map((item) => item.key))
      .toEqual(["role-reviewer", "role-text", "web", "ai-account", "ai-apply", "role-publisher", "scheduler-replicas"]);
    const trend = new Map(split.backlog.map((item) => [item.key, item.trend]));
    expect(trend.get("review")).toEqual({ delta: 270, hours: 23 });
    expect(trend.get("evidence-backlog")).toEqual({ delta: -251, hours: 23 });
    expect(trend.get("held")).toEqual({ delta: 0, hours: 23 });
    // 기준이 1시간 안 것뿐이면 기준이 없다 — 새로 생긴 것도 변화도 없다
    const young = splitActions(actions, { samples: samples.slice(2), acks: new Map(), now: ACTION_NOW });
    expect([...young.urgent, ...young.backlog].some((item) => item.fresh || item.trend !== null)).toBe(false);
  });

  it("확인함 · 7일 숨김 — 쌓인 일에만 걸리고, critical 이 되거나 새로 생기면 숨김과 상관없이 지금 조치에 선다", () => {
    expect(ACK_DAYS).toBe(7);
    expect([ACK_ACTION, UNACK_ACTION]).toEqual(["attention-ack", "attention-unack"]);
    const ack = (key: string): AttentionAck => ({ key, actor: "local", at: new Date(ACTION_NOW.getTime() - 3_600_000), until: new Date(ACTION_NOW.getTime() + 6 * 86_400_000) });
    const acks = new Map([...BACKLOG_KEYS, "down", "web"].map((key) => [key, ack(key)]));
    const calm = splitActions(build(calmInputs(), brokenWorkerProgress()), { samples: [], acks, now: ACTION_NOW });
    expect(calm.backlog).toEqual([]);
    expect(calm.hidden.map((item) => item.key)).toEqual(["review", "second", "held", "audit", "audit-stalled", "evidence-backlog", "intro", "repo-gone", "spam-auto-ban", "repo-coverage", "health-overdue"]);
    expect(calm.hidden.every((item) => item.ack?.actor === "local")).toBe(true);
    // 쌓인 일이 아닌 것(down·web)은 숨김 기록이 있어도 숨지 않는다
    expect(calm.urgent.map((item) => item.key)).toEqual(expect.arrayContaining(["down", "web"]));
    const broken = splitActions(build(brokenActionInputs(), brokenWorkerProgress()), { samples: [], acks, now: ACTION_NOW });
    expect(broken.urgent.map((item) => item.key)).toEqual(expect.arrayContaining(["repo-gone", "spam-auto-ban"]));
    expect(broken.hidden.map((item) => item.key)).not.toContain("repo-gone");
    // 기준 시각에 없던 쌓인 일은 숨김 기록이 있어도 '새로 생김'으로 선다
    const actions = build(calmInputs(), brokenWorkerProgress());
    const baseline = Object.fromEntries(Object.entries(actionCounts(actions)).filter(([key]) => key !== "intro"));
    const fresh = splitActions(actions, { samples: [{ at: new Date(ACTION_NOW.getTime() - 20 * 3_600_000).toISOString(), counts: baseline }], acks, now: ACTION_NOW });
    expect(fresh.urgent.find((item) => item.key === "intro")).toMatchObject({ fresh: true });
    expect(fresh.hidden.map((item) => item.key)).not.toContain("intro");
  });

  it("화면 — 쌓인 일마다 '확인함 · 7일 숨김', 숨긴 것은 접어 '다시 보이기', 지금 조치에는 숨김 단추가 없다", () => {
    const actions = build(calmInputs(), brokenWorkerProgress());
    const acks = new Map([["intro", { key: "intro", actor: "local", at: new Date(ACTION_NOW.getTime() - 86_400_000), until: new Date(ACTION_NOW.getTime() + 6 * 86_400_000) }]]);
    const split = splitActions(actions, { samples: [], acks, now: ACTION_NOW });
    const out = renderToStaticMarkup(createElement(AttentionList, { ...split, now: ACTION_NOW.toISOString() }));
    const [urgentHtml, backlogHtml] = out.split('aria-labelledby="todo-backlog"');
    expect(urgentHtml).not.toContain("확인함 · 7일 숨김");
    expect(backlogHtml.split("확인함 · 7일 숨김")).toHaveLength(split.backlog.length + 1);
    expect(out).toContain("확인함으로 숨긴 것 1건");
    expect(out).toContain("local 확인 1일 전 · 10/14 13:38까지");
    expect(out.split("다시 보이기")).toHaveLength(2);
    expect(out).toContain("늘 떠 있는 백로그 · 24시간 변화");
    expect(out).toContain("급한 것·새로 생긴 것 · 급한 것부터");
  });
});

describe("메뉴 긴급 배지와 시간별 기록에 넘기는 수", () => {
  it("긴급 배지는 buildActions 의 critical 수 — 지금 조치의 critical 과 같다", () => {
    const actions = build(brokenActionInputs(), brokenWorkerProgress());
    expect(rememberCriticalCount(actions)).toBe(16);
    expect(splitActions(actions, { samples: [], acks: new Map(), now: ACTION_NOW }).urgent.filter((item) => item.tone === "critical")).toHaveLength(16);
    expect(rememberCriticalCount(build(unreadableActionInputs()))).toBe(1);
  });

  it("시간별 기록에는 숫자인 수만 열쇠별로 남긴다 — 상태 글자(미확인·끊김·1/2)는 뺀다", () => {
    expect(actionCounts(build(brokenActionInputs(), brokenWorkerProgress()))).toEqual({
      "search-hash": 1, "search-copies": 4, "search-missing": 2, "search-exhausted": 5, "search-repeated": 3, "search-generation-stalled": 10,
      "search-verification-wait": 6, "model-servers": 1, jobs: 2, review: 2_270, second: 16, "second-failed": 5, held: 5, down: 3, standby: 1,
      liveness: 2, restarts: 3, scheduler: 2, "stage-progress": 1, "model-failures": 1, takedowns: 3, audit: 7, "audit-stalled": 5_176,
      "cdn-purge": 2, "evidence-backlog": 39_749, "health-overdue": 172, intro: 9, "repo-gone": 141, "spam-auto-ban": 50, "repo-coverage": 4,
      "settings-apply": 2, quota: 1,
    });
    expect(actionCounts(build(unreadableActionInputs()))).toEqual({});
  });
});
