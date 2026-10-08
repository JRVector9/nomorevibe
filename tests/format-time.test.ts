import { describe, expect, it } from "vitest";
import { formatAgo, formatDay, formatDetailTime, formatListTime, toDate } from "@/lib/format/time";

/** 관리자 시각 표기 — 늘 한국 시각, 오늘 여부도 한국 날짜로 가른다 */
describe("toDate", () => {
  it("시간대 없는 DB 글자는 UTC 벽시계로 읽는다", () => {
    expect(toDate("2026-10-08 04:38:13")?.toISOString()).toBe("2026-10-08T04:38:13.000Z");
    expect(toDate("2026-10-08T04:38:13.5")?.toISOString()).toBe("2026-10-08T04:38:13.500Z");
  });
  it("시간대가 있는 글자와 Date 는 그대로", () => {
    expect(toDate("2026-10-08T13:38:13+09:00")?.toISOString()).toBe("2026-10-08T04:38:13.000Z");
    const at = new Date("2026-10-08T04:38:13Z");
    expect(toDate(at)).toBe(at);
  });
  it("비었거나 읽을 수 없으면 null", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("어제")).toBeNull();
  });
});

describe("formatDetailTime", () => {
  it("초까지, KST 를 붙인다", () => {
    expect(formatDetailTime(new Date("2026-10-08T04:38:13Z"))).toBe("2026-10-08 13:38:13 KST");
    expect(formatDetailTime("2026-10-08 04:38:13")).toBe("2026-10-08 13:38:13 KST");
  });
  it("UTC 23:30 은 한국으로 다음 날 08:30", () => {
    expect(formatDetailTime("2026-10-07T23:30:00Z")).toBe("2026-10-08 08:30:00 KST");
  });
  it("자정은 00시로 쓴다", () => {
    expect(formatDetailTime("2026-10-07T15:00:00Z")).toBe("2026-10-08 00:00:00 KST");
  });
  it("비면 빈 표시, 바꿀 수 있다", () => {
    expect(formatDetailTime(null)).toBe("—");
    expect(formatDetailTime(null, "기록 없음")).toBe("기록 없음");
  });
});

describe("formatListTime", () => {
  const now = new Date("2026-10-08T04:41:20Z"); // 한국 10/8 13:41

  it("오늘이면 시각과 경과", () => {
    expect(formatListTime("2026-10-08T04:38:13Z", now)).toBe("13:38 (3분 전)");
  });
  it("UTC 로는 전날이어도 한국으로 오늘이면 오늘", () => {
    // UTC 10/7 23:30 = 한국 10/8 08:30
    expect(formatListTime("2026-10-07T23:30:00Z", now)).toBe("08:30 (5시간 전)");
  });
  it("UTC 로는 같은 날이어도 한국으로 어제면 날짜를 붙인다", () => {
    // 한국 10/8 00:01 에 본 10/7 23:59
    expect(formatListTime("2026-10-07T14:59:00Z", "2026-10-07T15:01:00Z")).toBe("10/7 23:59");
  });
  it("오늘이 아니면 월/일 시:분", () => {
    expect(formatListTime("2026-10-07T12:15:00Z", now)).toBe("10/7 21:15");
  });
  it("해가 다르면 해를 붙인다", () => {
    expect(formatListTime("2025-12-31T12:00:00Z", now)).toBe("2025/12/31 21:00");
  });
  it("오늘 안의 앞날은 '후'", () => {
    expect(formatListTime("2026-10-08T05:00:00Z", now)).toBe("14:00 (18분 후)");
  });
  it("비면 빈 표시", () => {
    expect(formatListTime(undefined, now)).toBe("—");
    expect(formatListTime(null, now, "없음")).toBe("없음");
  });
});

describe("formatAgo", () => {
  const now = "2026-10-08T04:00:00Z";
  it("단위를 내림한다", () => {
    expect(formatAgo("2026-10-08T03:59:30Z", now)).toBe("방금");
    expect(formatAgo("2026-10-08T03:56:01Z", now)).toBe("3분 전");
    expect(formatAgo("2026-10-08T01:30:00Z", now)).toBe("2시간 전");
    expect(formatAgo("2026-10-03T03:00:00Z", now)).toBe("5일 전");
    expect(formatAgo("2026-10-08T06:00:00Z", now)).toBe("2시간 후");
  });
});

describe("formatDay", () => {
  it("한국 날짜", () => {
    expect(formatDay("2026-10-07T23:30:00Z")).toBe("2026-10-08");
    expect(formatDay(null)).toBe("—");
  });
});
