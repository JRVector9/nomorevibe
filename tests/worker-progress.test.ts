import { expect, it } from "vitest";
import { classifyLiveness, classifyScheduler, classifyStage, EVIDENCE_STAGE_LABELS } from "@/lib/operations/worker-progress";

const now = new Date("2026-09-28T09:30:00.000Z");
const legacy = { mode: "legacy", writerContractVersion: 0 };
const stage = { key: "fetch" as const, enabled: true, waiting: 4, oldestMinutes: 8,
  completed5m: 0, progress5m: 0, errors5m: 0 };

it("requires eligible work and no stored progress before reporting a stall", () => {
  expect(classifyStage({ ...stage, waiting: 0 }, null, true, now).reason).toBe("no_work");
  expect(classifyStage({ ...stage, enabled: false }, null, true, now).reason).toBe("paused");
  expect(classifyStage({ ...stage, progress5m: 1 }, null, true, now).reason).toBe("progressing");
  expect(classifyStage(stage, { notBefore: new Date(now.getTime() + 60_000) }, true, now).reason).toBe("backoff");
  expect(classifyStage(stage, null, false, now).reason).toBe("worker_missing");
  expect(classifyStage(stage, null, true, now).reason).toBe("no_progress");
});

it("reports exhausted manual cases without treating the healthy worker as stalled", () => {
  expect(classifyStage({ ...stage, waiting: 0, manualAttention: 2 }, null, true, now)).toMatchObject({
    reason: "manual_attention", alarm: false, manualAttention: 2,
  });
});

it("keeps provider errors, missing queue ages, and the longer rule interval out of restart signals", () => {
  expect(classifyStage({ ...stage, errors5m: 2 }, null, true, now).reason).toBe("upstream_or_job_error");
  expect(classifyStage({ ...stage, key: "judge", oldestMinutes: 8 }, null, true, now).reason).toBe("warming_up");
  expect(classifyStage({ ...stage, oldestMinutes: null }, null, true, now).reason).toBe("unknown_age");
});

it('alerts on aged demand with persistent provider errors without making it restartable', () => {
  const error = classifyStage({ ...stage, oldestMinutes: 120, errors5m: 4 },
    { notBefore: new Date(now.getTime() + 60_000) }, true, now);
  expect(error).toMatchObject({ reason: 'upstream_stalled', alarm: true, restartEligible: false });
  expect(classifyStage({ ...stage, errors5m: 1 }, null, true, now))
    .toMatchObject({ reason: 'upstream_or_job_error', alarm: false, restartEligible: false });
  expect(classifyStage({ ...stage, enabled: false, oldestMinutes: 120, errors5m: 4 }, null, true, now))
    .toMatchObject({ reason: 'paused', alarm: false, restartEligible: false });
});

it('keeps a durable job failure out of restart decisions after the five-minute error window', () => {
  expect(classifyStage({ ...stage, oldestMinutes: 120 }, { notBefore: null, lastError: 'authentication_failed' }, true, now))
    .toMatchObject({ reason: 'upstream_stalled', alarm: true, restartEligible: false });
  expect(classifyStage(stage, { notBefore: null, lastError: 'upstream_unavailable' }, true, now))
    .toMatchObject({ reason: 'upstream_or_job_error', alarm: false, restartEligible: false });
  expect(classifyStage({ ...stage, oldestMinutes: 120, errors5m: 4 },
    { notBefore: new Date('2100-01-01'), lastError: 'authentication_failed' }, true, now))
    .toMatchObject({ reason: 'paused', alarm: false, restartEligible: false });
});

it.each(["authentication_failed", "rate_limited", "unknown"])("retains aged AI failures during policy backoff: %s", lastError => {
  const ai = { ...stage, key: "ai-level" as const, waiting: 0, oldestMinutes: null, deferred: 1,
    providerErrors: 1, providerErrorMinutes: 120 };
  expect(classifyStage(ai, { notBefore: new Date(now.getTime() + 60_000), lastError }, true, now))
    .toMatchObject({ reason: "upstream_stalled", alarm: true, restartEligible: false });
  expect(classifyStage({ ...ai, providerErrors: 0, providerErrorMinutes: null }, null, true, now))
    .toMatchObject({ reason: "backoff", alarm: false, restartEligible: false });
});

it.each([
  // 2026-10-17 운영 모양(수정 후 집계): 대기 0, 출처별 실패만 재시도 예정 → 정상 대기
  ["per-source backoff only", { waiting: 0, oldestMinutes: null, deferred: 594, providerErrors: 0, providerErrorMinutes: null }, null, "backoff", false],
  ["per-source failure just recorded", { waiting: 0, oldestMinutes: null, deferred: 594, errors5m: 2, providerErrors: 0, providerErrorMinutes: null }, null, "upstream_or_job_error", false],
  ["due work never attempted", { waiting: 6, oldestMinutes: 6158, deferred: 594, providerErrors: 0, providerErrorMinutes: null }, null, "no_progress", true],
  ["due work while recent attempts fail", { waiting: 6, oldestMinutes: 6158, deferred: 594, errors5m: 2, providerErrors: 0, providerErrorMinutes: null }, null, "upstream_stalled", true],
  ["account-wide limit in backoff", { waiting: 0, oldestMinutes: null, deferred: 594, providerErrors: 1, providerErrorMinutes: 120 }, null, "upstream_stalled", true],
  ["job failure with aged due work", { waiting: 6, oldestMinutes: 120, deferred: 0, providerErrors: 0, providerErrorMinutes: null }, "authentication_failed", "upstream_stalled", true],
] as const)("classifies evidence sources by provider-wide failures, not per-source backoff: %s", (_name, input, lastError, reason, alarm) => {
  const evidence = { ...stage, key: "evidence" as const, ...input };
  expect(classifyStage(evidence, lastError ? { notBefore: null, lastError } : null, true, now)).toMatchObject({ reason, alarm });
});

