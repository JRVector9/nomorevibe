import { expect, it } from "vitest";
import { classifyLiveness, classifyScheduler, classifyStage } from "@/lib/operations/worker-progress";

const now = new Date("2026-09-28T09:30:00.000Z");
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

it("keeps provider errors, missing queue ages, and the longer rule interval out of restart signals", () => {
  expect(classifyStage({ ...stage, errors5m: 2 }, null, true, now).reason).toBe("upstream_or_job_error");
  expect(classifyStage({ ...stage, key: "judge", oldestMinutes: 8 }, null, true, now).reason).toBe("warming_up");
  expect(classifyStage({ ...stage, oldestMinutes: null }, null, true, now).reason).toBe("unknown_age");
});

it("uses overdue scheduled requests rather than zero new records to detect scheduler failure", () => {
  const overdue = { name: "crawl-fetch", nextScheduledAt: new Date(now.getTime() - 2 * 60_000 - 1_000), notBefore: null };
  expect(classifyScheduler([overdue], true, now).reason).toBe("scheduler_missed");
  expect(classifyScheduler([overdue], false, now).reason).toBe("scheduler_missed");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: new Date(now.getTime() + 60_000) }], true, now).reason)
    .toBe("scheduled");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: null }], true, now).reason).toBe("unknown_schedule");
  expect(classifyScheduler([{ name: "heartbeat", nextScheduledAt: null, notBefore: null }], true, now).reason)
    .toBe("unknown_schedule");
  expect(classifyScheduler([{ ...overdue, nextScheduledAt: new Date(now.getTime() + 60_000) }], false, now).reason)
    .toBe("worker_missing");
  expect(classifyScheduler([{ name: "product-intro-check", nextScheduledAt: overdue.nextScheduledAt,
    notBefore: new Date("2100-01-01T00:00:00Z") }], true, now).reason).toBe("unknown_schedule");
});

it("reports a missing worker independently of an empty queue", () => {
  expect(classifyStage({ ...stage, waiting: 0 }, null, false, now).reason).toBe("no_work");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 46_000), now).reason).toBe("worker_missing");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 44_000), now).reason).toBe("present");
  expect(classifyLiveness("reviewer", null, now).reason).toBe("worker_missing");
  expect(classifyLiveness("crawler", new Date(now.getTime() - 5_000), now, 3).reason).toBe("restart_loop");
});
