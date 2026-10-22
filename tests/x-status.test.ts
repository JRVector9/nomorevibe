import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_KEYS } from "@/lib/operations/attention";
import { completedLiveRun, nextXStatusRuns, parseXStatusReport, parseXStatusRuns, readXStatus, X_STATUS_SECRET_ENV, type XStatusReport } from "@/lib/operations/x-status";
import { buildActions, deriveStatus, splitActions, type ActionInputs } from "@/app/(operator)/admin/status/attention";
import { xSummary } from "@/app/(operator)/admin/status/flow-model";
import { AttentionList, type ActionItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { humanOverview } from "./fixtures/human-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

/**
 * 운영센터 v8 PR9: x-status 읽기(DB 받은 시각·끊김 판정)와 조치 "X 보고 끊김/오류".
 * 받는 주소가 꺼져 있거나 마지막 보고가 꺼짐(disabled)이면 띄우지 않고, 쌓인 일(BACKLOG)이라 확인함·7일 숨김이 된다.
 */
const NOW = new Date("2026-10-18T04:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const SECRET = "x-status-current-secret-0123456789abcdef";
const report = (patch: Record<string, unknown> = {}) => ({ v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 3,
  lastRunAt: hoursAgo(4), lastSuccessAt: hoursAgo(4), error: null, sentAt: Math.floor(NOW.getTime() / 1000),
  signedWith: "current", ...patch });
const row = (value: unknown, receivedHoursAgo = 4) => ({ key: "x-status", value, observedAt: hoursAgo(receivedHoursAgo) });

afterEach(() => vi.unstubAllEnvs());

describe("x-status 읽기", () => {
  it("받는 주소가 꺼져 있으면 unconfigured — 남은 줄은 화면용으로만 읽는다", () => {
    expect(readXStatus([row(report())], NOW, false)).toMatchObject({ state: "unconfigured", report: { mode: "live" }, receivedAt: hoursAgo(4) });
    expect(readXStatus([], NOW, false)).toMatchObject({ state: "unconfigured", report: null, receivedAt: null, ageMs: null, stale: false });
  });

  it("주소는 켜졌고 보고가 아직 없으면 missing(연결 전)", () => {
    expect(readXStatus([{ key: "job:x", value: {}, observedAt: hoursAgo(1) }], NOW, true)).toMatchObject({ state: "missing", report: null });
  });

  it("나이는 DB 가 받은 시각(observed_at)으로 잰다 — 수집기가 적은 시각이 아니다", () => {
    const view = readXStatus([row(report({ lastRunAt: hoursAgo(40), lastSuccessAt: hoursAgo(40) }), 2)], NOW, true);
    expect(view).toMatchObject({ state: "ok", receivedAt: hoursAgo(2), ageMs: 2 * 3_600_000, stale: false });
  });

  it("26시간 넘게 새 보고가 없으면 stale, 오류 코드가 있으면 error — 끊김이 먼저다", () => {
    expect(readXStatus([row(report(), 26.5)], NOW, true)).toMatchObject({ state: "stale", stale: true });
    expect(readXStatus([row(report({ error: "http_error" }), 3)], NOW, true)).toMatchObject({ state: "error", stale: false, report: { error: "http_error" } });
    expect(readXStatus([row(report({ error: "http_error" }), 30)], NOW, true)).toMatchObject({ state: "stale" });
  });

  it("마지막 보고가 꺼짐(disabled)이면 오래됐거나 오류가 있어도 disabled", () => {
    expect(readXStatus([row(report({ mode: "disabled", error: "state_error" }), 300)], NOW, true)).toMatchObject({ state: "disabled", stale: true });
  });

  it("저장된 줄의 모양이 어긋나면 invalid", () => {
    for (const value of [{}, report({ signedWith: "other" }), report({ sentAt: "1" }), report({ note: "x" })]) {
      expect(readXStatus([row(value)], NOW, true).state, JSON.stringify(value)).toBe("invalid");
    }
  });

  it("주소가 켜졌는지는 받는 웹의 비밀값(32바이트 이상)으로 정한다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    expect(readXStatus([], NOW).state).toBe("missing");
    vi.stubEnv(X_STATUS_SECRET_ENV, "short");
    expect(readXStatus([], NOW).state).toBe("unconfigured");
  });
});

describe("하루 보고 v2 — 그날 검색어 출처(2026-10-21)", () => {
  const NOW_S = Math.floor(NOW.getTime() / 1000);
  const v1 = Object.fromEntries(Object.entries(report()).filter(([key]) => key !== "sentAt" && key !== "signedWith"));
  const v2 = (query: unknown) => ({ ...v1, v: 2, query });

  it("v1 은 그대로, v2 는 검색어 칸(출처·저장소 수·짧은 사유)을 더 받는다", () => {
    expect(parseXStatusReport(v1, NOW_S)).toEqual(v1);
    const products = v2({ source: "products", repositories: 12, reason: null });
    expect(parseXStatusReport(products, NOW_S)).toEqual(products);
    expect(parseXStatusReport(v2({ source: "default", repositories: 0, reason: "http_404" }), NOW_S)).toMatchObject({ v: 2, query: { reason: "http_404" } });
    expect(readXStatus([row({ ...products, sentAt: NOW_S, signedWith: "current" })], NOW, true)).toMatchObject({ state: "ok", report: { v: 2, query: { repositories: 12 } } });
  });

  it("검색어 칸이 없거나 어긋나면 거절한다 — 저장소 이름·검색어 글자는 받지 않는다", () => {
    for (const query of [undefined, null, { source: "products", repositories: 1 }, { source: "github", repositories: 1, reason: null },
      { source: "products", repositories: -1, reason: null }, { source: "default", repositories: 0, reason: "Timed out" },
      { source: "products", repositories: 1, reason: null, list: ["acme/tool"] }]) {
      expect(parseXStatusReport(v2(query), NOW_S), JSON.stringify(query)).toBeNull();
    }
    expect(parseXStatusReport({ ...v1, query: { source: "products", repositories: 1, reason: null } }, NOW_S)).toBeNull();
  });

  it("운영센터 X 칸은 v2 보고의 검색어 출처를 함께 적는다", () => {
    const view = (query: unknown) => readXStatus([row({ ...v2(query), sentAt: NOW_S, signedWith: "current" })], NOW, true);
    expect(xSummary(view({ source: "products", repositories: 12, reason: null })).note).toContain("검색 우리 저장소 12곳");
    expect(xSummary(view({ source: "default", repositories: 0, reason: "timeout" })).note).toContain("고정 검색어(timeout)");
    expect(xSummary(readXStatus([row(report())], NOW, true)).note).not.toContain("검색");
  });
});

describe("하루 보고 v3 — GitHub 주소·좋아요 하한 검색어(2026-10-22)", () => {
  const NOW_S = Math.floor(NOW.getTime() / 1000);
  const v1 = Object.fromEntries(Object.entries(report()).filter(([key]) => key !== "sentAt" && key !== "signedWith"));
  const v3 = (query: unknown) => ({ ...v1, v: 3, query });
  const popular = { source: "popular", minLikes: 50 };

  it("v3 는 검색어 칸(출처 popular·좋아요 하한)을 받는다 — v1·v2(옛 수집기·저장된 줄)도 그대로 받는다", () => {
    expect(parseXStatusReport(v3(popular), NOW_S)).toEqual(v3(popular));
    expect(parseXStatusReport(v3({ source: "popular", minLikes: 0 }), NOW_S)).toMatchObject({ v: 3, query: { minLikes: 0 } });
    expect(parseXStatusReport(v1, NOW_S)).toEqual(v1);
    const products = { ...v1, v: 2, query: { source: "products", repositories: 12, reason: null } };
    expect(parseXStatusReport(products, NOW_S)).toEqual(products);
    expect(readXStatus([row({ ...v3(popular), sentAt: NOW_S, signedWith: "current" })], NOW, true))
      .toMatchObject({ state: "ok", report: { v: 3, query: { source: "popular", minLikes: 50 } } });
  });

  it("판과 검색어 칸이 맞지 않으면 거절한다 — 검색어 글자는 받지 않는다", () => {
    for (const query of [undefined, null, { source: "popular" }, { source: "popular", minLikes: -1 }, { source: "popular", minLikes: 1.5 },
      { source: "popular", minLikes: "50" }, { source: "popular", minLikes: 1_000_001 }, { source: "products", minLikes: 50 },
      { source: "products", repositories: 12, reason: null }, { source: "popular", minLikes: 50, query: "url:github.com min_likes:50" }]) {
      expect(parseXStatusReport(v3(query), NOW_S), JSON.stringify(query)).toBeNull();
    }
    expect(parseXStatusReport({ ...v1, v: 2, query: popular }, NOW_S)).toBeNull();
    expect(parseXStatusReport({ ...v1, query: popular }, NOW_S)).toBeNull();
    expect(parseXStatusReport({ ...v1, v: 4, query: popular }, NOW_S)).toBeNull();
  });

  it("운영센터 X 칸은 v3 보고의 검색어를 적고, 옛 v2 줄도 예전처럼 적는다", () => {
    const view = (value: Record<string, unknown>) => readXStatus([row({ ...value, sentAt: NOW_S, signedWith: "current" })], NOW, true);
    expect(xSummary(view(v3(popular))).note).toContain("검색 GitHub 주소·좋아요 50 이상");
    expect(xSummary(view(v3({ source: "popular", minLikes: 1200 }))).note).toContain("좋아요 1,200 이상");
    expect(xSummary(view({ ...v1, v: 2, query: { source: "products", repositories: 3, reason: null } })).note).toContain("검색 우리 저장소 3곳");
    expect(xSummary(view(v1)).note).not.toContain("검색");
  });
});

describe("조치 — X 보고 끊김/오류", () => {
  const inputs = (observations: unknown[]) => ({
    settings: {},
    ops: { fetchedAt: NOW.toISOString(), observations, serviceInstances: [], dbLatencyMs: 1, audit: [], held: 0, heldNextRetryAt: null },
    jobStates: [], evidenceSummary: { due: 0, stale: 0, failed: 0, oldestDueHours: null }, downCount: 0, overview: humanOverview(), secondFailures: [],
    throughput: null, models: null, accounts: null, apps: null, takedowns: null, modelServers: null, roles: null, attention: null,
  }) as unknown as ActionInputs;
  const actions = (observations: unknown[]) => { const value = inputs(observations); return buildActions(value, deriveStatus(value)); };
  const xAction = (observations: unknown[]) => actions(observations).find((item) => item.key === "x-status");
  const text = (item: ActionItem) => renderToStaticMarkup(createElement(Fragment, null, item.detail)).replace(/<[^>]*>/g, "");

  it("주소가 꺼져 있으면 보고가 끊겼든 오류든 띄우지 않고, 다른 조치는 그대로다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, "");
    const stale = [row(report({ error: "http_error" }), 50)];
    const before = actions([]);
    expect(xAction(stale)).toBeUndefined();
    expect(actions(stale)).toEqual(before);
  });

  it("주소가 켜져 있어도 연결 전(보고 없음)·정상·꺼짐 보고는 띄우지 않는다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    const before = actions([]).map((item) => item.key);
    // 정상 보고는 같은 실행의 게시물 보고(x-posts)도 받은 상태다 — 받지 못했으면 전달 어긋남(x-delivery)이 선다(아래)
    const delivered = { key: "x-posts", value: { v: 1, observedAt: hoursAgo(4), posts: 3, unavailable: 0 }, observedAt: hoursAgo(4) };
    for (const observations of [[], [row(report()), delivered], [row(report({ mode: "disabled", error: "state_error" }), 300)]]) {
      expect(xAction(observations), JSON.stringify(observations)).toBeUndefined();
      expect(actions(observations).map((item) => item.key)).toEqual(before);
    }
  });

  it("끊김: 마지막 보고(DB 받은 시각)부터 지난 시간을 숫자로, hold 로 크롤러 활동에 보낸다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    const item = xAction([row(report({ mode: "dry-run" }), 30.5)])!;
    expect(item).toMatchObject({ key: "x-status", tone: "hold", count: 30, unit: "시간", title: "X 수집 보고가 끊겼습니다",
      action: { label: "크롤러 활동", href: "/admin/status?tab=crawlers" } });
    expect(text(item)).toContain("시험 실행(dry-run)");
    expect(text(item)).toContain("26시간");
  });

  it("오류: 오류 코드와 마지막 성공을 적고, 숫자는 마지막 성공부터 지난 시간이다(성공이 없으면 받은 시각부터)", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    const item = xAction([row(report({ error: "http_error", lastRunAt: hoursAgo(3), lastSuccessAt: hoursAgo(51) }), 3)])!;
    expect(item).toMatchObject({ key: "x-status", tone: "hold", count: 51, unit: "시간", title: "X 수집기가 오류를 보고했습니다" });
    expect(text(item)).toContain("http_error");
    expect(text(item)).toContain("실제 수집(live)");
    expect(xAction([row(report({ error: "use_case_not_approved", lastSuccessAt: null }), 7)])).toMatchObject({ count: 7 });
  });

  it("저장된 보고를 읽지 못하면 받은 시각부터 지난 시간으로 띄운다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    expect(xAction([row({ broken: true }, 5)])).toMatchObject({ key: "x-status", tone: "hold", count: 5, unit: "시간", title: "X 수집 보고를 읽지 못했습니다" });
  });

  it("쌓인 일(BACKLOG)이라 기준 시각에 있던 것은 쌓인 일로 가고, 확인함으로 7일 숨길 수 있다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    expect(BACKLOG_KEYS.has("x-status")).toBe(true);
    const item = xAction([row(report(), 30)])!;
    const samples = [{ at: hoursAgo(24), counts: { "x-status": 6 } }];
    // 수는 지난 시간이라 가만히 있어도 24시간에 24가 는다 — 24시간 변화("↑ 24h +24")로 그리지 않는다
    expect(item.elapsed).toBe(true);
    const split = splitActions([item], { samples, acks: new Map(), now: NOW });
    expect(split.backlog.map((entry) => [entry.key, entry.trend])).toEqual([["x-status", null]]);
    const out = renderToStaticMarkup(createElement(AttentionList, { urgent: [], backlog: split.backlog, hidden: [], now: NOW.toISOString() }));
    expect(out).toContain("마지막 정상 뒤 지난 시간");
    expect(out).not.toContain("↑ 24h");
    const ack = { key: "x-status", actor: "local", at: new Date(hoursAgo(1)), until: new Date(hoursAgo(-167)) };
    expect(splitActions([item], { samples, acks: new Map([["x-status", ack]]), now: NOW }).hidden.map((split) => split.key)).toEqual(["x-status"]);
  });
});

