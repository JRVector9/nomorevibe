import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { RISING_FRESH_DAYS } from "@/lib/domain/products/repository";

/** 홈 '지금 뜨는 프로젝트'의 마지막 스타 확인 기간 — 어드민 크롤 설정(rising.freshDays) */
describe("급상승 확인 기간 설정", () => {
  it("기본값은 코드 기본값(RISING_FRESH_DAYS)과 같은 7일이다", () => {
    expect(DEFAULT_CRAWL_SETTINGS.rising).toEqual({ freshDays: RISING_FRESH_DAYS });
    expect(RISING_FRESH_DAYS).toBe(7);
  });

  it("이 칸이 없는 옛 행도 기본값으로 읽는다 — 마이그레이션이 없다", () => {
    const stored: Partial<typeof DEFAULT_CRAWL_SETTINGS> = { ...DEFAULT_CRAWL_SETTINGS };
    delete stored.rising;
    expect(mergeWithDefaults({ ...stored, enabled: true })).toMatchObject({ enabled: true, rising: { freshDays: 7 } });
    expect(mergeWithDefaults({ ...stored, rising: {} }).rising).toEqual({ freshDays: 7 });
    expect(mergeWithDefaults({ ...stored, rising: { freshDays: 3 } }).rising).toEqual({ freshDays: 3 });
  });

  it.each([0, 31, 2.5, -1])("%s 일은 받지 않는다 — 정수 1~30", (freshDays) => {
    expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, rising: { freshDays } }).success).toBe(false);
  });

  it.each([1, 30])("%s 일은 받는다", (freshDays) => {
    expect(crawlSettingsSchema.parse({ ...DEFAULT_CRAWL_SETTINGS, rising: { freshDays } }).rising.freshDays).toBe(freshDays);
  });
});
