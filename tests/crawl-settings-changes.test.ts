import { describe, expect, it } from "vitest";
import { describeChanges } from "@/app/admin/settings/changes";
import { missingDefaults, searchUsage } from "@/app/admin/settings/model";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

/** 크롤 설정 저장 바 — 처음 그린 값과 지금 값을 견줘 사람이 읽는 문장으로 */
describe("저장 바의 바뀐 항목", () => {
  const before = { enabled: "on", pagesPerTick: "10", sort: "recent", blockedHomepageDomains: "github.com\nx.com", "query.0.label": "Claude", queryCount: "2" };

  it("값·스위치·정렬을 화면 순서대로 적는다", () => {
    expect(describeChanges(before, { ...before, pagesPerTick: "12", sort: "relevance" }))
      .toEqual(["정렬 최신 활동순 → 관련도", "틱당 페이지 10 → 12"]);
    // 꺼진 체크박스는 폼에서 값이 빠진다
    const off = Object.fromEntries(Object.entries(before).filter(([key]) => key !== "enabled"));
    expect(describeChanges(before, off)).toEqual(["수집 켬 → 끔"]);
  });

  it("목록은 더하고 뺀 수를, 신호는 늘어난 수를 적는다", () => {
    expect(describeChanges(before, { ...before, blockedHomepageDomains: "x.com\npypi.org\nnpmjs.com" })).toEqual(["차단 도메인 +2 −1"]);
    expect(describeChanges(before, { ...before, queryCount: "3", "query.1.label": "Codex" })).toEqual(["검색 신호 +1"]);
  });

  it("바뀐 것이 없으면 비어 있다", () => {
    expect(describeChanges(before, { ...before })).toEqual([]);
  });
});

describe("크롤 설정 계산", () => {
  it("틱당 페이지를 시간당 검색 수와 한도 대비로 바꾼다 — 수집은 10분마다", () => {
    expect(searchUsage(10)).toEqual({ perHour: 60, percent: "3.3%" });
    expect(searchUsage(2)).toEqual({ perHour: 12, percent: "0.7%" });
  });

  it("코드 기본값에 있는데 저장된 목록에 없는 것만 고른다", () => {
    const defaults = DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains;
    expect(missingDefaults("blockedHomepageDomains", defaults)).toEqual([]);
    expect(missingDefaults("blockedHomepageDomains", defaults.slice(1))).toEqual([defaults[0]]);
  });
});
