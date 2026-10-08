import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings } from "@/lib/db/schema";
import { getSettings, saveSettings, getSettingsMeta, enabledQueries, settingsFormVersion } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlSettings);
});

describe("설정 읽기", () => {
  it("아무것도 저장돼 있지 않으면 기본값을 준다", async () => {
    expect(await getSettings()).toEqual(DEFAULT_CRAWL_SETTINGS);
  });

  it("수집은 기본으로 꺼져 있다 — 켜는 것은 명시적 행위여야 한다", async () => {
    expect((await getSettings()).enabled).toBe(false);
  });
});

describe("설정 저장", () => {
  it("한 항목만 바꿔 보낼 수 있다 — 나머지는 유지된다", async () => {
    const result = await saveSettings({ judge: { maxStars: 500 } }, "admin@test");
    expect(result.ok).toBe(true);

    const saved = await getSettings();
    expect(saved.judge.maxStars).toBe(500);
    // 같은 블록의 다른 값이 날아가지 않는다
    expect(saved.judge.excludeForks).toBe(DEFAULT_CRAWL_SETTINGS.judge.excludeForks);
    expect(saved.judge.blockedHomepageDomains).toEqual(
      DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains,
    );
    // 다른 블록도 그대로다
    expect(saved.discover).toEqual(DEFAULT_CRAWL_SETTINGS.discover);
  });

  it("연달아 바꿔도 앞의 변경이 남는다", async () => {
    await saveSettings({ judge: { maxStars: 500 } }, "a");
    await saveSettings({ judge: { excludeForks: false } }, "b");

    const saved = await getSettings();
    expect(saved.judge.maxStars).toBe(500);
    expect(saved.judge.excludeForks).toBe(false);
  });

  it("급상승 확인 기간은 따로 저장되고, 다른 항목을 저장해도 남는다", async () => {
    await saveSettings({ judge: { maxStars: 500 } }, "a");
    await saveSettings({ rising: { freshDays: 10 } }, "b");
    await saveSettings({ judge: { excludeForks: false } }, "c");

    const saved = await getSettings();
    expect(saved.rising).toEqual({ freshDays: 10 });
    expect(saved.judge.maxStars).toBe(500);
    expect(saved.judge.excludeForks).toBe(false);
    expect(saved.discover).toEqual(DEFAULT_CRAWL_SETTINGS.discover);

    // 범위 밖은 쓰지 않는다
    expect((await saveSettings({ rising: { freshDays: 31 } }, "d")).ok).toBe(false);
    expect((await getSettings()).rising).toEqual({ freshDays: 10 });
  });

  it("검증에 실패하면 아무것도 쓰지 않는다", async () => {
    await saveSettings({ judge: { maxStars: 500 } }, "admin");

    const bad = await saveSettings({ judge: { maxStars: -1 } }, "admin");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join()).toContain("maxStars");

    // 이전 값이 그대로 살아 있다
    expect((await getSettings()).judge.maxStars).toBe(500);
  });

  it("누가 언제 바꿨는지 남는다 — 수집량이 달라진 이유를 되짚으려면 필요하다", async () => {
    await saveSettings({ enabled: true }, "jinwoo");
    const meta = await getSettingsMeta();
    expect(meta?.updatedBy).toBe("jinwoo");
    expect(meta?.updatedAt).toBeInstanceOf(Date);
  });

  it("수집 스위치를 끌 수 있다 — 배포 없이 멈춰야 한다", async () => {
    await saveSettings({ enabled: true }, "admin");
    expect((await getSettings()).enabled).toBe(true);

    await saveSettings({ enabled: false }, "admin");
    expect((await getSettings()).enabled).toBe(false);
  });

  it("검색 신호를 개별로 끌 수 있다", async () => {
    const queries = DEFAULT_CRAWL_SETTINGS.discover.queries.map((q) => ({ ...q, enabled: false }));
    await saveSettings({ discover: { queries } }, "admin");

    expect(enabledQueries(await getSettings())).toHaveLength(0);
  });

  it("저장된 신호 목록이 기본 신호를 통째로 덮는다 — 새 기본 신호는 저절로 오지 않는다", async () => {
    /**
     * 배열은 병합할 방법이 없다. 두 배열을 이어 붙이면 운영자가 지운 신호가 되살아나고,
     * 이름으로 맞춰 덮으면 이름을 바꾼 신호가 둘로 늘어난다. 그래서 저장된 목록이 곧 목록이다.
     *
     * 즉 코드에 기본 신호를 더해도 이미 저장된 환경에는 닿지 않는다 — 커밋 신호 둘만
     * 저장된 프로덕션은 vibe-coding 토픽을 영영 못 본다. 어긋남 표시가 이것을 짚고,
     * 사람은 /admin의 빈 행에 적어 더한다.
     */
    await saveSettings(
      { discover: { queries: DEFAULT_CRAWL_SETTINGS.discover.queries.slice(0, 2) } },
      "admin",
    );

    const labels = (await getSettings()).discover.queries.map((q) => q.label);
    expect(labels).toEqual(["Claude 커밋 트레일러", "Codex 커밋 트레일러"]);
    expect(labels).not.toContain("vibe-coding 토픽");
  });
});

