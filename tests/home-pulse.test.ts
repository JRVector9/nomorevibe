import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomePulse } from "@/components/home/HomePulse";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import {
  bucketDailyCounts,
  completedWindows,
  emptyHomePulse,
  formatAsOfKst,
  INTEREST_CHANGE_MIN,
  interestWindowReady,
  kstMidnightUtc,
  LAUNCH_CHANGE_MIN,
  TOOL_PERCENT_MIN,
} from "@/lib/domain/products/home-pulse";
import { CATEGORY_LABELS } from "@/lib/domain/products/labels";

describe("완료된 KST 집계 창", () => {
  it("오늘이 아니라 오늘 0시 이전까지만 넣는다", () => {
    const now = new Date("2026-09-08T01:30:00+09:00");
    const asOf = kstMidnightUtc(now);
    const windows = completedWindows(now);

    expect(asOf.toISOString()).toBe("2026-09-07T15:00:00.000Z");
    expect(windows.weekStart.toISOString()).toBe("2026-08-31T15:00:00.000Z");
    expect(windows.prevStart.toISOString()).toBe("2026-08-24T15:00:00.000Z");
    expect(windows.monthStart.toISOString()).toBe("2026-08-08T15:00:00.000Z");
    expect(formatAsOfKst(asOf)).toBe("09.08 00:00 KST 기준");
  });

  it("같은 KST 날짜면 시각과 무관하게 창이 같다", () => {
    const morning = completedWindows(new Date("2026-09-08T00:00:01+09:00"));
    const night = completedWindows(new Date("2026-09-08T23:59:59+09:00"));
    expect(morning.asOf.getTime()).toBe(night.asOf.getTime());
    expect(morning.weekStart.getTime()).toBe(night.weekStart.getTime());
  });
});

describe("표본 임계값", () => {
  it("출시 증감률은 직전 20개 미만이면 숨긴다", () => {
    expect(LAUNCH_CHANGE_MIN).toBe(20);
    expect(clickChangePercent(74, 62, LAUNCH_CHANGE_MIN)).toBe(19.4);
    expect(clickChangePercent(19, 19, LAUNCH_CHANGE_MIN)).toBeNull();
    expect(clickChangePercent(0, 0, LAUNCH_CHANGE_MIN)).toBeNull();
  });

  it("관심 증감률은 직전 제품별 고유 방문 100건 미만이면 숨긴다", () => {
    expect(INTEREST_CHANGE_MIN).toBe(100);
    expect(clickChangePercent(160, 125, INTEREST_CHANGE_MIN)).toBe(28);
    expect(clickChangePercent(99, 99, INTEREST_CHANGE_MIN)).toBeNull();
  });

  it("두 비교 기간을 모두 수집한 경우에만 관심 증감률을 준비한다", () => {
    const previousStart = new Date("2026-08-24T15:00:00.000Z");
    expect(interestWindowReady(new Date("2026-08-24T14:59:59.999Z"), previousStart)).toBe(true);
    expect(interestWindowReady(new Date("2026-08-24T15:00:00.000Z"), previousStart)).toBe(true);
    expect(interestWindowReady(new Date("2026-08-24T15:00:00.001Z"), previousStart)).toBe(false);
    expect(interestWindowReady(null, previousStart)).toBe(false);
  });

  it("도구 비율은 응답 20개부터 보여 준다", () => {
    expect(TOOL_PERCENT_MIN).toBe(20);
  });
});

describe("일별 출시 막대", () => {
  it("끝난 7일을 빈 날 0으로 채운다", () => {
    const weekStart = new Date("2026-08-31T15:00:00.000Z");
    const asOf = new Date("2026-09-07T15:00:00.000Z");
    const days = bucketDailyCounts(
      [new Date("2026-08-31T16:00:00.000Z"), new Date("2026-09-06T16:00:00.000Z")],
      weekStart,
    );

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.count)).toEqual([1, 0, 0, 0, 0, 0, 1]);
    expect(days.map((day) => day.weekday)).toEqual(["화", "수", "목", "금", "토", "일", "월"]);
    expect(asOf.toISOString()).toBe("2026-09-07T15:00:00.000Z");
  });
});

describe("초기 상태", () => {
  it("확인된 0과 계산 불가 비율을 구별한다", () => {
    const pulse = emptyHomePulse(new Date("2026-09-08T10:00:00+09:00"));
    expect(pulse.launches.current).toBe(0);
    expect(pulse.launches.previous).toBe(0);
    expect(pulse.launches.change).toBeNull();
    expect(pulse.launches.days).toHaveLength(7);
    expect(pulse.tools.reported).toBe(0);
    expect(pulse.tools.coverage).toBeNull();
    expect(pulse.interestReady).toBe(false);
    expect(pulse.categories).toEqual([]);
    expect(pulse.updates).toEqual({ projects: 0, releases: 0 });
    expect(pulse.total).toBe(0);
    expect(pulse.timezone).toBe("Asia/Seoul");
  });
});

describe("관심 지표 설명", () => {
  it("제품마다 중복을 제거한 방문을 분야별로 합산한다고 표시한다", () => {
    const pulse = emptyHomePulse(new Date("2026-09-08T10:00:00+09:00"));
    pulse.interestReady = true;
    pulse.categories = [{ key: "Dev", current: 125, previous: 100, change: 25, qualified: true }];

    const html = renderToStaticMarkup(createElement(HomePulse, {
      pulse,
      state: { sort: "weekly" },
    }));

    expect(html).toContain("제품별 고유 방문");
    expect(html).toContain("같은 방문자는 제품마다 기간별 1회 집계");
    expect(html).not.toContain("같은 방문자는 분야별 1회 집계");
  });

  it("수집 기간이 찼지만 상승 분야가 없으면 수집 중으로 표시하지 않는다", () => {
    const pulse = emptyHomePulse(new Date("2026-09-08T10:00:00+09:00"));
    pulse.interestReady = true;

    const html = renderToStaticMarkup(createElement(HomePulse, {
      pulse,
      state: { sort: "weekly" },
    }));

    expect(html).toContain("최근 7일에 관심이 커진 분야가 없습니다.");
    expect(html).not.toContain("관심 데이터를 모으고 있습니다.");
  });
});

describe("카테고리 표시 이름", () => {
  it("저장 키는 영문 그대로 두고 화면만 한국어로 바꾼다", () => {
    expect(CATEGORY_LABELS.Productivity).toBe("생산성");
    expect(CATEGORY_LABELS.Dev).toBe("개발 도구");
    expect(CATEGORY_LABELS.Design).toBe("디자인");
    expect(CATEGORY_LABELS.Finance).toBe("금융");
    expect(CATEGORY_LABELS.Other).toBe("기타");
    expect(CATEGORY_LABELS.Games).toBe("게임");
    expect(CATEGORY_LABELS.Sports).toBe("스포츠·피트니스");
  });
});
