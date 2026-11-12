import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { catalogIntervalMs, effectiveJobIntervalMs, intervalOverridable, intervalText, JOB_INTERVAL_MAX_MS, JOB_INTERVAL_MIN_MS, jobIntervalOverrides }
  from "@/lib/jobs/job-intervals";
import { readJobIntervalOverrides, resetJobIntervalOverridesForTest } from "@/lib/jobs/job-interval-reader";
import { DEFAULT_RUNTIME_SETTINGS, resolveRuntimeSettings, runtimeSettingLabel, storedSettingsVersion } from "@/lib/operations/runtime-settings-schema";
import { applyRuntimeSettingsPatch } from "@/lib/operations/runtime-settings";
import { jobHealthIssues } from "@/lib/operations/job-health";

vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: vi.fn(), servingContractSnapshot: () => ({ registry: null, rows: [], loadedAt: 0 }) }));

describe("잡 주기 덮어쓰기 — 기본 동작 불변", () => {
  it("덮어쓰기가 없으면 모든 잡의 주기는 카탈로그 그대로다", () => {
    for (const stored of [undefined, null, {}, { version: 1 }, { jobs: {} }, { jobs: { "second-review": { consumerConcurrency: 1 } } }]) {
      const overrides = jobIntervalOverrides(stored);
      expect(overrides.size).toBe(0);
      for (const job of JOB_CATALOG) expect(effectiveJobIntervalMs(job.name, overrides)).toBe(job.intervalMs);
    }
  });

  it("빈 운영 설정의 유효값·판은 예전과 같다(jobs 에 새 줄이 생기지 않는다)", () => {
    const { settings, issues } = resolveRuntimeSettings({ version: 1 });
    expect(issues).toEqual([]);
    expect(settings.jobs).toEqual(DEFAULT_RUNTIME_SETTINGS.jobs);
    expect(Object.values(settings.jobs).some(knobs => "intervalMs" in knobs)).toBe(false);
    expect(storedSettingsVersion({ version: 1 })).toBe("default");
  });

  it("주기가 없는 잡(요청으로만 도는 랭킹·heartbeat)·모르는 잡은 덮어쓸 수 없다", () => {
    expect(intervalOverridable("ranking-refresh")).toBe(false);
    expect(intervalOverridable("heartbeat")).toBe(false);
    expect(intervalOverridable("nope")).toBe(false);
    expect(intervalOverridable("crawl-judge")).toBe(true);
    expect(jobIntervalOverrides({ jobs: { "ranking-refresh": { intervalMs: 600_000 }, nope: { intervalMs: 600_000 } } }).size).toBe(0);
  });
});

