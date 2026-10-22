import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/actions", () => ({ requestOperation: vi.fn(), setCollectionEnabled: vi.fn(), codexOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/talk/actions", () => ({ decideTalkHome: vi.fn() }));

import { OperationsCenter, type OperationJob } from "@/app/(operator)/admin/status/OperationsCenter";
import { JOB_LATE_FACTOR, JOB_STALLED_FACTOR, jobLateness } from "@/app/(operator)/admin/status/job-lateness";
import { actionBandTone, AttentionList, type SplitItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { KpiStrip } from "@/app/(operator)/admin/status/dashboard/KpiStrip";
import { RolesTable } from "@/app/(operator)/admin/status/dashboard/RolesTable";
import { StageRail } from "@/app/(operator)/admin/status/dashboard/StageRail";
import { ReviewStageRail } from "@/app/(operator)/admin/review/ReviewStageRail";
import { TalkHomeBoard } from "@/app/(operator)/admin/talk/TalkHomeBoard";
import { auditBadge, AdminNav } from "@/app/(operator)/admin/AdminNav";
import { ACTION_GROUPS, ACTION_LABELS } from "@/app/(operator)/admin/activity/labels";
import { assembleInbox, sectionTone } from "@/app/(operator)/admin/inbox/inbox-model";
import { HUMAN_BACKLOG_LIMIT, humanBacklogged, humanInboxNote } from "@/lib/crawl/human-queue";
import { formatInterval } from "@/lib/format/time";
import type { HourlySeries } from "@/lib/operations/dashboard";
import type { InboxKey, InboxSectionResult } from "@/lib/operations/inbox";
import { humanOverview } from "./fixtures/human-queue";

const NOW = "2026-10-22T04:30:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const job = (over: Partial<OperationJob>): OperationJob => ({ name: "crawl-fetch", status: "유휴", lastRunAt: minutesAgo(0.5), lastSuccessAt: minutesAgo(0.5),
  nextScheduledAt: minutesAgo(-0.5), notBefore: null, workerSeenAt: minutesAgo(0.1), requestedVersion: 3, processedVersion: 3, runs: 120, lastError: null,
  cursor: "null", ...over });

describe("작업 늦음 — 세 화면이 한 규칙(jobLateness)", () => {
  it("주기의 2배부터 지연 ▲, 5배부터 크게 지연 ■, 오류는 실패 ■, 사람이 멈춤·실행 기록 없음은 ○", () => {
    // crawl-fetch 주기 1분
    expect(jobLateness(job({ lastRunAt: minutesAgo(1.9) }), NOW)).toMatchObject({ kind: "ok", state: "ok" });
    expect(jobLateness(job({ lastRunAt: minutesAgo(JOB_LATE_FACTOR) }), NOW)).toMatchObject({ kind: "late", state: "delayed", text: "지연 · 주기의 2배" });
    expect(jobLateness(job({ lastRunAt: minutesAgo(JOB_STALLED_FACTOR) }), NOW)).toMatchObject({ kind: "stalled", state: "failed", text: "크게 지연 · 주기의 5배" });
    expect(jobLateness(job({ lastError: "boom" }), NOW)).toMatchObject({ kind: "error", state: "failed", text: "실패" });
    expect(jobLateness(job({ notBefore: "2100-01-01T00:00:00.000Z", lastRunAt: minutesAgo(600) }), NOW)).toMatchObject({ kind: "paused", state: "idle" });
    expect(jobLateness(job({ lastRunAt: null }), NOW)).toMatchObject({ kind: "never", state: "idle", text: "실행 기록 없음" });
    // 주기가 2시간인 잡은 3시간 전 실행이 늦지 않다(1.5배)
    expect(jobLateness(job({ name: "bluesky-talk", lastRunAt: minutesAgo(180) }), NOW)).toMatchObject({ kind: "ok", intervalMs: 2 * 3_600_000 });
  });

  const data = { fetchedAt: NOW, observations: [], serviceInstances: [], dbLatencyMs: 3, audit: [], held: 0, heldNextRetryAt: null, jobControlVersions: {} };
  const render = (jobs: OperationJob[]) => html(createElement(OperationsCenter, { jobs, data, reviewMode: "enforce", enabled: true,
    attention: null, dashboard: null, statusChips: null, diagnostics: null, manual: null, crawlers: null }));
  beforeEach(() => { nav.params = new URLSearchParams(); });

  it("6분 동안 돌지 않은 1분 잡은 작업 생존 띠·작업 흐름 탭·진단 표 모두 빨강 ■ — 전에는 띠만 빨강, 나머지 둘은 초록이었다", () => {
    const jobs = [job({ lastRunAt: minutesAgo(6), lastSuccessAt: minutesAgo(6) })];
    const strip = render(jobs);
    expect(strip).toMatch(/data-tone="bad"[^>]*><span class="admin-status" data-state="failed">/);
    nav.params = new URLSearchParams("tab=jobs");
    const timeline = render(jobs);
    expect(timeline).toContain("크게 지연 · 주기의 6배");
    expect(timeline).toContain("border-down/40");
    expect(timeline).not.toContain(">정상<");
    nav.params = new URLSearchParams("tab=diagnostics");
    const diagnostics = render(jobs);
    expect(diagnostics).toContain('<span class="admin-status" data-state="failed"><span class="admin-status-mark" aria-hidden="true"></span>프로젝트 원본 수집');
  });

  it("작업 상세 창 — 절대 시각과 'N분 전', 주기 대비 늦음을 함께, 회차 결과 JSON 은 접어 둔다", () => {
    nav.params = new URLSearchParams("job=crawl-fetch");
    const out = render([job({ lastRunAt: minutesAgo(12), lastSuccessAt: minutesAgo(12) })]);
    expect(out).toContain("2026-10-22 13:18:00 KST · 12분 전");
    expect(out).toContain("주기 1분 · 마지막 실행 12분 전 · 크게 지연 · 주기의 12배");
    expect(out).toContain("<details><summary>최근 회차의 처리 결과</summary>");
    expect(out).not.toContain("<details open=\"\"><summary>최근 회차의 처리 결과</summary>");
  });
});

