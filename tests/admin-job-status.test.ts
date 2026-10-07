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
    expect(jobStatusLabel({ ...empty, lockedAt: new Date(now - 90_000) }, now)).toBe("실행 중");
    expect(jobStatusLabel({ ...empty, lockedAt: new Date(now - 90_001) }, now)).toBe("중단·회수 대기");
    // 소개 검수처럼 not_before 를 먼 미래로 밀어 둔 것은 재시도가 아니라 멈춤이다
    expect(jobStatusLabel({ ...empty, notBefore: new Date("2100-01-01"), requestedVersion: 2, processedVersion: 1 }, now)).toBe("멈춤(사람이 중단)");
  });
});