describe("잡 주기 덮어쓰기 — 범위와 저장 검사", () => {
  it("1분~24시간만 받는다 — 바닥 밑·천장 위·소수·글자는 버리고 코드 기본값", () => {
    const stored = { jobs: { "crawl-judge": { intervalMs: 30_000 }, "crawl-fetch": { intervalMs: JOB_INTERVAL_MAX_MS + 1 }, "uptime-ping": { intervalMs: 90_000.5 },
      "hn-talk": { intervalMs: "600000" }, "cdn-purge": { intervalMs: JOB_INTERVAL_MIN_MS }, "bluesky-talk": { intervalMs: JOB_INTERVAL_MAX_MS } } };
    expect(Object.fromEntries(jobIntervalOverrides(stored))).toEqual({ "cdn-purge": 60_000, "bluesky-talk": JOB_INTERVAL_MAX_MS });
    expect(effectiveJobIntervalMs("crawl-judge", jobIntervalOverrides(stored))).toBe(catalogIntervalMs("crawl-judge"));
  });

  it("운영 설정 저장 검사: 기본값에 줄이 없는 잡에도 주기를 받고, 범위 밖은 거절한다", () => {
    const ok = resolveRuntimeSettings({ version: 1, jobs: { "crawl-judge": { intervalMs: 600_000 }, "reason-translate": { intervalMs: 120_000 } } });
    expect(ok.issues).toEqual([]);
    expect(ok.settings.jobs["crawl-judge"]).toEqual({ intervalMs: 600_000 });
    // 기존 손잡이 옆에 함께 적힌다
    expect(ok.settings.jobs["reason-translate"]).toEqual({ ...DEFAULT_RUNTIME_SETTINGS.jobs["reason-translate"], intervalMs: 120_000 });
    expect(resolveRuntimeSettings({ version: 1, jobs: { "crawl-judge": { intervalMs: 59_999 } } }).issues).toContain("runtime_settings_invalid:jobs.crawl-judge.intervalMs");
    expect(resolveRuntimeSettings({ version: 1, jobs: { "crawl-judge": { intervalMs: JOB_INTERVAL_MAX_MS + 60_000 } } }).issues)
      .toContain("runtime_settings_invalid:jobs.crawl-judge.intervalMs");
    expect(resolveRuntimeSettings({ version: 1, jobs: { "ranking-refresh": { intervalMs: 600_000 } } }).issues).toContain("unknown_job_knob:ranking-refresh.intervalMs");
    // 주기가 아닌 손잡이는 예전처럼 기본값에 있는 것만
    expect(resolveRuntimeSettings({ version: 1, jobs: { "crawl-judge": { batch: 4 } } }).issues).toContain("unknown_job_knob:crawl-judge.batch");
  });

  it("저장 패치는 jobs 그룹의 그 칸만 덮고(null 은 지움) 감사 이름은 「… 주기(ms)」다", () => {
    const first = applyRuntimeSettingsPatch({ version: 1, jobs: { "second-review": { consumerConcurrency: 1 } } }, "jobs", { jobs: { "crawl-judge": { intervalMs: 600_000 } } });
    expect(first.stored).toEqual({ version: 1, jobs: { "second-review": { consumerConcurrency: 1 }, "crawl-judge": { intervalMs: 600_000 } } });
    const reset = applyRuntimeSettingsPatch(first.stored, "jobs", { jobs: { "crawl-judge": { intervalMs: null } } });
    expect(reset.stored).toEqual({ version: 1, jobs: { "second-review": { consumerConcurrency: 1 } } });
    expect(runtimeSettingLabel("jobs.crawl-seed.intervalMs")).toBe("검색 수집 주기(ms)");
  });

  it("주기 글자", () => {
    expect([60_000, 30 * 60_000, 2 * 3_600_000, 90 * 60_000, 26 * 3_600_000, null].map(intervalText)).toEqual(["1분", "30분", "2시간", "1시간 30분", "1일 2시간", "—"]);
  });
});

describe("scheduler 의 덮어쓰기 읽기", () => {
  beforeEach(() => resetJobIntervalOverridesForTest());

  it("30초 동안 나눠 쓰고, 읽기가 실패하면 마지막 값(처음이면 코드 기본값)으로 돈다 — 실패는 5분 뒤에 다시 묻는다", async () => {
    const read = vi.fn().mockResolvedValueOnce({ jobs: { "crawl-judge": { intervalMs: 600_000 } } }).mockRejectedValue(new Error("permission denied"));
    expect(Object.fromEntries(await readJobIntervalOverrides({ now: 0, read }))).toEqual({ "crawl-judge": 600_000 });
    expect(Object.fromEntries(await readJobIntervalOverrides({ now: 29_000, read }))).toEqual({ "crawl-judge": 600_000 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(await readJobIntervalOverrides({ now: 31_000, read }))).toEqual({ "crawl-judge": 600_000 });
    expect(read).toHaveBeenCalledTimes(2);
    await readJobIntervalOverrides({ now: 31_000 + 4 * 60_000, read });
    expect(read).toHaveBeenCalledTimes(2);
    resetJobIntervalOverridesForTest();
    const failing = vi.fn().mockRejectedValue(new Error("permission denied"));
    expect((await readJobIntervalOverrides({ now: 0, read: failing })).size).toBe(0);
  });
});

describe("작업 경보는 덮어쓴 주기로 잰다", () => {
  const batch = { mode: "legacy", writerContractVersion: 0 };
  const now = new Date("2026-11-12T12:00:00Z");
  // crawl-judge 의 코드 주기는 5분 — 성공 끊김 보류는 max(6 × 5분, 30분) = 30분. 2시간으로 늘린 뒤 90분 성공이 없는 것은 고장이 아니다
  const jobs = [{ name: "crawl-judge", lastRunAt: new Date(now.getTime() - 60_000), lastSuccessAt: new Date(now.getTime() - 90 * 60_000), lastError: null, notBefore: null, runs: 10 }];
  it("덮어쓰기가 없으면 예전과 같이 울리고, 늘린 주기면 울리지 않는다", () => {
    const base = { jobs, observations: [], deferrals: new Map(), batch, now };
    expect(jobHealthIssues(base).map(issue => issue.job)).toEqual(["crawl-judge"]);
    expect(jobHealthIssues({ ...base, intervals: new Map([["crawl-judge", 2 * 3_600_000]]) })).toEqual([]);
  });
});
