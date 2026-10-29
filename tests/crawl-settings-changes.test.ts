import { describe, expect, it } from "vitest";
import { describeChanges } from "@/app/(operator)/admin/settings/changes";
import { missingDefaults, searchUsage } from "@/app/(operator)/admin/settings/model";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

/** 크롤 설정 저장 바 — 처음 그린 값과 지금 값을 견줘 사람이 읽는 문장으로 */
describe("저장 바의 바뀐 항목", () => {
  const before = { excludeForks: "on", pagesPerTick: "10", sort: "recent", blockedHomepageDomains: "github.com\nx.com", "query.0.label": "Claude", queryCount: "2" };

  it("값·스위치·정렬을 화면 순서대로 적는다", () => {
    expect(describeChanges(before, { ...before, pagesPerTick: "12", sort: "relevance" }))
      .toEqual(["정렬 최신 활동순 → 관련도", "틱당 페이지 10 → 12"]);
    expect(describeChanges({ ...before, maxNewPerHour: "3000" }, { ...before, maxNewPerHour: "2500" }))
      .toEqual(["시간당 새 저장소 3000 → 2500"]);
    expect(describeChanges({ ...before, maxReviewBacklog: "1000000" }, { ...before, maxReviewBacklog: "2000000" }))
      .toEqual(["검수 대기열 상한 1000000 → 2000000"]);
    // 꺼진 체크박스는 폼에서 값이 빠진다
    const off = Object.fromEntries(Object.entries(before).filter(([key]) => key !== "excludeForks"));
    expect(describeChanges(before, off)).toEqual(["포크 제외 켬 → 끔"]);
  });

  it("목록은 더하고 뺀 수를, 신호는 늘어난 수를 적는다", () => {
    expect(describeChanges(before, { ...before, blockedHomepageDomains: "x.com\npypi.org\nnpmjs.com" })).toEqual(["차단 도메인 +2 −1"]);
    expect(describeChanges(before, { ...before, queryCount: "3", "query.1.label": "Codex" })).toEqual(["검색 신호 +1"]);
  });

  it("공개 목록의 급상승 확인 기간도 적는다", () => {
    expect(describeChanges({ ...before, risingFreshDays: "7" }, { ...before, risingFreshDays: "10" }))
      .toEqual(["지금 뜨는 확인 기간(일) 7 → 10"]);
  });

  it("바뀐 것이 없으면 비어 있다", () => {
    expect(describeChanges(before, { ...before })).toEqual([]);
  });
  it("추가 1차 모델을 바꾸거나 지우면 저장할 변경으로 표시한다", () => {
    expect(describeChanges({}, { firstAdditionalProvider0: "abcllm", firstAdditionalModel0: "[supa] Qwen3.8-27B-NVFP4" })).toEqual(["추가 1차 모델"]);
    expect(describeChanges({ firstAdditionalModel0: "opus" }, {})).toEqual(["추가 1차 모델"]);
  });
});

describe("크롤 설정 계산", () => {
  it("틱당 페이지를 시간당 검색 수와 한도 대비로 바꾼다 — 수집은 1분마다, 검색 신원 하나", () => {
    expect(searchUsage(10)).toEqual({ perHour: 600, percent: "33.3%" });
    expect(searchUsage(6)).toEqual({ perHour: 360, percent: "20.0%" });
    expect(searchUsage(2)).toEqual({ perHour: 120, percent: "6.7%" });
  });

  it("코드 기본값에 있는데 저장된 목록에 없는 것만 고른다", () => {
    const defaults = DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains;
    expect(missingDefaults("blockedHomepageDomains", defaults)).toEqual([]);
    expect(missingDefaults("blockedHomepageDomains", defaults.slice(1))).toEqual([defaults[0]]);
  });
});
