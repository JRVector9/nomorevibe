import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomePulse } from "@/components/home/HomePulse";
import { PulseStrip } from "@/components/home/PulseStrip";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import {
  BORN_CHANGE_MIN,
  completedWindows,
  emptyHomePulse,
  formatAsOfKst,
  kstMidnightUtc,
  type HomePulse as Pulse,
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

function samplePulse(): Pulse {
  return {
    ...emptyHomePulse(new Date("2026-09-12T10:00:00+09:00")),
    born: { current: 280, previous: 204, change: 37.3 },
    updates: { projects: 788, releases: 3045 },
    active: [
      { slug: "soleur", name: "Soleur", category: "Dev", releases: 40, stars: 15 },
      { slug: "big", name: "Big Tool", category: "Data", releases: 12, stars: 2400 },
    ],
    categories: [
      { key: "Dev", total: 1652, born: 67 },
      { key: "Other", total: 272, born: 22 },
      { key: "Games", total: 143, born: 0 },
    ],
    total: 2067,
  };
}

describe("윗줄", () => {
  const hrefFor = (metric: string) => `/?metric=${metric}`;

  it("태어난과 새 버전을 이름으로 가르고, 누르면 그 숫자의 기준을 연다", () => {
    const html = renderToStaticMarkup(createElement(PulseStrip, { pulse: samplePulse(), hrefFor }));

    expect(html).toContain("태어난 프로젝트");
    expect(html).toContain("↗37.3%");
    expect(html).toContain("새 버전을 낸 프로젝트");
    expect(html).toContain("릴리스 3,045건");
    expect(html).toContain('href="/?metric=born"');
    expect(html).toContain('href="/?metric=updates"');
  });

  it("관찰 사실 공개가 꺼져 있으면 제작 도구를 싣지 않는다", () => {
    const hidden = renderToStaticMarkup(createElement(PulseStrip, { pulse: samplePulse(), hrefFor }));
    expect(hidden).not.toContain("가장 많이 쓰인 제작 도구");

    const pulse = { ...samplePulse(), tools: { scanned: 2754, withTool: 1208, rows: [
      { label: "Claude Code", count: 1051 }, { label: "Cursor", count: 119 }, { label: "GitHub Copilot", count: 91 }, { label: "Codex", count: 81 },
    ] } };
    const shown = renderToStaticMarkup(createElement(PulseStrip, { pulse, hrefFor }));
    expect(shown).toContain("가장 많이 쓰인 제작 도구");
    expect(shown).toContain("1,051 · Cursor 119 · GitHub Copilot 91");
    expect(shown).not.toContain("Codex");
  });

  it("증감률을 계산할 수 없으면 0%를 채우지 않는다", () => {
    const pulse = { ...samplePulse(), born: { current: 3, previous: 2, change: null } };
    const html = renderToStaticMarkup(createElement(PulseStrip, { pulse, hrefFor }));
    expect(html).not.toContain("%");
  });
});

describe("리더보드", () => {
  it("활발한 프로젝트는 상세로 잇고, 별이 적으면 별 수를 달지 않는다", () => {
    const html = renderToStaticMarkup(createElement(HomePulse, { pulse: samplePulse(), state: { sort: "weekly" } }));

    expect(html).toContain('href="/p/soleur"');
    expect(html).toContain("40건");
    expect(html).toContain("★2,400");
    expect(html).not.toContain("★15");
  });

  it("분야 순위는 기타를 빼고, 이번 주 태어난 수를 곁에 단다", () => {
    const html = renderToStaticMarkup(createElement(HomePulse, { pulse: samplePulse(), state: { sort: "weekly" } }));

    expect(html).toContain("+67");
    expect(html).toContain("&quot;기타&quot; 272개 제외 · 공개 2,067개 기준");
    expect(html).toContain('href="/?sort=recent&amp;category=Dev"');
    expect(html).not.toContain('category=Other');
  });

  it("관찰 사실 공개가 꺼져 있으면 제작 도구 보드를 내지 않는다", () => {
    const html = renderToStaticMarkup(createElement(HomePulse, { pulse: samplePulse(), state: { sort: "weekly" } }));
    expect(html).not.toContain("제작 도구 집계 기준");
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
