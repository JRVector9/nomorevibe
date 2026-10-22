import { describe, expect, it } from "vitest";
import { JOB_HEALTH_FLOOR_MS, jobHealthIssues, jobHealthThresholds, jobsNeedingDeferralReason, readJobDegraded, type JobHealthInput,
  type JobHealthState } from "@/lib/operations/job-health";

/**
 * 작업이 정말 성공하고 있나(lib/operations/job-health.ts) — 돈 시각이 아니라 진짜 성공과 제 일 못 한 틱으로 잰다.
 * 기준은 잡 주기에서 나온다: 성공 끊김 보류 max(6주기, 30분)·긴급 그 4배, 제 일 못 함 보류 max(2, ⌈30분/주기⌉)번·긴급 그 4배.
 */
const NOW = new Date("2026-10-22T06:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LEGACY = { mode: "legacy", writerContractVersion: 0 };

const state = (name: string, patch: Partial<JobHealthState> = {}): JobHealthState =>
  ({ name, lastRunAt: ago(MIN), lastSuccessAt: ago(MIN), lastError: null, notBefore: null, runs: 100, ...patch });
const degraded = (name: string, streak: number, patch: Record<string, unknown> = {}) => ({ key: `job:${name}`, value: { done: true, events: [],
  degraded: { code: "search_failed", detail: "검색 http_503", critical: false, at: ago(MIN).toISOString(), streak, since: ago(streak * MIN).toISOString(), ...patch } } });
const issues = (patch: Partial<JobHealthInput>) => jobHealthIssues({ jobs: [], observations: [], deferrals: new Map(), batch: LEGACY, now: NOW, ...patch });

describe("기준 — 주기에서 나온다", () => {
  it.each([
    // [주기, 성공 끊김 보류, 긴급, 제 일 못 함 보류(번), 긴급(번)]
    [MIN, 30 * MIN, 120 * MIN, 30, 120],
    [5 * MIN, 30 * MIN, 120 * MIN, 6, 24],
    [15 * MIN, 90 * MIN, 360 * MIN, 2, 8],
    [30 * MIN, 180 * MIN, 720 * MIN, 2, 8],
    [120 * MIN, 720 * MIN, 2_880 * MIN, 2, 8],
    [240 * MIN, 1_440 * MIN, 5_760 * MIN, 2, 8],
  ])("주기 %ims → 끊김 %i/%i ms, 연속 %i/%i 번", (interval, staleHold, staleCritical, holdRuns, criticalRuns) => {
    expect(jobHealthThresholds(interval)).toEqual({ staleHoldMs: staleHold, staleCriticalMs: staleCritical, degradedHoldRuns: holdRuns, degradedCriticalRuns: criticalRuns });
  });
});

describe("제 일 못 한 틱이 이어진다", () => {
  it("HN 화제(30분): 한 번은 넘기고 두 번 잇달아면 보류, 여덟 번이면 긴급 — 까닭·연속·시작 시각을 싣는다", () => {
    const jobs = [state("hn-talk", { lastSuccessAt: ago(40 * MIN) })];
    expect(issues({ jobs, observations: [degraded("hn-talk", 1)] })).toEqual([]);
    expect(issues({ jobs, observations: [degraded("hn-talk", 2)] })).toEqual([expect.objectContaining({ job: "hn-talk", level: "hold", kind: "degraded",
      degraded: expect.objectContaining({ code: "search_failed", detail: "검색 http_503", streak: 2 }), sinceSuccessMs: 40 * MIN })]);
    expect(issues({ jobs, observations: [degraded("hn-talk", 8)] })).toEqual([expect.objectContaining({ level: "critical", kind: "degraded" })]);
  });

  it("1분 잡(알림 메일)은 30번(30분어치) 잇달아야 보류, 120번이면 긴급", () => {
    const jobs = [state("email-outbox-send", { lastSuccessAt: ago(10 * MIN) })];
    expect(issues({ jobs, observations: [degraded("email-outbox-send", 29)] })).toEqual([]);
    expect(issues({ jobs, observations: [degraded("email-outbox-send", 30)] })[0]).toMatchObject({ level: "hold" });
    expect(issues({ jobs, observations: [degraded("email-outbox-send", 120)] })[0]).toMatchObject({ level: "critical" });
  });

  it("처리기가 critical 로 돌려준 것은 한 번이면 긴급이다", () => {
    expect(issues({ jobs: [state("hn-talk")], observations: [degraded("hn-talk", 1, { critical: true })] })[0]).toMatchObject({ level: "critical" });
  });

  it("관측의 모양이 틀리면 버리고, lastDegraded 는 지난 것으로만 읽는다", () => {
    expect(readJobDegraded({ degraded: { code: "Bad!", at: NOW.toISOString() } })).toEqual({ current: null, last: null });
    expect(readJobDegraded({ degraded: { code: "no_key", at: "어제" } })).toEqual({ current: null, last: null });
    expect(readJobDegraded({ lastDegraded: { code: "no_key", at: NOW.toISOString(), streak: 3, since: NOW.toISOString() } }))
      .toEqual({ current: null, last: expect.objectContaining({ code: "no_key", streak: 3 }) });
    expect(readJobDegraded(null)).toEqual({ current: null, last: null });
  });
});

describe("진짜 성공이 끊겼다 — 까닭 모름(미룸·잠김 포함)", () => {
  it("1분 잡은 30분이면 보류, 2시간이면 긴급 — 마지막 미룸 까닭을 함께 싣는다", () => {
    const deferrals = new Map([["crawl-agent-review", { reason: "model_capacity", at: ago(MIN).toISOString() }]]);
    expect(issues({ jobs: [state("crawl-agent-review", { lastSuccessAt: ago(29 * MIN) })], deferrals })).toEqual([]);
    expect(issues({ jobs: [state("crawl-agent-review", { lastSuccessAt: ago(31 * MIN) })], deferrals })).toEqual([expect.objectContaining({
      job: "crawl-agent-review", level: "hold", kind: "stale", degraded: null, deferral: { reason: "model_capacity", at: ago(MIN).toISOString() } })]);
    expect(issues({ jobs: [state("crawl-agent-review", { lastSuccessAt: ago(121 * MIN) })], deferrals })[0]).toMatchObject({ level: "critical" });
  });

  it("한 시간 잡(AI 소식)은 6시간이면 보류 — 30분 바닥보다 주기가 길면 주기 6번", () => {
    expect(issues({ jobs: [state("news-refresh", { lastSuccessAt: ago(5 * 60 * MIN) })] })).toEqual([]);
    expect(issues({ jobs: [state("news-refresh", { lastSuccessAt: ago(6 * 60 * MIN) })] })[0]).toMatchObject({ level: "hold", kind: "stale" });
  });

  it("성공한 적이 없으면 돈 횟수로 잰다 — 주기 6번(짧은 잡은 30분어치)을 넘게 돌고도 한 번도 성공하지 못했다", () => {
    expect(issues({ jobs: [state("news-refresh", { lastSuccessAt: null, runs: 5 })] })).toEqual([]);
    expect(issues({ jobs: [state("news-refresh", { lastSuccessAt: null, runs: 6 })] })[0]).toMatchObject({ level: "hold", sinceSuccessMs: null });
    expect(issues({ jobs: [state("news-refresh", { lastSuccessAt: null, runs: 24 })] })[0]).toMatchObject({ level: "critical" });
  });

  it("일부러 미룬 잡(단계가 item 소비자로 넘어감·원본 버퍼·작업 배치)은 성공이 끊겨도 고장이 아니다 — 성공보다 앞선 미룸은 까닭이 아니다", () => {
    const old = ago(3 * 60 * MIN);
    for (const reason of ["stage_blocked", "source_buffer", "batch_blocked"]) {
      const deferrals = new Map([["crawl-fetch", { reason, at: ago(MIN).toISOString() }]]);
      expect(issues({ jobs: [state("crawl-fetch", { lastSuccessAt: old })], deferrals }), reason).toEqual([]);
    }
    const before = new Map([["crawl-fetch", { reason: "stage_blocked", at: ago(4 * 60 * MIN).toISOString() }]]);
    expect(issues({ jobs: [state("crawl-fetch", { lastSuccessAt: old })], deferrals: before })[0]).toMatchObject({ level: "critical", deferral: null });
  });

  it("미룸을 읽지 못했으면(null) 까닭 모를 끊김은 세우지 않는다 — 제 일 못 함은 그대로 세운다", () => {
    const jobs = [state("crawl-fetch", { lastSuccessAt: ago(5 * 60 * MIN) }), state("hn-talk", { lastSuccessAt: ago(5 * 60 * MIN) })];
    expect(issues({ jobs, deferrals: null, observations: [degraded("hn-talk", 2)] }).map((issue) => [issue.job, issue.kind]))
      .toEqual([["hn-talk", "degraded"]]);
  });
});

describe("보지 않는 것", () => {
  it("주기 없는 잡·지금 batch 에서 돌지 않는 잡·사람이 멈춘 잡·던진 실패·한 번도 돌지 않은 잡·워커가 끊긴 역할·스케줄러가 끊긴 때", () => {
    const old = ago(24 * 60 * MIN);
    const stale = (name: string, patch: Partial<JobHealthState> = {}) => state(name, { lastSuccessAt: old, ...patch });
    expect(issues({ jobs: [stale("ranking-refresh"), stale("heartbeat")] })).toEqual([]);
    expect(issues({ jobs: [stale("product-site-evidence-refresh")] })).toEqual([]);
    expect(issues({ jobs: [stale("product-site-evidence-refresh")], batch: { mode: "versioned", writerContractVersion: 1 } })).toHaveLength(1);
    expect(issues({ jobs: [stale("product-intro-check", { notBefore: new Date("2100-01-01T00:00:00.000Z") })] })).toEqual([]);
    expect(issues({ jobs: [stale("crawl-fetch", { lastError: "boom" })] })).toEqual([]);
    expect(issues({ jobs: [stale("crawl-fetch", { lastRunAt: null })] })).toEqual([]);
    expect(issues({ jobs: [stale("crawl-fetch")], silentRoles: new Set(["crawler"]) })).toEqual([]);
    expect(issues({ jobs: [stale("uptime-ping")], silentRoles: new Set(["crawler"]) })).toHaveLength(1);
    expect(issues({ jobs: [stale("uptime-ping")], silentRoles: new Set(["scheduler"]) })).toEqual([]);
    expect(issues({ jobs: [stale("not-in-catalog")] })).toEqual([]);
  });

  it("긴급이 먼저, 같은 급은 오래 끊긴 것부터", () => {
    const jobs = [state("news-refresh", { lastSuccessAt: ago(7 * 60 * MIN) }), state("crawl-fetch", { lastSuccessAt: ago(3 * 60 * MIN) }),
      state("cdn-purge", { lastSuccessAt: ago(40 * MIN) })];
    expect(issues({ jobs }).map((issue) => [issue.job, issue.level])).toEqual([["crawl-fetch", "critical"], ["news-refresh", "hold"], ["cdn-purge", "hold"]]);
  });
});

it("미룸 까닭은 30분 넘게 성공하지 못한 잡만 묻는다 — 평소에는 비어 있어 읽지 않는다", () => {
  expect(jobsNeedingDeferralReason([state("a"), state("b", { lastSuccessAt: ago(JOB_HEALTH_FLOOR_MS) }), state("c", { lastSuccessAt: null }),
    state("d", { lastSuccessAt: null, lastRunAt: null }), state("e", { lastSuccessAt: null, lastError: "boom" })], NOW)).toEqual(["b", "c"]);
});