it("classifies eligible publisher work without restarting for held or newly approved candidates", () => {
  const publish = { ...stage, key: "publish" as const, oldestMinutes: 11 };
  expect(classifyStage(publish, null, true, now)).toMatchObject({
    role: "publisher", stage: "publish", reason: "no_progress", alarm: true,
  });
  expect(classifyStage({ ...publish, oldestMinutes: 8 }, null, true, now).reason).toBe("warming_up");
  expect(classifyStage({ ...publish, waiting: 0 }, null, true, now).reason).toBe("no_work");
  expect(classifyStage({ ...publish, completed5m: 1, progress5m: 1 }, null, true, now).reason).toBe("progressing");
});

it("uses overdue scheduled requests rather than zero new records to detect scheduler failure", () => {
  const overdue = { name: "crawl-fetch", nextScheduledAt: new Date(now.getTime() - 2 * 60_000 - 1_000), notBefore: null };
  expect(classifyScheduler([overdue], true, now, legacy).reason).toBe("scheduler_missed");
  expect(classifyScheduler([overdue], false, now, legacy).reason).toBe("scheduler_missed");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: new Date(now.getTime() + 60_000) }], true, now, legacy).reason)
    .toBe("scheduled");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: null }], true, now, legacy).reason).toBe("unknown_schedule");
  expect(classifyScheduler([{ name: "heartbeat", nextScheduledAt: null, notBefore: null }], true, now, legacy).reason)
    .toBe("unknown_schedule");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: new Date(now.getTime() + 60_000) }], false, now, legacy).reason)
    .toBe("worker_missing");
  expect(classifyScheduler([{ name: "product-intro-check", nextScheduledAt: overdue.nextScheduledAt,
    notBefore: new Date("2100-01-01T00:00:00Z") }], true, now, legacy).reason).toBe("unknown_schedule");
});

it("judges only the jobs the scheduler schedules in the current batch mode", () => {
  const fetch = { name: "crawl-fetch", nextScheduledAt: new Date(now.getTime() + 60_000), notBefore: null };
  // legacy 에서도 근거 새로 고침이 요청해 두는 versioned 전용 잡 행 — scheduler 는 일정을 만들지 않는다
  const site = { name: "product-site-evidence-refresh", nextScheduledAt: null, notBefore: null };
  const versioned = { mode: "versioned", writerContractVersion: 1 };
  expect(classifyScheduler([fetch, site], true, now, legacy).reason).toBe("scheduled");
  expect(classifyScheduler([fetch, site], true, now, { mode: "draining", writerContractVersion: 1 }).reason).toBe("scheduled");
  expect(classifyScheduler([fetch, site], true, now, { mode: "versioned", writerContractVersion: 0 }).reason).toBe("scheduled");
  // versioned 로 돌던 때의 지난 예약이 남아 있어도 legacy 로 돌아온 뒤에는 놓친 일정이 아니다
  const stale = { ...site, nextScheduledAt: new Date(now.getTime() - 10 * 60_000) };
  expect(classifyScheduler([fetch, stale], true, now, legacy)).toMatchObject({ reason: "scheduled", overdueJobs: [] });
  // versioned 에서는 같은 행이 판정 대상이다
  expect(classifyScheduler([fetch, site], true, now, versioned).reason).toBe("unknown_schedule");
  expect(classifyScheduler([fetch, stale], true, now, versioned))
    .toMatchObject({ reason: "scheduler_missed", overdueJobs: ["product-site-evidence-refresh"] });
});

it("reports a missing worker independently of an empty queue", () => {
  expect(classifyStage({ ...stage, waiting: 0 }, null, false, now).reason).toBe("no_work");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 46_000), now).reason).toBe("worker_missing");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 44_000), now).reason).toBe("present");
  expect(classifyLiveness("reviewer", null, now).reason).toBe("worker_missing");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 5_000), now, 3).reason).toBe("restart_loop");
});

it("names evidence stages in plain Korean with the code name alongside", () => {
  expect(Object.keys(EVIDENCE_STAGE_LABELS)).toEqual(["evidence", "agent-evidence", "ai-level"]);
  for (const [key, label] of Object.entries(EVIDENCE_STAGE_LABELS)) {
    expect(label).toMatch(/^[가-힣A-Z][가-힣A-Z ]*[가-힣]\(([a-z-]+)\)$/);
    expect(label.endsWith(`(${key})`)).toBe(true);
  }
});