describe("조치할 일 띠 색", () => {
  const item = (tone: SplitItem["tone"]): SplitItem => ({ key: "health-overdue", tone, count: 3_200, unit: "건", title: "생존 확인이 6시간 넘게 밀린 제품",
    detail: "", trend: null, fresh: false });

  it("clear(아직 작은 백로그)는 회색 — 쌓인 일은 초록(정상)으로 그리지 않는다", () => {
    expect(actionBandTone("critical")).toBe("bad");
    expect(actionBandTone("hold")).toBe("warn");
    expect(actionBandTone("clear")).toBeUndefined();
    const out = html(createElement(AttentionList, { urgent: [], backlog: [item("clear")], hidden: [], now: NOW }));
    expect(out).toContain("<li><i");
    expect(out).not.toContain('data-tone="ok"');
  });
});

describe("메뉴 배지 — 내릴 후보", () => {
  it("title 에 갈래와 수를 모두 적는다 — 소개만 있을 때 수가 사라지던 것, 요청이 있을 때 title 이 없던 것", () => {
    expect(auditBadge(null, 0)).toBeUndefined();
    expect(auditBadge({ pending: 0, overdue: 0 }, 0)).toBeUndefined();
    expect(auditBadge(null, 2)).toEqual({ label: "2", tone: "warn", title: "소개 수정 요청 2건" });
    expect(auditBadge({ pending: 3, overdue: 0 }, 0)).toEqual({ label: "3", tone: "warn", title: "내려달라는 요청 3건" });
    // 배지 글자는 합계 하나 — 갈래별 글자가 길면 사이드바 메뉴 이름이 한 글자 폭으로 줄어 세로로 쌓였다
    expect(auditBadge({ pending: 1_204, overdue: 1 }, 1_500)).toEqual({ label: "2,704", tone: "critical",
      title: "내려달라는 요청 1,204건(24시간 넘음 1건) · 소개 수정 요청 1,500건" });
    // 화면 낭독기는 title 을 읽는다 — 수가 들어 있어야 한다
    const nav = html(createElement(AdminNav, { current: "/admin/review", badges: { "/admin/audit": auditBadge(null, 2) } }));
    expect(nav).toContain('<span class="admin-vh">소개 수정 요청 2건</span>');
  });
});

describe("한 개념 한 규칙 — 심각도", () => {
  const ok = (count: number, extra: Record<string, unknown> = {}): InboxSectionResult => ({ ok: true, data: { count, items: [], ...extra } });

  it("응답 없음은 운영센터 조치처럼 오늘 할 일에서도 빨강, 내려달라는 요청은 24시간 넘었을 때만 빨강", () => {
    expect(sectionTone("down", { count: 1, items: [] })).toBe("critical");
    expect(sectionTone("takedown", { count: 2, overdue: 0, items: [] })).toBe("warn");
    expect(sectionTone("takedown", { count: 2, overdue: 1, items: [] })).toBe("critical");
    expect(sectionTone("human", { count: 900, items: [] })).toBe("warn");
    const keys: InboxKey[] = ["takedown", "introRequest", "feedback", "human", "agreed", "audit", "down", "intro", "translations", "repoGone", "repoAutoBanned", "spam"];
    const results = Object.fromEntries(keys.map((key) => [key, ok(key === "down" ? 2 : 0)])) as Record<InboxKey, InboxSectionResult>;
    expect(assembleInbox(results, []).sections.find((section) => section.key === "down")?.tone).toBe("critical");
  });

  it("직접 판단 '쌓임'은 심사 큐·운영센터·오늘 할 일이 같은 500건 규칙 — 2주 넘은 수는 참고 글자일 뿐", () => {
    expect(HUMAN_BACKLOG_LIMIT).toBe(500);
    expect(humanBacklogged(500)).toBe(false);
    expect(humanBacklogged(501)).toBe(true);
    // 오늘 할 일: 300건이고 2주 넘은 것이 40건이면 쌓임 경고는 없다(전에는 이것만으로 경고처럼 보였다)
    expect(humanInboxNote(humanOverview({ human: 300, stalled: 40, oldestDays: 20 }))).toBe("2주 넘음 40건");
    expect(humanInboxNote(humanOverview({ human: 600, stalled: 0, oldestDays: 3 }))).toBe("500건 넘어 쌓임");
    expect(humanInboxNote(humanOverview({ human: 10 }))).toBeUndefined();
    for (const [human, warn] of [[500, false], [501, true]] as const) {
      const overview = humanOverview({ human, oldestDays: 3, decided: 5 });
      const counts = { judge: 0, ...overview.stages, publish: 0, published: 0, rejected: 0 };
      const review = html(createElement(ReviewStageRail, { stage: "", counts, overview, publication: { added: 0, removed: 0, net: 0 } }));
      const status = html(createElement(StageRail, { snapshot: null, flow: { stages: [], bottleneck: null, published: 0 }, human: overview }));
      expect(review.includes('data-tone="warn"'), `심사 큐 ${human}`).toBe(warn);
      expect(status.includes('<li data-tone="warn"'), `운영센터 ${human}`).toBe(warn);
    }
  });
});

