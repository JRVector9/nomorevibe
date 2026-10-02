import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KpiStrip } from "@/app/admin/status/dashboard/KpiStrip";
import { StageRail } from "@/app/admin/status/dashboard/StageRail";
import { RolesTable } from "@/app/admin/status/dashboard/RolesTable";
import { StatusChips } from "@/app/admin/status/dashboard/StatusChips";
import { AttentionList } from "@/app/admin/status/dashboard/AttentionList";
import { SignalTable } from "@/app/admin/status/dashboard/SignalTable";
import { ModelCards } from "@/app/admin/status/dashboard/ModelCards";
import { Sparkline } from "@/app/admin/status/dashboard/Sparkline";
import type { HourlySeries, ModelHealth } from "@/lib/operations/dashboard";
import type { ThroughputStage } from "@/lib/operations/throughput-model";
import type { RoleOverview } from "@/lib/operations/roles";

/**
 * 운영센터 격자 조각 — 숫자와 색이 데이터대로 나오는지.
 *
 * 12칸 격자 정렬은 CSS 라 여기서 못 본다. 각 조각이 자기 칸 수(dash-2/4/8/12)를 달고 나오는지와,
 * 경보 조건(2차 일치 70% 미만, 예비가 일함, 실패율 10%)이 색으로 바뀌는지만 잰다.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

function series(last: Partial<HourlySeries["points"][number]> = {}): HourlySeries {
  const base = { discovered: 10, judged: 10, firstReviews: 8, firstFailed: 0, secondReviews: 6, secondAgreed: 5, published: 3, publishedKorean: 0, keywords: 4 };
  const points = Array.from({ length: 24 }, (_, i) => ({ hour: `2026-10-02T${String(i).padStart(2, "0")}:00:00.000Z`, ...base }));
  points[23] = { ...points[23], ...last };
  return { measuredAt: "2026-10-02T23:30:00.000Z", points };
}

describe("지금 처리량", () => {
  it("타일 여섯이 2칸씩이고 끝 시간의 수를 보인다", () => {
    const out = html(createElement(KpiStrip, { series: series({ discovered: 1133, published: 164, publishedKorean: 7 }), textPending: 218, verifyPending: 193 }));
    expect(out.match(/dash-2/g)).toHaveLength(6);
    expect(out).toContain("1,133");
    expect(out).toContain("164");
    expect(out).toContain("대기 218");
    expect(out).toContain("검수 대기 193");
  });

  it("1차 실패율은 끝난 심사와 실패 호출의 합을 분모로 쓴다", () => {
    const out = html(createElement(KpiStrip, { series: series({ firstReviews: 3, firstFailed: 17 }), textPending: 0, verifyPending: 0 }));
    expect(out).toContain("실패 85%");
    expect(out).toContain('data-tone="bad"');
  });

  it("2차 일치가 70% 아래면 주황으로 갈림 수를 적는다", () => {
    const out = html(createElement(KpiStrip, { series: series({ secondReviews: 227, secondAgreed: 120 }), textPending: 0, verifyPending: 0 }));
    expect(out).toContain("1차와 일치 53%");
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("갈림 → 사람 확인 107건/h");
  });

  it("자료가 없으면 빈 카드 한 장으로 자리를 지킨다", () => {
    const out = html(createElement(KpiStrip, { series: null, textPending: 0, verifyPending: 0 }));
    expect(out).toContain("dash-12");
    expect(out).toContain("불러오지 못했습니다");
  });
});

describe("파이프라인 레일", () => {
  const flow = { stages: [], bottleneck: null, published: 0 };
  const snapshot = { measuredAt: "2026-10-02T23:30:00.000Z", stages: [
    { key: "fetch" as const, label: "원본 수집", unit: "건" as const, completed1m: 10, completed5m: 50, waiting: 0, oldestMinutes: null, enabled: true, errors5m: 0, queueNote: "", detail: "", status: "processing" as const },
    { key: "first" as const, label: "AI 1차", unit: "건" as const, completed1m: 0, completed5m: 0, waiting: 40, oldestMinutes: 12, enabled: true, errors5m: 3, queueNote: "", detail: "", status: "stalled" as const },
  ] };
  it("단계마다 대기·최장·5분 처리·워커 진행을 적고 정체는 빨강, 사람 확인이 크면 주황이다", () => {
    const signals = [{ role: "reviewer" as const, stage: "first" as const, reason: "no_progress" as const, alarm: true }];
    const liveness = [{ role: "crawler" as const, reason: "present" as const, alarm: false }];
    const out = html(createElement(StageRail, { snapshot, flow, humanQueue: 2270, humanOldestDays: 22, humanSplit: 2081, signals, liveness }));
    expect(out).toContain("dash-8");
    expect(out).toContain('data-tone="bad"');
    expect(out).toContain("최장 12분");
    expect(out).toContain("오류 3");
    expect(out).toContain("진행 없음");
    expect(out).toContain("워커 정상");
    expect(out).toContain("2,270");
    expect(out).toContain("최장 22일");
    expect(out).toContain("2차 갈림 2,081");
    expect(out).toContain("사람 확인 2,270건이 가장 큰 적체");
  });

  // 사람 확인 칸은 "최장 1일"로 고정해 두어 단계 칸의 문구만 잰다
  const one = (over: Partial<ThroughputStage>, extra: Record<string, unknown> = {}) => html(createElement(StageRail, {
    snapshot: { measuredAt: snapshot.measuredAt, stages: [{ ...snapshot.stages[0], ...over }] }, flow, humanQueue: 1, humanOldestDays: 1, humanSplit: 0, ...extra }));

  it("워커 줄은 관측 끊김·반복 재시작을 일감 없음보다 먼저 적는다", () => {
    const missing = one({ waiting: 0 }, { signals: [{ role: "crawler", stage: "fetch", reason: "no_work", alarm: false }], liveness: [{ role: "crawler", reason: "worker_missing", alarm: true }] });
    expect(missing).toContain("워커 관측 끊김");
    expect(missing).not.toContain("일감 없음");
    const restart = one({}, { liveness: [{ role: "crawler", reason: "restart_loop", alarm: true }] });
    expect(restart).toContain("워커 반복 재시작");
    expect(restart).not.toContain("워커 관측 끊김");
  });

  it("수집할 것이 없고 재시도만 예약돼 있으면 그 수를, 자동 처리가 끝나 사람 몫만 남으면 직접 확인 링크를 보인다", () => {
    const deferred = one({ waiting: 0, oldestMinutes: null, deferred: 27 }, { signals: [{ role: "crawler", stage: "fetch", reason: "no_work", alarm: false }], liveness: [{ role: "crawler", reason: "present", alarm: false }] });
    expect(deferred).toContain("재시도 예약 27건");
    expect(deferred).not.toContain("일감 없음");
    const manual = one({ waiting: 0, oldestMinutes: null, manualAttention: 2 });
    expect(manual).toContain("직접 확인 2건");
    expect(manual).toContain("/admin/review?stage=human#review-list");
    expect(manual).not.toContain("대기 없음");
    const idle = one({ waiting: 0, oldestMinutes: null }, { signals: [{ role: "crawler", stage: "fetch", reason: "no_work", alarm: false }], liveness: [{ role: "crawler", reason: "present", alarm: false }] });
    expect(idle).toContain("일감 없음");
    expect(one({ enabled: false, waiting: 0 })).toContain("일시 중지");
  });
});

describe("역할 표와 상태 칩", () => {
  const role = (over: Partial<RoleOverview>): RoleOverview => ({ role: "crawler", reason: "ready", ownerInstanceId: "m3-crawler", ownerKind: "primary",
    ownerRelease: "6170584abc", epoch: 18, secondsUntilExpiry: 30, primaryRelease: "6170584abc", standbyRelease: "6170584abc", ...over });
  const roles = [role({}), role({ role: "maintenance", reason: "standby_active", ownerInstanceId: "mini-maintenance-standby", ownerKind: "standby", ownerRelease: "ce64737xyz", epoch: 9 })];
  const scheduler = { freshReplicas: 2, alarm: false };
  const web = [{ instance: "m3-web", release: "6170584abc" }, { instance: "mini-web", release: "6170584abc" }];

  it("예비가 일하는 역할은 주황 알약으로 보이고 공통 이미지 릴리스가 갈릴 때만 안내를 붙인다", () => {
    const out = html(createElement(RolesTable, { roles, scheduler, web }));
    expect(out).toContain("mini 예비");
    expect(out).toContain("· 예비가 일함");
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("6170584");
    expect(out).toContain("ce64737");
    expect(out).not.toContain("릴리스가"); // maintenance 는 git 빌드 — 릴리스가 달라도 정상
    expect(out).toContain("2/2 복제");
    const split = html(createElement(RolesTable, { roles, scheduler, web: [web[0], { instance: "mini-web", release: "ce64737xyz" }] }));
    expect(split).toContain("릴리스가 2가지");
  });

  it("머리말 칩은 주 n/5·예비·스케줄러·웹·모델·한도를 한 줄로 요약한다", () => {
    const models: ModelHealth[] = [
      { key: "first", label: "1차 심사", model: "gpt-oss", calls1h: 300, failed1h: 10, avgSeconds: 12, agreement1h: null, lastSuccessAt: null },
      { key: "second", label: "2차 투표", model: "qwen", calls1h: 200, failed1h: 5, avgSeconds: 11, agreement1h: 0.53, lastSuccessAt: null },
    ];
    const out = html(createElement(StatusChips, { roles, scheduler, web, models, quota: { remaining: 400, limit: 5000, resetAt: "2026-10-02T14:35:00.000Z" } }));
    expect(out).toContain("워커 주 1/2 · 예비가 일함 1");
    expect(out).toContain("스케줄러 2/2");
    expect(out).toContain("웹 m3·mini 같은 릴리스");
    expect(out).toContain("모델 1/2 정상");
    expect(out).toContain("GitHub 한도 400/5,000");
    expect(out).toContain('data-tone="bad"');
  });
});

describe("모델·조치·신호", () => {
  it("실패율 10% 이상은 주황, 2차 일치 70% 미만은 일치율을 알약에 적는다", () => {
    const rows: ModelHealth[] = [
      { key: "first", label: "1차 심사", model: "[MLX] gpt-oss-120b", calls1h: 100, failed1h: 12, avgSeconds: 12.3, agreement1h: null, lastSuccessAt: null },
      { key: "second", label: "2차 투표", model: "[MLX] qwen3.6", calls1h: 100, failed1h: 0, avgSeconds: 11, agreement1h: 0.53, lastSuccessAt: null },
      { key: "fallback", label: "2차 fallback", model: "sonnet", calls1h: 0, failed1h: 0, avgSeconds: null, agreement1h: null, lastSuccessAt: null },
    ];
    const out = html(createElement(ModelCards, { rows, probes: [{ provider: "claude", result: "success", checkedAt: null }] }));
    expect(out).toContain("11.0</b>초 (대기 포함)");
    expect(out).toContain("실패 12%");
    expect(out).toContain("일치 53%");
    expect(out).toContain("호출 없음");
    expect(out).toContain("Claude 연결 확인");
  });

  it("조치 목록은 받은 순서대로 띠 색을 단다", () => {
    const out = html(createElement(AttentionList, { items: [
      { key: "a", tone: "critical", count: 3, title: "예비가 일하고 있는 역할", detail: "maintenance" },
      { key: "b", tone: "hold", count: 2270, title: "사람이 가려야 할 후보", detail: "…", action: { label: "심사 큐", href: "/admin/review" } },
    ] }));
    expect(out.indexOf("예비가 일하고")).toBeLessThan(out.indexOf("사람이 가려야"));
    expect(out).toContain('data-tone="bad"');
    expect(out).toContain('href="/admin/review"');
  });

  it("신호 표는 게이트가 켜진 신호에만 거른 수를 적는다", () => {
    const out = html(createElement(SignalTable, { rows: [
      { signal: "Claude 커밋 트레일러", enqueued: 44077, published: 4923, gated: 0, requireEvidence: false },
      { signal: "한국어 README (AI 흔적 필요)", enqueued: 37, published: 3, gated: 20, requireEvidence: true },
    ] }));
    expect(out).toContain("44,077");
    expect(out).toContain("20 거름");
    expect(out.match(/—/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("선 그래프는 점 수만큼 좌표를 찍고 끝점에 원을 둔다", () => {
    const out = html(createElement(Sparkline, { values: [0, 5, 10, 2], tone: "up" }));
    expect(out.match(/\d+\.\d,\d+\.\d/g)).toHaveLength(4);
    expect(out).toContain("<circle");
    expect(out).toContain("var(--color-up)");
  });
});
