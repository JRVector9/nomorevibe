import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlowBoard } from "@/app/(operator)/admin/flow/FlowBoard";
import { TodoPanel, todoRows } from "@/app/(operator)/admin/flow/OperatorDesk";
import { refreshPolicy } from "@/app/(operator)/admin/live-refresh";
import { buildConveyor, holdHref, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { stationResponse } from "@/lib/operations/flow-response";
import { awaySince, deskChange, deskDevices, deskRole, type OperatorDesk } from "@/lib/operations/operator-desk-model";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import type { HourlySeries } from "@/lib/operations/dashboard";
import { emptySearchHealth } from "@/lib/operations/search-health-model";
import type { ThroughputStage } from "@/lib/operations/throughput-model";

const NOW = "2026-11-02T21:00:00.000Z";

function stage(key: ThroughputStage["key"], patch: Partial<ThroughputStage> = {}): ThroughputStage {
  return { key, label: key, unit: key === "second" ? "표" : "건", completed1m: 1, completed5m: 5, progress5m: 5, waiting: 3,
    manualAttention: 0, oldestMinutes: 2, enabled: true, errors5m: 0, queueNote: "", detail: "", status: "processing", ...patch };
}

function hourly(patch: Partial<HourlySeries["points"][number]> = {}): HourlySeries {
  const points = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(Date.parse("2026-11-01T22:00:00.000Z") + index * 3_600_000).toISOString(),
    discovered: 40, judged: 30, firstReviews: 20, firstFailed: 0, secondReviews: 10, secondAgreed: 8, published: 5, publishedKorean: 1, keywords: 6, taglines: 7, ...patch,
  }));
  const last = { ...points.at(-1)!, hour: undefined };
  return { measuredAt: NOW, points, lastHour: last };
}

function human(patch: Partial<HumanQueueOverview> = {}): HumanQueueOverview {
  return { held: 120, ids: { ai: [], second: [], agreed: [], human: [] }, stages: { ai: 10, second: 60, agreed: 20, human: 30 },
    agreed: { reject: 15, approve: 5 }, person: 50, secondIds: {} as HumanQueueOverview["secondIds"], second: {} as HumanQueueOverview["second"],
    secondPublished: 0, wait: { oldestDays: 3, stalled: 0, in24h: 12 }, decided24h: { approve: 4, reject: 6 },
    aiDecisions: { counts: {} as HumanQueueOverview["aiDecisions"]["counts"], ids: new Map() }, ...patch };
}

function inputs(patch: Partial<ConveyorInputs> = {}): ConveyorInputs {
  return {
    now: NOW, enabled: true,
    throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second"), stage("publish")] },
    flow: { stages: [
      { key: "discover", label: "발견 누적", waiting: 90_000, entered: 900, left: null, job: "crawl-seed" },
      { key: "fetch", label: "원본 수집 대기", waiting: 3, entered: 900, left: 880, job: "crawl-fetch" },
    ], bottleneck: null, published: 12_345 },
    hourly: hourly(), human: human(),
    progress: { stages: [], liveness: [] },
    search: { ...emptySearchHealth(), total: 100, pendingGeneration: 4, pendingVerification: 2, oldestVerificationMinutes: 12, generatedRecent: 3, verifiedRecent: 2 },
    holds: [{ reason: "ambiguous", count: 40, recent24h: 2 }, { reason: "no_description", count: 8, recent24h: 1 }],
    rejected: 50_000,
    classification: { held: 0, nextRetryAt: null },
    sources: [{ job: "crawl-seed", label: "GitHub 검색", lastSuccessAt: "2026-11-02T20:50:00.000Z", paused: false, failing: false }],
    ...patch,
  };
}

