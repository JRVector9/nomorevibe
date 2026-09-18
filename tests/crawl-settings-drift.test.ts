import { describe, expect, it } from "vitest";
import { settingsDrift } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

/**
 * 어긋남 표시는 읽히는 것만으로는 부족하고 고를 수 있어야 한다.
 *
 * 값 둘을 나란히 늘어놓기만 하던 때는 차단 도메인 스물넷과 열다섯이 나란히 떠서 무엇이
 * 빠졌는지 사람이 눈으로 빼야 했다(2026-09-18, 사용자가 판단 못 하겠다고 함).
 */
describe("설정 어긋남 — 사람이 고를 수 있어야 한다", () => {
  const withJudge = (patch: Partial<typeof DEFAULT_CRAWL_SETTINGS.judge>) => ({
    ...DEFAULT_CRAWL_SETTINGS,
    judge: { ...DEFAULT_CRAWL_SETTINGS.judge, ...patch },
  });

  it("목록은 빠진 것과 더 있는 것을 따로 센다", () => {
    const domains = DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains;
    const item = settingsDrift(withJudge({ blockedHomepageDomains: domains.slice(0, 3) }))
      .find((row) => row.label === "차단 도메인")!;
    expect(item.absent).toEqual(domains.slice(3));
    expect(item.extra).toEqual([]);
  });

  it("빠지기만 한 목록은 '닿지 못한 것'이고, 값을 바꾼 것은 '다른 것'이다", () => {
    // 사람이 할 판단이 다르다 — 앞은 거의 언제나 실수고, 뒤는 일부러 그랬을 수 있다
    const titles = DEFAULT_CRAWL_SETTINGS.judge.placeholderTitles;
    expect(settingsDrift(withJudge({ placeholderTitles: titles.slice(0, -1) }))
      .find((row) => row.label === "스캐폴드 제목")?.kind).toBe("absent");

    expect(settingsDrift(withJudge({ maxStars: 99_999 })).find((row) => row.label === "스타 상한"))
      .toMatchObject({ kind: "changed", stored: "99999", standard: "1000", absent: [], extra: [] });
  });

  it("목록에 더 넣은 것은 빠진 것이 없어도 '다른 것'이다", () => {
    const domains = DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains;
    expect(settingsDrift(withJudge({ blockedHomepageDomains: [...domains, "example.test"] }))
      .find((row) => row.label === "차단 도메인"))
      .toMatchObject({ kind: "changed", absent: [], extra: ["example.test"] });
  });

  it("같으면 아무것도 짚지 않는다", () => {
    expect(settingsDrift(DEFAULT_CRAWL_SETTINGS)).toEqual([]);
  });
});
