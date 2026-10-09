import { describe, expect, it } from "vitest";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import {
  BORN_CHANGE_MIN,
  completedWindows,
  emptyHomePulse,
  kstMidnightUtc,
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
  });

  it("같은 KST 날짜면 시각과 무관하게 창이 같다", () => {
    const morning = completedWindows(new Date("2026-09-08T00:00:01+09:00"));
    const night = completedWindows(new Date("2026-09-08T23:59:59+09:00"));
    expect(morning.asOf.getTime()).toBe(night.asOf.getTime());
    expect(morning.weekStart.getTime()).toBe(night.weekStart.getTime());
  });
});

describe("표본 임계값", () => {
  it("태어난 프로젝트 증감률은 직전 20개 미만이면 숨긴다", () => {
    expect(BORN_CHANGE_MIN).toBe(20);
    expect(clickChangePercent(74, 62, BORN_CHANGE_MIN)).toBe(19.4);
    expect(clickChangePercent(19, 19, BORN_CHANGE_MIN)).toBeNull();
    expect(clickChangePercent(0, 0, BORN_CHANGE_MIN)).toBeNull();
  });
});

describe("초기 상태", () => {
  it("확인된 0과 계산 불가 비율을 구별한다", () => {
    const pulse = emptyHomePulse(new Date("2026-09-08T10:00:00+09:00"));
    expect(pulse.born).toEqual({ current: 0, previous: 0, change: null });
    expect(pulse.updates).toEqual({ projects: 0, releases: 0 });
    expect(pulse.active).toEqual([]);
    expect(pulse.categories).toEqual([]);
    expect(pulse.tools).toBeNull();
    expect(pulse.total).toBe(0);
    expect(pulse.timezone).toBe("Asia/Seoul");
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