describe("conveyor model", () => {
  it("lays out the five phases as eight stations and flows when every stage processes", () => {
    const conveyor = buildConveyor(inputs());
    expect(conveyor.stations.map((station) => station.key)).toEqual(["discover", "fetch", "judge", "first", "second", "profile", "publish", "keywords"]);
    expect(conveyor.stations.map((station) => station.phase)).toEqual(["explore", "explore", "review", "review", "review", "profile", "publish", "keywords"]);
    expect(conveyor.stations.find((station) => station.key === "first")).toMatchObject({ tone: "flow", doneHour: 20, done24h: 480, waiting: 3 });
    expect(conveyor.stations[0]).toMatchObject({ key: "discover", waiting: null, doneHour: 40, done24h: 900 });
    expect(conveyor.held).toBe(48);
    expect(conveyor.hours).toHaveLength(24);
    expect(conveyor.funnel.find((row) => row.key === "human")?.value).toBe(10);
  });

  it("uses the operations-center rail rules: stalled or worker alarm → jam, backlog → slow, paused → stop", () => {
    const conveyor = buildConveyor(inputs({
      throughput: { measuredAt: NOW, stages: [stage("fetch", { status: "backlog" }), stage("judge", { status: "stalled", waiting: 40, oldestMinutes: 95, completed5m: 0 }),
        stage("first", { status: "paused" }), stage("second"), stage("publish")] },
      progress: { stages: [], liveness: [{ role: "publisher", reason: "worker_missing", alarm: true }] },
    }));
    const tone = (key: string) => conveyor.stations.find((station) => station.key === key)!;
    expect(tone("fetch")).toMatchObject({ tone: "slow", status: "쌓임" });
    expect(tone("judge").tone).toBe("jam");
    expect(tone("judge").reason).toContain("40건이 최장 1시간 기다리는데");
    expect(tone("first")).toMatchObject({ tone: "stop", status: "일시 중지" });
    expect(tone("publish")).toMatchObject({ tone: "jam", status: "워커 끊김" });
    // 막힘 둘 중 앞 칸(규칙 심사)이 먼저 — 뒤 칸(발행)의 워커 끊김보다
    expect(conveyor.bottleneck).toBe("judge");
    expect(conveyor.headline.title).toBe("지금 가장 막힌 곳: 규칙 심사 — 막힘");
  });

  it("raises AI 2차 when first approvals fall into split holds while no second votes are cast (2026-11-02)", () => {
    const conveyor = buildConveyor(inputs({
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second", { waiting: 0, completed5m: 0, progress5m: 0, status: "idle" }), stage("publish")] },
      hourly: hourly({ secondReviews: 0, secondAgreed: 0 }),
      holds: [{ reason: "second_review_split", count: 3_701, recent24h: 1_724 }, { reason: "ambiguous", count: 40, recent24h: 0 }],
    }));
    const second = conveyor.stations.find((station) => station.key === "second")!;
    expect(second).toMatchObject({ tone: "jam", status: "표 0 · 보류로 빠짐" });
    expect(second.reason).toContain("24시간 +1,724");
    expect(second.holds[0]).toMatchObject({ reason: "second_review_split", count: 3_701, href: "/admin/review?cause=second_review_split#review-list" });
    expect(conveyor.bottleneck).toBe("second");
    expect(conveyor.headline.tone).toBe("jam");
    expect(conveyor.holdsByReason[0]).toMatchObject({ label: "2차 갈림", station: "second" });
  });

  it("puts a fresh upstream stop ahead of an older, bigger jam downstream (11-02 21:13Z: 1차 0건 while 2차 had 3,701 holds)", () => {
    const conveyor = buildConveyor(inputs({
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first", { status: "stalled", waiting: 260, oldestMinutes: 18, completed5m: 0 }),
        stage("second", { waiting: 0, completed5m: 0, progress5m: 0, status: "idle" }), stage("publish")] },
      hourly: hourly({ secondReviews: 0, secondAgreed: 0 }),
      holds: [{ reason: "second_review_split", count: 3_701, recent24h: 1_724 }],
    }));
    expect(conveyor.stations.find((station) => station.key === "second")!.tone).toBe("jam");
    expect(conveyor.bottleneck).toBe("first");
    expect(conveyor.headline.title).toBe("지금 가장 막힌 곳: AI 1차 — 막힘");
  });

  it("stops keyword registration when generation has been idle for 30 minutes with work waiting", () => {
    const conveyor = buildConveyor(inputs({ search: { ...emptySearchHealth(), pendingGeneration: 120, generationIdleMinutes: 45 } }));
    expect(conveyor.stations.at(-1)).toMatchObject({ key: "keywords", tone: "jam", waiting: 120 });
  });

  it("keeps rendering with every read missing — unknown, never a false 'flowing'", () => {
    const conveyor = buildConveyor(inputs({ throughput: null, flow: null, hourly: null, human: null, progress: null, search: null, holds: null,
      rejected: null, classification: null, sources: [] }));
    expect(conveyor.stations.filter((station) => station.key !== "discover").every((station) => station.tone === "unknown")).toBe(true);
    expect(conveyor.human).toBeNull();
    expect(conveyor.headline.tone).toBe("unknown");
    expect(renderToStaticMarkup(<FlowBoard data={conveyor} />)).not.toMatch(/NaN|undefined/);
  });

  it("draws the profile line from taglines written per hour, labelled as such (2026-11-02 「프로필 준비 선 없음」)", () => {
    const profile = buildConveyor(inputs()).stations.find((station) => station.key === "profile")!;
    expect(profile.spark).toHaveLength(24);
    expect(profile).toMatchObject({ rateLabel: "소개 지음", doneHour: 7, done24h: 7 * 24 });
    expect(profile.facts[0].value).toContain("분류는 발행 때 함께");
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor(inputs())} />);
    expect(html).toContain("선: 소개 지음");
    expect(html).toContain("프로필 준비(소개 지음) 24시간 시간별");
  });

  it("puts each throughput figure on its own line so narrow cards wrap instead of clipping (2026-11-02 「24시간 6,99…」)", () => {
    const conveyor = buildConveyor(inputs({ hourly: hourly({ firstReviews: 291 }) }));
    const html = renderToStaticMarkup(<FlowBoard data={conveyor} />);
    expect(html).toContain('<span class="cv-rate"><span>1시간 <b>291</b></span><span>24시간 <b>6,984</b>건</span></span>');
    const css = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/flow/flow.css"), "utf8");
    expect(css).not.toMatch(/\.cv-rate>span\{white-space:nowrap\}/);
    expect(css).toContain(".cv-rate{display:flex;flex-direction:column");
  });

  it("folds the belt into two rows on a narrow board instead of scrolling it sideways (2026-11-02 1024px)", () => {
    const css = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/flow/flow.css"), "utf8");
    expect(css).not.toMatch(/min-width:1180px/);
    expect(css).not.toMatch(/\.cv-scroll\{[^}]*overflow-x:auto/);
    expect(css).toContain("@container cv-board (max-width:1099px){.cv-board{grid-template-columns:repeat(5,minmax(0,1fr))");
    // 5칸으로 접으면 둘째 줄이 프로필 준비부터 — 단계 이름이 줄마다 맞는다
    const conveyor = buildConveyor(inputs());
    expect(conveyor.stations.slice(0, 5).map((station) => station.phase)).toEqual(["explore", "explore", "review", "review", "review"]);
    expect(conveyor.stations[5].phase).toBe("profile");
  });

  it("links a hold only to review causes the queue can filter", () => {
    expect(holdHref("no_description")).toBe("/admin/review?cause=no_description#review-list");
    expect(holdHref("ambiguous")).toBeNull();
  });
});

