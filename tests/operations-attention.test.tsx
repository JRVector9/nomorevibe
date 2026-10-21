import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { attentionBaseline, readAttentionHistory, type AttentionAck } from "@/lib/operations/attention";
import { actionCounts, buildActions, deriveStatus, splitActions, type ActionInputs } from "@/app/(operator)/admin/status/attention";
import type { ActionItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { humanOverview } from "./fixtures/human-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
// attention.tsx 는 서버 전용 모듈(근거 요약)을 불러온다 — 여기서는 조회하지 않는다
vi.mock("server-only", () => ({}));

/**
 * 조치할 일 — 지금 조치·쌓인 일로 나누기, 24시간 변화의 기준, 사람이 읽는 문구(2026-10-08 UX 감사 ADM-08·ADM-28).
 */
const NOW = new Date("2026-10-08T04:38:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const item = (key: string, tone: ActionItem["tone"], count: number | string = 10): ActionItem =>
  ({ key, tone, count, unit: typeof count === "number" ? "건" : "상태", title: key, detail: key });

describe("24시간 변화의 기준", () => {
  it("하루 안에서 가장 오래된 것을 쓰고, 1시간이 안 된 것과 하루 반을 넘긴 것은 쓰지 않는다", () => {
    const samples = readAttentionHistory({ samples: [
      { at: hoursAgo(0.5), counts: { review: 9 } },
      { at: hoursAgo(30), counts: { review: 1 } },
      { at: hoursAgo(23.9), counts: { review: 5 } },
      { at: "망가짐", counts: {} },
      { at: hoursAgo(3) },
    ] });
    expect(samples).toHaveLength(3);
    expect(attentionBaseline(samples, NOW)?.counts).toEqual({ review: 5 });
    expect(attentionBaseline(samples.filter((sample) => sample.counts.review === 9), NOW)).toBeNull();
    expect(readAttentionHistory(null)).toEqual([]);
  });
});

describe("지금 조치와 쌓인 일", () => {
  const ack = (key: string): AttentionAck => ({ key, actor: "local", at: new Date(hoursAgo(2)), until: new Date(hoursAgo(-166)) });

  it("critical·장애형은 지금 조치, 만성 백로그는 쌓인 일 — 24시간 변화를 단다", () => {
    const samples = [{ at: hoursAgo(24), counts: { "evidence-backlog": 39_000, "health-overdue": 90 } }];
    const { urgent, backlog, hidden } = splitActions([
      item("evidence-backlog", "hold", 39_749), item("down", "critical", 3), item("model-servers", "hold", 1), item("health-overdue", "clear", 90),
    ], { samples, acks: new Map(), now: NOW });
    expect(urgent.map((row) => row.key)).toEqual(["down", "model-servers"]);
    expect(backlog.map((row) => [row.key, row.trend])).toEqual([["evidence-backlog", { delta: 749, hours: 24 }], ["health-overdue", { delta: 0, hours: 24 }]]);
    expect(hidden).toEqual([]);
  });

  it("기준 시각에 없던 백로그는 '새로 생김'으로 지금 조치에 선다 — 기록이 없으면 새로 생긴 것으로 보지 않는다", () => {
    const samples = [{ at: hoursAgo(20), counts: { review: 1000 } }];
    const fresh = splitActions([item("review", "hold", 1075), item("audit-stalled", "hold", 5176)], { samples, acks: new Map(), now: NOW });
    expect(fresh.urgent.map((row) => [row.key, row.fresh])).toEqual([["audit-stalled", true]]);
    expect(fresh.backlog.map((row) => row.key)).toEqual(["review"]);
    const none = splitActions([item("audit-stalled", "hold", 5176)], { samples: [], acks: new Map(), now: NOW });
    expect(none.backlog.map((row) => [row.key, row.fresh, row.trend])).toEqual([["audit-stalled", false, null]]);
  });

  it("확인함으로 숨긴 쌓인 일은 따로 접고, 같은 항목이 critical 이 되면 숨김과 상관없이 지금 조치에 선다", () => {
    const acks = new Map([["repo-gone", ack("repo-gone")], ["intro", ack("intro")]]);
    const { urgent, backlog, hidden } = splitActions([item("repo-gone", "critical", 12), item("intro", "hold", 4), item("review", "hold", 1)],
      { samples: [], acks, now: NOW });
    expect(urgent.map((row) => row.key)).toEqual(["repo-gone"]);
    expect(hidden.map((row) => [row.key, row.ack?.actor])).toEqual([["intro", "local"]]);
    expect(backlog.map((row) => row.key)).toEqual(["review"]);
  });

  it("시간별 기록에는 숫자인 것만 남긴다", () => {
    expect(actionCounts([item("ai", "critical", "끊김"), item("review", "hold", 7)])).toEqual({ review: 7 });
  });
});

describe("조치 문구 — 코드 대신 사람이 읽는 이름", () => {
  const inputs = {
    settings: {},
    ops: { fetchedAt: NOW.toISOString(), observations: [], serviceInstances: [], dbLatencyMs: 1, audit: [], held: 0, heldNextRetryAt: null },
    jobStates: [{ name: "product-evidence-refresh", lastError: "boom", lastRunAt: null, lastSuccessAt: null, nextScheduledAt: null, notBefore: null }],
    evidenceSummary: { due: 39_749, stale: 0, failed: 0, oldestDueHours: 200 },
    downCount: 0,
    overview: humanOverview(),
    secondFailures: [],
    throughput: null, models: null, accounts: null, apps: null, takedowns: null, modelServers: null,
    roles: { roles: [{ role: "maintenance", reason: "standby_active", ownerKind: "standby", ownerRelease: null, epoch: 3 }], scheduler: { freshReplicas: 2, alarm: false } },
    attention: {
      auditRejectsOpen: 0, auditHeld: 0, healthOverdue: 90, healthTargetPerHour: 3_000, introNeedsEditor: 0, auditCampaign: null, cdnPurgesPending: 0,
      repoGone: { installable: 0, website: 0 }, spamAutoBans: { day: 0, banned: 0 },
      repoHealth: { tracked: 100, checked24h: 4, states: {} }, repoReview: { pending: 0, delistCandidates: 0, human: 0, kept: 0, oldestHours: null },
    },
  } as unknown as ActionInputs;
  const actions = buildActions(inputs, deriveStatus(inputs));
  const byKey = new Map(actions.map((row) => [row.key, row]));
  /** 보이는 글자 — 태그와 title 속성(툴팁)을 뺀다 */
  const text = (row: ActionItem) => renderToStaticMarkup(createElement(Fragment, null, row.detail)).replace(/<[^>]*>/g, "");

  it("작업·역할 코드는 툴팁에만 있고 글자는 JOB_LABELS·ROLE_LABELS 다", () => {
    for (const row of actions) {
      expect(text(row), row.key).not.toMatch(/product-evidence-refresh|uptime-ping|product-stars-refresh|connect-agent|\bmaintenance\b|\blease\b/);
    }
    expect(text(byKey.get("jobs")!)).toContain("제품 근거 갱신");
    expect(text(byKey.get("evidence-backlog")!)).toContain("제품 근거 갱신 처리량");
    expect(text(byKey.get("health-overdue")!)).toContain("서비스 응답 점검 처리량");
    expect(text(byKey.get("repo-coverage")!)).toContain("GitHub 저장소·스타 확인 작업이 밀리거나");
    expect(text(byKey.get("standby")!)).toContain("생존 확인·지표 집계");
    expect(renderToStaticMarkup(createElement(Fragment, null, byKey.get("jobs")!.detail))).toContain('title="product-evidence-refresh"');
  });

  it("감사 보류로 목록에서 빠진 것이 있으면 감사 탭의 보류 갈래로 보낸다 — 차단이 아니라고 적는다", () => {
    expect(byKey.has("audit-held")).toBe(false);
    const held = { ...inputs, attention: { ...inputs.attention!, auditHeld: 1_234 } } as ActionInputs;
    const row = buildActions(held, deriveStatus(held)).find((item) => item.key === "audit-held");
    expect(row).toMatchObject({ tone: "hold", count: 1_234, unit: "건", action: { href: "/admin/audit?tab=audit&view=held" } });
    expect(text(row!)).toContain("차단이 아닙니다");
  });

  it("숫자 칸마다 단위를 단다 — 퍼센트는 숫자와 %, 상태 글자는 '상태'", () => {
    expect(byKey.get("repo-coverage")).toMatchObject({ count: 4, unit: "%" });
    expect(byKey.get("evidence-backlog")).toMatchObject({ count: 39_749, unit: "건" });
    expect(byKey.get("ai")).toMatchObject({ tone: "critical", count: "끊김", unit: "상태" });
    for (const row of actions) expect(row.unit, row.key).toBeTruthy();
  });

  it("설정 적용이 늦은 워커는 settings-apply 판단 그대로 지금 조치에 올리고 설정 화면의 적용 확인으로 보낸다(ADM-19)", () => {
    expect(byKey.has("settings-apply")).toBe(false);
    const lagging = { ...inputs, settingsApply: { attention: { key: "settings-apply", tone: "hold", count: 2,
      title: "설정을 저장했는데 워커 2개가 아직 옛 판으로 돕니다", detail: "후보 심사 · 제품 발행", href: "/admin#apply" } } } as unknown as ActionInputs;
    const row = buildActions(lagging, deriveStatus(lagging)).find((item) => item.key === "settings-apply");
    expect(row).toMatchObject({ tone: "hold", count: 2, unit: "개", action: { href: "/admin#apply" } });
    expect(splitActions([row!], { samples: [], acks: new Map(), now: NOW }).urgent.map((item) => item.key)).toEqual(["settings-apply"]);
  });

  it("조회 실패와 역할별 예비·담당 문제를 같은 조치 목록에 올린다", () => {
    const unknown = { ...inputs, roles: null };
    expect(buildActions(unknown, deriveStatus(unknown))).toContainEqual(expect.objectContaining({ key: "roles-unknown", count: "미확인" }));
    for (const reason of ["primary_missing", "standby_missing", "lease_missing", "lease_expired", "owner_mismatch", "release_mismatch", "primary_quarantined"] as const) {
      const changed = { ...inputs, roles: { ...inputs.roles!, roles: [{ ...inputs.roles!.roles[0], role: "maintenance", reason }] } };
      const action = buildActions(changed, deriveStatus(changed)).find((row) => row.key === "role-maintenance");
      expect(action).toMatchObject({ tone: reason === "standby_missing" || reason === "release_mismatch" ? "hold" : "critical", action: { href: "/admin/status#roles" } });
    }
  });

  it("의도한 웹·워커 별도 릴리스와 일부 PAT 소진을 전체 장애로 표시하지 않는다", () => {
    const changed = { ...inputs, ops: { ...inputs.ops, serviceInstances: ["m3-web", "mini-web"].map((instanceId) => ({
      key: `service:app:${instanceId}`, role: "app", instanceId, observedAt: NOW.toISOString(), value: { release: "frontend-new" },
    })) }, accounts: [{ enabled: true, login: "first", quotaObservedAt: NOW, coreQuota: { remaining: 0, used: 5000, limit: 5000, reset: NOW.getTime() / 1000 + 3600 } },
      { enabled: true, login: "second", quotaObservedAt: NOW, coreQuota: { remaining: 4000, used: 1000, limit: 5000, reset: NOW.getTime() / 1000 + 3600 } }], apps: [] } as unknown as ActionInputs;
    const derived = deriveStatus(changed), actions = buildActions(changed, derived);
    expect(actions.some((row) => row.key === "release" || row.key === "web")).toBe(false);
    expect(actions.find((row) => row.key === "quota")).toMatchObject({ tone: "hold", count: 1 });
    const stale = { ...changed, accounts: changed.accounts!.map((row) => ({ ...row, quotaObservedAt: new Date(NOW.getTime() - 3_600_001) })) };
    expect(buildActions(stale, deriveStatus(stale)).some((row) => row.key === "quota")).toBe(false);
  });
});