describe("스키마가 자란 뒤에도 읽힌다", () => {
  it("저장된 값에 없는 필드는 기본값으로 메운다", async () => {
    // 필터를 새로 추가하기 전에 저장된 행을 흉내낸다.
    // 여기서 검증을 실패시키면 설정을 못 읽어 수집이 멈춘다.
    await db.insert(crawlSettings).values({
      id: 1,
      values: { enabled: true, judge: { maxStars: 42 } },
      updatedBy: "옛날",
    });

    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.judge.maxStars).toBe(42);
    // 없던 필드가 기본값으로 채워졌다
    expect(settings.judge.excludeForks).toBe(DEFAULT_CRAWL_SETTINGS.judge.excludeForks);
    expect(settings.discover.windowDays).toBe(DEFAULT_CRAWL_SETTINGS.discover.windowDays);
  });

  it("손상된 값은 기본값으로 되돌리되 반드시 로그를 남긴다", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await db.insert(crawlSettings).values({
      id: 1,
      values: { judge: { maxStars: "숫자아님" } },
      updatedBy: "손상",
    });

    // 조용히 다른 기준으로 도는 것이 최악이다
    expect(await getSettings()).toEqual(DEFAULT_CRAWL_SETTINGS);
    expect(stderr.mock.calls.map((c) => c[0] as string).join()).toContain("crawl.settings_invalid");
    stderr.mockRestore();
  });
});

describe("행이 하나만 존재한다", () => {
  it("여러 번 저장해도 행이 늘지 않는다", async () => {
    for (const stars of [100, 200, 300]) {
      await saveSettings({ judge: { maxStars: stars } }, "admin");
    }
    const rows = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    expect(rows).toHaveLength(1);
    expect(await db.$count(crawlSettings)).toBe(1);
    expect((await getSettings()).judge.maxStars).toBe(300);
  });
});

/**
 * 크롤 설정 폼은 그린 판(settingsFormVersion)을 함께 보낸다. 그 사이 다른 곳이 폼이 다루는 값을 바꿨으면
 * 저장하지 않는다 — 열어 둔 폼의 옛 값이 비상 정지나 2차 표 전환을 조용히 되돌리던 길이다.
 */
describe("열어 둔 폼의 옛 값", () => {
  it("다른 곳에서 수집을 끈 뒤 옛 폼이 저장하면 거절하고 꺼진 채로 둔다", async () => {
    await saveSettings({ enabled: true }, "setup");
    const opened = settingsFormVersion(await getSettings());

    // 다른 탭에서 비상 정지
    await saveSettings({ enabled: false }, "other-tab");

    const result = await saveSettings({ enabled: true, discover: { windowDays: 9 } }, "stale-tab", { expectedFormVersion: opened });
    expect(result.ok).toBe(false);
    const saved = await getSettings();
    expect(saved.enabled).toBe(false);
    expect(saved.discover.windowDays).toBe(DEFAULT_CRAWL_SETTINGS.discover.windowDays);
  });

  it("폼이 다루지 않는 값(소식·카테고리·리뷰 모드)이 바뀐 것은 판을 바꾸지 않는다", async () => {
    const opened = settingsFormVersion(await getSettings());
    await saveSettings({ news: { autoApprove: false } }, "news-page");

    const result = await saveSettings({ discover: { windowDays: 9 } }, "settings-page", { expectedFormVersion: opened });
    expect(result.ok).toBe(true);
    expect((await getSettings()).discover.windowDays).toBe(9);
    expect((await getSettings()).news.autoApprove).toBe(false);
  });

  it("판이 맞으면 저장하고, 저장한 뒤의 판은 새 값을 따른다", async () => {
    const opened = settingsFormVersion(await getSettings());
    expect((await saveSettings({ discover: { windowDays: 9 } }, "a", { expectedFormVersion: opened })).ok).toBe(true);
    expect(settingsFormVersion(await getSettings())).not.toBe(opened);
    // 같은 판으로 한 번 더 — 이미 바뀌었으니 거절
    expect((await saveSettings({ discover: { windowDays: 10 } }, "a", { expectedFormVersion: opened })).ok).toBe(false);
  });
});