describe("flow board", () => {
  it("draws stations on belts, the hold lane into human review, and opens the bottleneck's detail", () => {
    const conveyor = buildConveyor(inputs({
      holds: [{ reason: "second_review_split", count: 3_701, recent24h: 1_724 }],
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second", { waiting: 0, completed5m: 0, status: "idle" }), stage("publish")] },
      hourly: hourly({ secondReviews: 0 }),
    }));
    const html = renderToStaticMarkup(<FlowBoard data={conveyor} />);
    for (const label of ["탐색", "검수", "프로필 등록", "발행", "키워드 등록", "원본 수집", "규칙 심사", "AI 1차", "AI 2차", "프로필 준비", "사람 심사", "공개"]) {
      expect(html, label).toContain(label);
    }
    expect(html.match(/class="cv-belt"/g)).toHaveLength(8);
    expect(html).toContain('data-tone="jam" data-items="dense" data-moving="no"');
    expect(html).toMatch(/data-moving="yes" style="--cv-speed:[0-9.]+s"/);
    expect(html).toContain('aria-pressed="true" aria-label="AI 2차');
    expect(html).toContain('id="cv-detail-title"><small>검수</small>AI 2차');
    expect(html).toContain("3,701");
    expect(html).toContain('href="/admin/models/tasks"');
    expect(html).toContain("<summary>통과 수·보류 사유·표로 보기</summary>");
    // 장애 대응은 자세히 옆에 같이 열린다 — 2차는 모델 순위 화면으로, 보류 묶음 재개는 화면 조치 없음으로 정직하게
    expect(html).toContain('id="rs-title">장애 대응</h3>');
    expect(html).toContain("2차 모델을 1차와 다른 모델로");
    expect(html).toContain("이미 보류된 3,701건을 2차로 다시 보내기");
    expect(html).toContain("화면 조치 없음");
    // 색만으로 말하지 않는다 — 상태 알약마다 글자가 있다
    expect(html).toMatch(/class="cv-badge" data-tone="jam"><span aria-hidden="true">■<\/span>표 0 · 보류로 빠짐<\/span>/);
  });

  it("is a read-only admin page with a stamp, login guard and its own refresh cadence", () => {
    const page = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/flow/page.tsx"), "utf8");
    expect(page).toContain("<PageStamp />");
    expect(page).toContain('redirect("/admin/login")');
    expect(page).toMatch(/<h1[^>]*>전체 흐름<\/h1>/);
    expect(page).not.toMatch(/use server|action=/);
    expect(refreshPolicy("/admin/flow")).toEqual({ intervalMs: 15_000, idleMs: 0 });
  });
});

