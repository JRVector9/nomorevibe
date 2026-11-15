import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 공유 카드 글(shareCardData, /p/<slug>/share-card.png) — 이름·요약·사이트 표기만, 칩(스타·HN·써본 사람·분야)·날짜 없음.
 * 상세 페이지의 공유 미리보기(og:image)는 이 카드가 아니라 지금처럼 제품 표지다(2026-11-15 사람 결정)
 * (2026-11-15 사람 결정, docs/tasks/2026-11-15-public-html-name-summary.md 4.3). DB 는 가짜로 바꾼다.
 */
const mocks = vi.hoisted(() => ({ identity: vi.fn(), translations: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, onReplica: <T>(load: () => Promise<T>) => load() }));
vi.mock("@/lib/domain/products/public-reads", () => ({ publicRead: <T>(_kind: string, _key: unknown[], load: () => Promise<T>) => load() }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductIdentity: mocks.identity }));
vi.mock("@/lib/i18n/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/products")>()), readTranslationsForProducts: mocks.translations,
}));

const { shareCardData } = await import("@/lib/me/share");

const ORIGIN = "https://nomorevibe.example";

/** 숨길 칸마다 표식 값 — 카드 글 어디에도 나오면 안 된다 */
const product = (extra: Record<string, unknown> = {}) => ({
  id: 7, slug: "tiny-cron", name: "tiny-cron", tagline: "Turns plain words into cron", taglineKo: "  자연어 일정을 cron 식으로  ",
  description: "SENTINEL_DESCRIPTION", status: "seeded", source: "crawler", claimedAt: null, auditHoldAt: null,
  category: "SENTINEL_CAT", stars: 987654, repoUrl: "https://sentinel.example/repo", url: "https://sentinel.example/site",
  ogImage: "/api/og-cache/sentinel", makerName: "SENTINEL_MAKER", languages: ["SENTINEL_LANG"], ...extra,
});
const SENTINELS = /SENTINEL|987654|987,654|sentinel\.example|og-cache|★|Hacker News|기준|as of/;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  mocks.identity.mockReset();
  mocks.translations.mockReset().mockResolvedValue([]);
});

describe("shareCardData — 이름·요약·사이트 표기만", () => {
  it("한국어는 한국어 한 줄(없으면 원문), 칩·날짜 칸이 없다", async () => {
    mocks.identity.mockResolvedValue(product());
    const ko = await shareCardData("tiny-cron", "ko");
    expect(Object.keys(ko!).sort()).toEqual(["brandLine", "name", "tagline", "url"]);
    expect(ko).toMatchObject({ name: "tiny-cron", tagline: "자연어 일정을 cron 식으로", url: "nomorevibe.example/p/tiny-cron" });
    expect(JSON.stringify(ko)).not.toMatch(SENTINELS);
    mocks.identity.mockResolvedValue(product({ taglineKo: "  " }));
    expect((await shareCardData("tiny-cron", "ko"))!.tagline).toBe("Turns plain words into cron");
  });

  it("다른 언어는 원문(번역이 없을 때) — 번역을 못 읽어도 카드는 나온다", async () => {
    mocks.identity.mockResolvedValue(product());
    mocks.translations.mockRejectedValue(new Error("db down"));
    const en = await shareCardData("tiny-cron", "en");
    expect(en).toMatchObject({ tagline: "Turns plain words into cron" });
    expect(JSON.stringify(en)).not.toMatch(SENTINELS);
  });

  it("목록 밖(검증 전·내림·감사 보류) 제품은 null", async () => {
    for (const extra of [{ status: "unverified" }, { status: "banned" }, { auditHoldAt: new Date() }]) {
      mocks.identity.mockResolvedValue(product(extra));
      expect(await shareCardData("tiny-cron", "ko")).toBeNull();
    }
  });
});
