import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { crawlSettings } from "@/lib/db/schema";
import { getSettings, saveSettings, settingsDrift, resetSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlSettings);
});

describe("저장된 기준과 기본값의 차이", () => {
  it("저장한 적이 없으면 어긋난 것이 없다", async () => {
    expect(settingsDrift(await getSettings())).toEqual([]);
  });

  it("기본값 그대로 저장해도 어긋나지 않는다", async () => {
    await saveSettings({ enabled: true }, "테스트");
    expect(settingsDrift(await getSettings())).toEqual([]);
  });

  it("바꾼 항목만 짚는다", async () => {
    await saveSettings({ judge: { maxStars: 50, excludeOrganizations: true } }, "테스트");

    const drift = settingsDrift(await getSettings());

    expect(drift.map((d) => d.label).sort()).toEqual(["스타 상한", "조직 계정 제외"]);
    expect(drift.find((d) => d.label === "스타 상한")).toMatchObject({ stored: "50", standard: "1000" });
  });

  it("새 필터가 코드에 생기면 저장된 설정에도 기본값으로 들어온다", async () => {
    // 마이그레이션 없이 필터를 추가할 수 있는 이유 — 없는 필드는 기본값으로 채운다
    await db.insert(crawlSettings).values({ id: 1, values: { enabled: true, judge: { maxStars: 1000 } } });

    const settings = await getSettings();

    expect(settings.judge.docsGenerators).toEqual(DEFAULT_CRAWL_SETTINGS.judge.docsGenerators);
    expect(settings.judge.personalSiteKeywords).toEqual(DEFAULT_CRAWL_SETTINGS.judge.personalSiteKeywords);
  });

  it("되돌리면 기준은 기본값이 되고 수집 스위치는 유지된다", async () => {
    // 기준을 맞추려다 수집이 켜지거나 꺼지면 그게 더 큰 사고다
    await saveSettings({ enabled: true, judge: { maxStars: 5, excludeOrganizations: true } }, "테스트");

    const result = await resetSettings("jr");

    expect(result.ok).toBe(true);
    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.judge.maxStars).toBe(DEFAULT_CRAWL_SETTINGS.judge.maxStars);
    expect(settingsDrift(settings)).toEqual([]);
  });

  it("꺼져 있으면 꺼진 채로 되돌린다", async () => {
    await saveSettings({ enabled: false, judge: { maxStars: 5 } }, "테스트");

    await resetSettings("jr");

    expect((await getSettings()).enabled).toBe(false);
  });
});