const DESK_NOW = "2026-11-02T21:40:00.000Z";
function desk(patch: Partial<OperatorDesk> = {}): OperatorDesk {
  return {
    measuredAt: DESK_NOW,
    alerts: { critical: 1, hold: 2, items: [{ key: "dispatch", tone: "critical", title: "모델 장부 dispatch_stuck", count: "5건", href: "/admin/models#review", actionLabel: "장부 보기" }] },
    decisions: { remaining: 3_846, failed: 0, done: 120,
      items: [{ key: "human", title: "직접 판단", hint: "", count: 3_846, tone: "warn", href: "/admin/review", action: "심사 큐에서 판단", oldestAt: "2026-11-01T12:00:00.000Z" }],
      sections: [{ key: "human", title: "직접 판단", hint: "AI가 결론을 내지 못한 후보 — 직접 승인하거나 거부합니다.", href: "/admin/review", action: "심사 큐에서 판단", tone: "warn",
        count: 3_846, note: null, rows: [{ id: "c1", name: "agent-sessions", why: "규칙으로 못 가름", since: "2026-11-01T12:00:00.000Z" }] },
        { key: "agreed", title: "확정만 하면 됨", hint: "두 모델이 같은 결론을 낸 후보", href: "/admin/review?stage=agreed", action: "심사 큐에서 확정", tone: "warn", count: null, note: null, rows: [] }],
      clear: [{ key: "feedback", title: "보류된 피드백", href: "/admin/feedback?state=held" }] },
    changes: [deskChange({ id: 23292, createdAt: "2026-11-02T21:13:40.000Z", actor: "jr", action: "ai-task-models-save", target: "first-review", ok: true }, (action) => action)],
    equipment: { observedAt: DESK_NOW, devices: deskDevices([{ groupId: "supa-direct", held: 4, limit: 4, lending: false }, { groupId: "gpu3090-qwen", held: 1, limit: 2, lending: false }],
      [...Array.from({ length: 4 }, () => ({ groupId: "supa-direct", state: "dispatched", dispatchedAt: "2026-11-02T18:00:00.000Z" })),
        { groupId: "gpu3090-qwen", state: "dispatched", dispatchedAt: "2026-11-02T18:00:00.000Z" }], DESK_NOW, 1800, (id) => id),
      ledger: { status: "alarm", reasons: ["dispatch_stuck"], stuckDispatched: 5, reviewCount: 0, oldestAgeSeconds: null, stuckThresholdSeconds: 1800 }, servers: [] },
    window: { admission: "open", admissionSince: "2026-11-02T14:00:00.000Z", roles: [deskRole({ role: "reviewer", reason: "standby_active", host: "mini" })], schedulerAlarm: false },
    away: { since: "2026-11-02T12:00:00.000Z", fromMyLastAction: true, published: 0, newHolds: 614, othersChanges: [], myLogin: "jr" },
    ...patch,
  };
}