/**
 * 무음 실패 점검(2026-10-22) — 하루 보고는 후보 수만 싣고 게시물 전달 결과는 osaka 의 status.json 에만 있었다.
 * 웹이 받은 게시물 보고(x-posts)의 수집 시각과 끝난 실제 수집을 견주고(전달 어긋남), 끝난 실제 수집의 후보 수를 날마다 이어 센다(이틀째 0).
 */
describe("끝난 실제 수집 기록(x-status:runs)", () => {
  const base = { v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 0, lastRunAt: hoursAgo(1), lastSuccessAt: hoursAgo(1), error: null } as XStatusReport;
  it("live·오류 없음·이번 실행이 곧 마지막 성공일 때만 끝난 실제 수집이다 — 같은 날 두 번째(daily_limit)·시험 실행·막힘은 아니다", () => {
    expect(completedLiveRun(base)).toBe(true);
    expect(completedLiveRun({ ...base, lastSuccessAt: hoursAgo(25) })).toBe(false);
    expect(completedLiveRun({ ...base, mode: "dry-run" })).toBe(false);
    expect(completedLiveRun({ ...base, error: "http_error" })).toBe(false);
  });

  it("후보 0 이면 이어 세고 첫 실행 시각을 남긴다 — 후보가 나오면 끊고, 이미 센 실행·끝나지 않은 실행은 그대로 둔다", () => {
    const day1 = nextXStatusRuns(null, { ...base, lastRunAt: hoursAgo(49), lastSuccessAt: hoursAgo(49) })!;
    expect(day1).toEqual({ zeroRuns: 1, zeroSince: hoursAgo(49), lastCompletedRunAt: hoursAgo(49), lastCandidates: 0 });
    const day2 = nextXStatusRuns(day1, { ...base, lastRunAt: hoursAgo(25), lastSuccessAt: hoursAgo(25) })!;
    expect(day2).toMatchObject({ zeroRuns: 2, zeroSince: hoursAgo(49) });
    expect(nextXStatusRuns(day2, { ...base, lastRunAt: hoursAgo(25), lastSuccessAt: hoursAgo(25) })).toBeNull();
    expect(nextXStatusRuns(day2, { ...base, lastSuccessAt: hoursAgo(25) })).toBeNull();
    expect(nextXStatusRuns(day2, { ...base, candidates: 4 })).toEqual({ zeroRuns: 0, zeroSince: null, lastCompletedRunAt: hoursAgo(1), lastCandidates: 4 });
    expect(parseXStatusRuns(day2)).toEqual(day2);
    expect(parseXStatusRuns({ ...day2, zeroRuns: -1 })).toBeNull();
    expect(parseXStatusRuns(null)).toBeNull();
  });
});

