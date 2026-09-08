import { describe, expect, it } from "vitest";
import { jobStatusLabel } from "@/lib/jobs/status";
describe("job observation labels", () => {
  it("distinguishes precreated, queued, running and retrying jobs", () => {
    const now = Date.now();
    const empty = { lastRunAt: null, lockedAt: null, notBefore: null, lastError: null, requestedVersion: 0, processedVersion: 0 };
    expect(jobStatusLabel(empty, now)).toBe("실행 기록 없음");
    expect(jobStatusLabel({ ...empty, requestedVersion: 1 }, now)).toBe("예약됨");
    expect(jobStatusLabel({ ...empty, lockedAt: new Date(now) }, now)).toBe("실행 중");
    expect(jobStatusLabel({ ...empty, notBefore: new Date(now + 1000) }, now)).toBe("재시도 대기");
    expect(jobStatusLabel({ ...empty, lockedAt: new Date(now - 600_001) }, now)).toBe("중단·회수 대기");
  });
});