describe("operator desk", () => {
  it("counts stuck dispatched calls on the device that holds them (11-02: supa-direct 4 · gpu3090 1)", () => {
    const devices = desk().equipment!.devices;
    expect(devices.map((device) => [device.id, device.stuck])).toEqual([["supa-direct", 4], ["gpu3090-qwen", 1]]);
    // 문턱 안의 전송은 세지 않는다
    expect(deskDevices([{ groupId: "a", held: 1, limit: 1, lending: false }], [{ groupId: "a", state: "dispatched", dispatchedAt: "2026-11-02T21:30:00.000Z" }], DESK_NOW, 1800, (id) => id)[0].stuck).toBe(0);
  });

  it("names where to undo each setting change, and says so when it cannot be undone", () => {
    expect(deskChange({ id: 1, createdAt: DESK_NOW, actor: "jr", action: "ai-task-models-save", target: "first-review", ok: true }, (a) => a).undo)
      .toEqual({ text: "「작업 ↔ AI 모델」 최근 기록에서 이전 순위를 보고 다시 저장", href: "/admin/models/tasks" });
    expect(deskChange({ id: 2, createdAt: DESK_NOW, actor: "jr", action: "job-pause", target: "crawl-publish", ok: true }, (a) => a).undo.href).toBe("/admin/status?tab=jobs&job=crawl-publish");
    expect(deskChange({ id: 3, createdAt: DESK_NOW, actor: "jr", action: "model-capacity-unknown-reviewed", target: "x", ok: true }, (a) => a).undo.href).toBeNull();
    expect(deskChange({ id: 4, createdAt: DESK_NOW, actor: "jr", action: "something-else", target: "a/b", ok: true }, (a) => a).undo.href).toBe("/admin/activity?target=a%2Fb");
  });

  it("starts 'away' at my last logged action, at least an hour back and at most 72 hours", () => {
    expect(awaySince(DESK_NOW, "2026-11-02T12:00:00.000Z")).toEqual({ since: "2026-11-02T12:00:00.000Z", fromMyLastAction: true });
    expect(awaySince(DESK_NOW, "2026-11-02T21:30:00.000Z").since).toBe("2026-11-02T20:40:00.000Z");
    expect(awaySince(DESK_NOW, null)).toEqual({ since: "2026-10-30T21:40:00.000Z", fromMyLastAction: false });
  });

  it("treats a standby holding the lease as an alarm — standbys never hand it back", () => {
    expect(deskRole({ role: "reviewer", reason: "standby_active", host: "mini" })).toMatchObject({ ok: false, text: "예비가 일함" });
    expect(deskRole({ role: "crawler", reason: "ready", host: "M3" }).ok).toBe(true);
  });

  it("renders 할 일 (alerts · human decisions · away line) plus the three status panels, and never shows an unread panel as zero", () => {
    const conveyor = buildConveyor(inputs());
    const html = renderToStaticMarkup(<FlowBoard data={conveyor} desk={desk()} />);
    // 2026-11-03 3차: 받은함·결정함·부재 중 세 칸 → 「할 일」 한 칸(경보 · 사람 판단 · 자리 비운 사이)
    // 4차: 경보와 사람 판단은 한 표의 「구분」 열이다
    for (const title of ['id="dk-todo-title">할 일</h2>', '<td class="dk-kind">경보</td>', '<td class="dk-kind">사람 판단</td>', "자리 비운 사이", "최근 바뀐 설정", "장비·모델 서버", "배포·점검 창"]) expect(html, title).toContain(title);
    expect(html).not.toContain("받은함 · 경보");
    expect(html).toContain('<span class="dk-count" data-tone="bad">긴급 1 · 사람 판단 3,846건</span>');
    expect(html).toContain("멈춘 전송 4");
    expect(html).toContain("예비가 일함");
    expect(html).toContain("OPEN · 접수 중");
    const unread = renderToStaticMarkup(<FlowBoard data={conveyor} desk={desk({ alerts: null, equipment: null, window: null })} />);
    expect(unread).toContain("경보을(를) 읽지 못했습니다 — 0건이 아닙니다");
    // 못 읽은 경보는 표 안에서 그 줄 하나로 — 다른 줄(사람 판단)은 그대로 보인다
    expect(unread).toMatch(/<tr data-tone="mute"><td>경보<\/td><td>—<\/td><td colSpan="4"><p class="dk-unread"/);
    expect(unread).toContain('<td class="dk-kind">사람 판단</td>');
    expect(unread).toContain("장부 미확인");
    expect(unread).not.toMatch(/NaN|undefined/);
  });

  it("replaces the 오늘 할 일 screen with the 모두 보기 drawer — every section, its oldest rows, unread as 불러오지 못함, and the empty ones", () => {
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor(inputs())} desk={desk()} />);
    expect(html).toContain('id="todo"');
    expect(html).toMatch(/<details class="dk-all" id="todo-all"><summary>모두 보기 <small>남은 일 3,846건 · 최근 24시간 처리 120건<\/small><\/summary>/);
    // 4차: 서랍의 상세 줄은 열이 맞는 표 한 개 — 제품·항목 | 사유 | 기다린 시간
    expect(html).toContain('<tr class="dk-all-row"><td class="dk-all-name">agent-sessions</td><td>규칙으로 못 가름</td><td class="dk-r dk-age">33시간 전</td></tr>');
    expect(html).toContain('<span class="dk-all-n">불러오지 못함</span>');
    expect(html).toMatch(/할 일 없음 — <span><a href="\/admin\/feedback\?state=held">보류된 피드백<\/a><\/span>/);
    // 4차 화면만 — 오늘 할 일 화면을 전체 흐름으로 보내는 3차 화면 합치기는 이 범위가 아니다
    const inbox = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/inbox/page.tsx"), "utf8");
    expect(inbox).not.toContain('redirect("/admin/flow#todo")');
  });
});

