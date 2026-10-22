import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_KEYS } from "@/lib/operations/attention";
import { parseXStatusReport, readXStatus, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";
import { buildActions, deriveStatus, splitActions, type ActionInputs } from "@/app/(operator)/admin/status/attention";
import { xSummary } from "@/app/(operator)/admin/status/flow-model";
import type { ActionItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
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
    for (const observations of [[], [row(report())], [row(report({ mode: "disabled", error: "state_error" }), 300)]]) {
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
    expect(splitActions([item], { samples, acks: new Map(), now: NOW }).backlog.map((split) => [split.key, split.trend]))
      .toEqual([["x-status", { delta: 24, hours: 24 }]]);
    const ack = { key: "x-status", actor: "local", at: new Date(hoursAgo(1)), until: new Date(hoursAgo(-167)) };
    expect(splitActions([item], { samples, acks: new Map([["x-status", ack]]), now: NOW }).hidden.map((split) => split.key)).toEqual(["x-status"]);
  });
});