describe("지금 처리량 — 굴러가는 최근 1시간", () => {
  const point = (hour: string, over: Partial<HourlySeries["points"][number]> = {}) => ({ hour, discovered: 0, judged: 0, firstReviews: 0, firstFailed: 0,
    secondReviews: 0, secondAgreed: 0, published: 0, publishedKorean: 0, keywords: 0, ...over });

  it("큰 숫자는 lastHour(60분 전부터 지금까지)다 — 정각 직후에도 이번 시 칸으로 떨어지지 않는다", () => {
    const series: HourlySeries = { measuredAt: "2026-10-22T04:05:00.000Z",
      points: [point("2026-10-22T03:00:00.000Z", { firstReviews: 120 }), point("2026-10-22T04:00:00.000Z", { firstReviews: 4 })],
      lastHour: { ...point(""), firstReviews: 118, firstFailed: 6 } };
    const out = html(createElement(KpiStrip, { series, textPending: 0, verifyPending: 0 }));
    expect(out).toContain(">118<");
    expect(out).toContain("최근 1시간 · 24h 평균");
    expect(out).not.toContain("이번 시");
  });
});

describe("역할 표 — 주 격리 남은 시간", () => {
  it("quarantineSeconds 가 있으면 남은 시간을 적는다", () => {
    const role = { role: "crawler", reason: "primary_quarantined" as const, ownerInstanceId: "mini-crawler-standby", ownerKind: "standby",
      ownerRelease: "abc1234", epoch: 7, secondsUntilExpiry: 40, quarantineSeconds: 749.2, primaryRelease: "abc1234", standbyRelease: "abc1234" };
    const out = html(createElement(RolesTable, { roles: [role], scheduler: { freshReplicas: 2, alarm: false }, web: [] }));
    expect(out).toContain("주 격리 12분 30초 남음");
    expect(html(createElement(RolesTable, { roles: [{ ...role, reason: "ready", quarantineSeconds: null }], scheduler: null, web: [] })))
      .not.toContain("주 격리");
  });
});

describe("SNS 화제 — 홈 1위 결정 거두기", () => {
  it("'지우기'가 아니라 '정하지 않음으로' — 결정만 거두고 제품·글은 지우지 않는다", () => {
    const out = html(createElement(TalkHomeBoard, { rows: [{ rank: 1, repositoryKey: "acme/app", slug: "acme-app", name: "Acme", best: "HN 90점 · 댓글 20",
      decision: "approved", onHome: "lead" }] }));
    expect(out).toContain("정하지 않음으로");
    expect(out).not.toContain(">지우기<");
  });
});

describe("작업 로그 이름", () => {
  it("피드백·써봤어요 검수, 공개 번역 재요청, SNS 화제 작업은 이름과 갈래가 있다(기타로 빠지지 않는다)", () => {
    const actions = ["feedback.review", "reaction.comment_review", "product-translation-retry", "talk-post-hide", "talk-post-show",
      "talk-repository-exclude", "talk-repository-include", "talk-home-approved", "talk-home-talk_only", "talk-home-clear",
      "github-collector-app-save", "github-collector-app-enable", "github-collector-app-disable"];
    const grouped = new Set(Object.values(ACTION_GROUPS).flatMap((group) => [...group.actions] as string[]));
    for (const action of actions) {
      expect(ACTION_LABELS[action], action).toBeTruthy();
      expect(grouped.has(action), action).toBe(true);
    }
  });
});

describe("주기 글자", () => {
  it("분·시간으로 적는다", () => {
    expect(formatInterval(60_000)).toBe("1분");
    expect(formatInterval(30 * 60_000)).toBe("30분");
    expect(formatInterval(2 * 3_600_000)).toBe("2시간");
    expect(formatInterval(90 * 60_000)).toBe("1시간 30분");
    expect(formatInterval(null)).toBe("요청될 때");
  });
});