describe("할 일 표 (2026-11-04 4차: 「할 일은 표로」)", () => {
  const many = () => desk({
    alerts: { critical: 1, hold: 2, items: [
      { key: "split", tone: "hold", title: "2차 갈림 보류가 24시간 +1,724", count: "3,701건", href: "/admin/review", actionLabel: "보류 보기" },
      { key: "dispatch", tone: "critical", title: "모델 장부 dispatch_stuck", count: "5건", href: "/admin/models#review", actionLabel: "장부 보기" }] },
    decisions: { ...desk().decisions!, items: [
      { key: "human", title: "직접 판단", hint: "", count: 1_075, tone: "warn", href: "/admin/review", action: "심사 큐에서 판단", oldestAt: "2026-10-27T21:40:00.000Z" },
      { key: "takedown", title: "내려달라는 요청", hint: "", count: 2, tone: "critical", href: "/admin/takedowns", action: "요청 처리", oldestAt: "2026-11-01T19:40:00.000Z" }] } });

  it("puts alerts and human decisions in one table, sorted by severity (긴급 first, then 경보 before 사람 판단, then original order)", () => {
    expect(todoRows(many()).map((row) => [row.kind, row.severity, row.title])).toEqual([
      ["alert", 0, "모델 장부 dispatch_stuck"], ["decision", 0, "내려달라는 요청"],
      ["alert", 1, "2차 갈림 보류가 24시간 +1,724"], ["decision", 1, "직접 판단"]]);
    expect(todoRows(many()).map((row) => row.age)).toEqual(["—", "가장 오래 26시간", "—", "가장 오래 6일"]);
  });

  it("fixes the columns — 구분 | 심각도 | 항목 | 건수 | 가장 오래됨/변화 | 바로 가기 — with the number columns right-aligned", () => {
    const html = renderToStaticMarkup(<TodoPanel desk={many()} />);
    expect(html).toContain('<table class="dk-table dk-todo-table"><colgroup><col class="dk-c-kind"/><col class="dk-c-sev"/><col/><col class="dk-c-num"/><col class="dk-c-age"/><col class="dk-c-go"/></colgroup>');
    expect(html).toContain('<thead><tr><th scope="col">구분</th><th scope="col">심각도</th><th scope="col">항목</th><th scope="col" class="dk-r">건수</th><th scope="col" class="dk-r">가장 오래됨/변화</th><th scope="col">바로 가기</th></tr></thead>');
    const rows = [...html.matchAll(/<tr data-tone="(bad|warn)" data-kind="(alert|decision)">(.*?)<\/tr>/g)];
    expect(rows).toHaveLength(4);
    for (const [, , , cells] of rows) {
      expect(cells.match(/<t[dh][ >]/g)).toHaveLength(6);
      expect(cells).toMatch(/<td class="dk-r dk-n">[^<]+<\/td><td class="dk-r dk-age">[^<]+<\/td>/);
    }
    // 자리 비운 사이는 표 위 요약 한 줄
    expect(html.indexOf('class="dk-away"')).toBeLessThan(html.indexOf('class="dk-table dk-todo-table"'));
    // 줄이 넘치면 표 아래 한 줄로 어디서 다 보는지 적는다
    const crowded = desk({ alerts: { critical: 0, hold: 6, items: Array.from({ length: 6 }, (_, index) => ({ key: `a${index}`, tone: "hold" as const, title: `경보 ${index}`, count: "1건", href: null, actionLabel: null })) } });
    expect(renderToStaticMarkup(<TodoPanel desk={crowded} />)).toContain("경보 외 2건 — ");
  });

  it("says so in one row when there is nothing to do", () => {
    const html = renderToStaticMarkup(<TodoPanel desk={desk({ alerts: { critical: 0, hold: 0, items: [] }, decisions: { ...desk().decisions!, items: [], remaining: 0 } })} />);
    expect(html).toContain('<td colSpan="6" class="dk-empty">지금 조치할 경보도, 사람이 판단할 일도 없습니다.</td>');
  });

  it("draws the 모두 보기 drawer as one table so names, reasons and times line up across sections", () => {
    const html = renderToStaticMarkup(<TodoPanel desk={desk()} />);
    expect(html.match(/<table class="dk-table dk-all-table">/g)).toHaveLength(1);
    expect(html).toContain('<thead><tr><th scope="col">제품·항목</th><th scope="col">사유</th><th scope="col" class="dk-r">기다린 시간</th></tr></thead>');
    expect(html.match(/<tbody class="dk-all-sec"/g)).toHaveLength(desk().decisions!.sections.length);
  });
});

