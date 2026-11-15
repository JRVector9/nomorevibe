import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 상세 og 그림(/p/<slug>/og.jpg)과 공유 카드 글(shareCardData) — 이름·요약·사이트 표기만, 칩(스타·HN·써본 사람·분야)·날짜 없음
 * (2026-11-15 사람 결정, docs/tasks/2026-11-15-public-html-name-summary.md 4.3). DB 는 가짜로 바꾼다.
 */
const mocks = vi.hoisted(() => ({ identity: vi.fn(), translations: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, onReplica: <T>(load: () => Promise<T>) => load() }));
vi.mock("@/lib/domain/products/public-reads", () => ({ publicRead: <T>(_kind: string, _key: unknown[], load: () => Promise<T>) => load() }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductIdentity: mocks.identity }));
vi.mock("@/lib/i18n/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/products")>()), readTranslationsForProducts: mocks.translations,
}));

const { GET } = await import("@/app/(public)/[locale]/(content)/p/[slug]/og.jpg/route");
const { shareCardData } = await import("@/lib/me/share");

const ORIGIN = "https://nomorevibe.example";
const call = (locale: string, slug: string) => GET(new Request(`${ORIGIN}/${locale}/p/${slug}/og.jpg`), { params: Promise.resolve({ locale, slug }) });

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

describe("GET /p/<slug>/og.jpg", () => {
  it("1200×630 JPEG, 공유 카드와 같은 캐시·p-<slug> 태그", async () => {
    mocks.identity.mockResolvedValue(product());
    const response = await call("ko", "tiny-cron");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-tag")).toBe("p-tiny-cron");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(await sharp(body).metadata()).toMatchObject({ format: "jpeg", width: 1200, height: 630 });
  }, 60_000);

  it("없는·목록 밖 제품과 모르는 언어는 404 — 주소 모양일 때만 p-<slug> 태그", async () => {
    mocks.identity.mockResolvedValue(null);
    const missing = await call("en", "missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-tag")).toBe("p-missing");
    expect(missing.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await call("ko", "Bad_Slug!")).headers.get("cache-tag")).toBeNull();
    mocks.identity.mockResolvedValue(product({ status: "unverified" }));
    expect((await call("ko", "tiny-cron")).status).toBe(404);
    mocks.identity.mockResolvedValue(product());
    expect((await call("fr", "tiny-cron")).status).toBe(404);
  });
});