describe("조치 — X 전달 어긋남·이틀째 후보 0·사흘 넘은 끊김", () => {
  const inputs = (observations: unknown[]) => ({
    settings: {},
    ops: { fetchedAt: NOW.toISOString(), observations, serviceInstances: [], dbLatencyMs: 1, audit: [], held: 0, heldNextRetryAt: null },
    jobStates: [], evidenceSummary: { due: 0, stale: 0, failed: 0, oldestDueHours: null }, downCount: 0, overview: humanOverview(), secondFailures: [],
    throughput: null, models: null, accounts: null, apps: null, takedowns: null, modelServers: null, roles: null, attention: null,
  }) as unknown as ActionInputs;
  const find = (observations: unknown[], key: string) => { const value = inputs(observations); return buildActions(value, deriveStatus(value)).find((item) => item.key === key); };
  const text = (item: ActionItem | undefined) => renderToStaticMarkup(createElement(Fragment, null, item?.detail)).replace(/<[^>]*>/g, "");
  const posts = (runHoursAgo: number) => ({ key: "x-posts", value: { v: 1, sentAt: 1, signedWith: "current", observedAt: hoursAgo(runHoursAgo), posts: 3, unavailable: 0 },
    observedAt: hoursAgo(runHoursAgo) });
  const runs = (zeroRuns: number) => ({ key: "x-status:runs", value: { zeroRuns, zeroSince: hoursAgo(50), lastCompletedRunAt: hoursAgo(4), lastCandidates: 0 }, observedAt: hoursAgo(4) });

  it("끝난 실제 수집이 후보를 냈는데 같은 실행의 게시물 보고를 받지 못했으면 보류, 사흘(세 번) 넘게 어긋나면 긴급", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    expect(find([row(report()), posts(4)], "x-delivery")).toBeUndefined();
    const missing = find([row(report())], "x-delivery")!;
    expect(missing).toMatchObject({ tone: "hold", count: 3, unit: "건", title: "X 수집 결과가 웹에 들어오지 않았습니다", action: { href: "/admin/status?tab=crawlers" } });
    expect(text(missing)).toContain("마지막으로 받은 게시물 보고 없음");
    expect(text(missing)).toContain("X_POSTS_REPORT_URL");
    expect(find([row(report()), posts(28)], "x-delivery")).toMatchObject({ tone: "hold" });
    expect(find([row(report()), posts(80)], "x-delivery")).toMatchObject({ tone: "critical" });
    // 후보가 없거나 끝나지 않은 실행(시험 실행·같은 날 두 번째)은 게시물을 보내지 않을 수 있다
    for (const patch of [{ candidates: 0 }, { mode: "dry-run" }, { lastSuccessAt: hoursAgo(28) }]) expect(find([row(report(patch))], "x-delivery"), JSON.stringify(patch)).toBeUndefined();
    vi.stubEnv(X_STATUS_SECRET_ENV, "");
    expect(find([row(report())], "x-delivery")).toBeUndefined();
  });

  it("끝난 실제 수집이 이틀 잇달아 후보 0 이면 보류(숨길 수 있는 쌓인 일), 8일이면 긴급 — 시험 실행이면 세우지 않는다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    const zero = report({ candidates: 0 });
    expect(find([row(zero), runs(1)], "x-candidates")).toBeUndefined();
    const item = find([row(zero), runs(2)], "x-candidates")!;
    expect(item).toMatchObject({ tone: "hold", count: 2, unit: "일", title: "X 수집이 이틀 넘게 후보를 내지 못했습니다" });
    expect(text(item)).toContain("끝난 실제 수집 2번이 잇달아 후보 0건");
    expect(BACKLOG_KEYS.has("x-candidates")).toBe(true);
    expect(find([row(zero), runs(8)], "x-candidates")).toMatchObject({ tone: "critical" });
    expect(find([row(report({ mode: "dry-run", candidates: 0 })), runs(5)], "x-candidates")).toBeUndefined();
  });

  it("끊김·오류가 사흘(72시간)을 넘으면 긴급 — 확인함으로 숨겨도 긴급은 지금 조치에 선다", () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
    expect(find([row(report({ mode: "dry-run" }), 71)], "x-status")).toMatchObject({ tone: "hold", count: 71 });
    const stale = find([row(report({ mode: "dry-run" }), 72)], "x-status")!;
    expect(stale).toMatchObject({ tone: "critical", count: 72 });
    expect(find([row(report({ error: "http_error", lastRunAt: hoursAgo(3), lastSuccessAt: hoursAgo(80) }), 3)], "x-status")).toMatchObject({ tone: "critical", count: 80 });
    const ack = { key: "x-status", actor: "local", at: new Date(hoursAgo(1)), until: new Date(hoursAgo(-167)) };
    expect(splitActions([stale], { samples: [], acks: new Map([["x-status", ack]]), now: NOW }).urgent.map((item) => item.key)).toEqual(["x-status"]);
  });
});
