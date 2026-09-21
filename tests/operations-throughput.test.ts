import { expect, it } from "vitest";
import { throughputStatus } from "@/lib/operations/throughput-model";

const stage = { enabled: true, waiting: 12, oldestMinutes: 8, completed5m: 0 };
it("flags an aged queue with no completions, not a newly arrived queue", () => {
  expect(throughputStatus(stage)).toBe("stalled");
  expect(throughputStatus({ ...stage, oldestMinutes: 4.99 })).toBe("idle");
  expect(throughputStatus({ ...stage, oldestMinutes: null })).toBe("idle");
  expect(throughputStatus({ ...stage, waiting: 0 })).toBe("idle");
});
it("distinguishes a paused stage from a stuck worker even with historical completions", () => {
  expect(throughputStatus({ ...stage, enabled: false })).toBe("paused");
  expect(throughputStatus({ ...stage, enabled: false, completed5m: 10 })).toBe("paused");
});
it("flags backlog relative to that stage's own five-minute rate", () => {
  expect(throughputStatus({ ...stage, completed5m: 2 })).toBe("processing");
  expect(throughputStatus({ ...stage, completed5m: 2, waiting: 13 })).toBe("backlog");
  expect(throughputStatus({ ...stage, completed5m: 2, waiting: 100, oldestMinutes: 1 })).toBe("processing");
});
it("does not flag model inactivity as a stall when reused or rule outcomes advance the queue", () => {
  expect(throughputStatus({ ...stage, progress5m: 3 })).toBe("processing");
});