describe("incident response (2026-11-02 incidents)", () => {
  it("first review at zero → check the cleared rank and who changed it, link to the rank screen, offer the job pause with undo", () => {
    const conveyor = buildConveyor(inputs({ throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"),
      stage("first", { status: "stalled", waiting: 260, oldestMinutes: 48, completed5m: 0 }), stage("second"), stage("publish")] } }));
    const response = stationResponse("first", conveyor, desk());
    expect(response.checks[1]).toContain("1차 AI 검수 1순위가 비어 있지 않은지");
    expect(response.steps).toContainEqual(expect.objectContaining({ kind: "link", href: "/admin/models/tasks", risk: "careful" }));
    expect(response.steps).toContainEqual(expect.objectContaining({ kind: "link", href: "/admin/activity?group=settings" }));
    expect(response.steps).toContainEqual(expect.objectContaining({ kind: "job", job: "crawl-agent-review" }));
    // 장부 경보(dispatch_stuck)도 막힌 모델 칸의 점검에 든다 — 소유자 없는 행 정리는 화면 조치가 없다고 적는다
    expect(response.checks.join(" ")).toContain("supa-direct 4칸 · gpu3090-qwen 1칸");
    expect(response.steps).toContainEqual(expect.objectContaining({ kind: "manual", where: expect.stringContaining("model-owner-gone.ts") }));
    // 역할 lease 이상(재부팅 뒤 예비가 쥠)이 맨 앞 점검이다
    expect(response.checks[0]).toContain("reviewer 예비가 일함(mini)");
  });

  it("never invents a write path — every step is an existing job control, a link, or an honest 'no screen action'", () => {
    const conveyor = buildConveyor(inputs());
    for (const key of ["discover", "fetch", "judge", "first", "second", "profile", "publish", "keywords", "human"] as const) {
      for (const step of stationResponse(key, conveyor, desk()).steps) {
        if (step.kind === "link") expect(step.href.startsWith("/admin"), `${key} ${step.label}`).toBe(true);
        if (step.kind === "manual") expect(step.where, `${key} ${step.label}`).toMatch(/화면 조치 없음/);
        if (step.kind === "job") expect(step.undo).toContain("재개");
      }
    }
  });
});
