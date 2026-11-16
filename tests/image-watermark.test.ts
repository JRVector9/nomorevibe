import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ og: vi.fn(), identity: vi.fn(), rendered: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ getOgImage: mocks.og }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductIdentity: mocks.identity }));
vi.mock("@/lib/domain/products/public-reads", () => ({ publicRead: (_kind: string, _key: unknown[], load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/i18n/products", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/i18n/products")>()), readTranslationsForProducts: async () => [] }));
vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("next/og", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/og")>();
  return { ...actual, ImageResponse: class extends actual.ImageResponse {
    constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
      mocks.rendered(args[0]);
      super(...args);
    }
  } };
});

import { watermarkLayers } from "@/lib/images/watermark";
import { IMAGE_WATERMARK_VERSION, watermarkedImageUrl } from "@/lib/images/watermark-policy";
import { coverKey, protectedCoverUrl } from "@/lib/domain/products/cover-url";
import { VariantCache, ogVariantSrc } from "@/lib/domain/products/og-variants";
import { GET } from "@/app/api/og-cache/[slug]/route";
import { createMediaGet } from "@/lib/domain/media/http";
import type { MediaStorage } from "@/lib/domain/media/storage";
import { shareCardData } from "@/lib/me/share";
import { shareCardPng } from "@/lib/me/share-card";

const source = (width: number, height: number, background = "#152439") =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const region = (data: Buffer, left: number, top: number, width: number, height: number) =>
  sharp(data).extract({ left, top, width, height }).removeAlpha().raw().toBuffer();
const callOg = async (slug: string, webp = true, query = "") => {
  vi.stubEnv("VISITOR_HASH_SECRET", "watermark-unit-test-secret-0123456789abcdef");
  const segment = `${slug}.${coverKey(slug)}${webp ? ".webp" : ""}`;
  const response = await GET(new Request(`https://nomorevibe.com/api/og-cache/${segment}?size=640&${query}`),
    { params: Promise.resolve({ slug: segment }) });
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
};
const identity = (slug: string, kind = "og") => ({
  slug, name: "Watermark QA", tagline: "Image QA", status: "verified",
  ogImage: `/api/og-cache/${slug}?thumbnail=${kind}`,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockImplementation(async (slug: string) => identity(slug));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("served image watermark", () => {
  it.each(["#ffffff", "#152439"])("changes only the bottom right pixels on %s, using the bundled face offline", async (background) => {
    const original = await source(640, 336, background);
    const localFetch = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).startsWith("data:")) return localFetch(input, init); // bundled Satori WASM
      throw new Error("network must not be used");
    });
    const output = await sharp(original).composite(await watermarkLayers(640, 336)).png().toBuffer();
    expect(await region(output, 0, 0, 300, 160)).toEqual(await region(original, 0, 0, 300, 160));
    expect(await region(output, 490, 290, 150, 46)).not.toEqual(await region(original, 490, 290, 150, 46));
    if (background === "#ffffff") expect(Math.min(...await region(output, 490, 290, 150, 46))).toBeLessThan(200);
    expect(fetch.mock.calls.filter(([input]) => !String(input).startsWith("data:"))).toHaveLength(0);
  });

  it.each([[1200, 64, null], [199, 100, null], [192, 96, null], [640, 63, null], [640, 336, "github_avatar"], [640, 336, "site_icon"], [640, 336, "default"]] as const)(
    "leaves small copies and icons untouched (%s × %s, %s)", async (width, height, kind) => {
      const original = await source(width, height);
      expect(await watermarkLayers(width, height, kind)).toEqual([]);
      // No encoding round trip for excluded images in the serving code.
      const media: MediaStorage = { get: async () => ({ data: original, mimeType: "image/webp", size: original.length }), put: vi.fn(), deleteIfUnreferenced: vi.fn() };
      if (kind === null) {
        const response = await createMediaGet(media)(new Request("https://nomorevibe.com/api/media/a"), { params: Promise.resolve({ hash: "a".repeat(64) }) });
        expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
      }
    });

  it("starts at 200px and scales the label with the output width", async () => {
    expect(await watermarkLayers(200, 100)).toHaveLength(1);
    const small = (await watermarkLayers(320, 168))[0];
    const large = (await watermarkLayers(1200, 630))[0];
    expect((await sharp(large.input as Buffer).metadata()).width).toBeGreaterThan((await sharp(small.input as Buffer).metadata()).width!);
  });

  it.each([false, true])("watermarks the actual OG %s response and bumps preview-v2 to preview-v3", async (webp) => {
    const original = await source(1200, 630);
    const saved = Buffer.from(original);
    mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
    const cacheSet = vi.spyOn(VariantCache.prototype, "set");
    const output = await callOg(`watermark-${webp ? "webp" : "jpeg"}`, webp);
    const width = webp ? 640 : 1200, height = webp ? 336 : 630;
    const baseline = await (webp ? sharp(original).resize(width, height).webp({ quality: 78 }) : sharp(original).jpeg({ quality: 78 })).toBuffer();
    // Lossy JPEG/WebP encoding can shift an untouched flat region by a few channel levels.
    const top = await region(output, 0, 0, 200, 100), before = await region(baseline, 0, 0, 200, 100);
    expect(Math.max(...top.map((value, index) => Math.abs(value - before[index])))).toBeLessThanOrEqual(5);
    expect(await region(output, width - 180, height - 60, 180, 60)).not.toEqual(await region(baseline, width - 180, height - 60, 180, 60));
    expect(original).toEqual(saved);
    expect(cacheSet.mock.calls.at(-1)?.[0]).toMatch(/^preview-v3\|/);
  });

  describe.each([false, true])("request thumbnail bypass (webp=%s)", (webp) => {
    it.each(["default", "site_icon", "github_avatar"])("watermarks a protected cover despite thumbnail=%s", async (kind) => {
      const original = await source(1200, 630);
      mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
      const output = await callOg(`watermark-bypass-${kind.replaceAll("_", "-")}-${webp}`, webp, `thumbnail=${kind}`);
      const width = webp ? 640 : 1200, height = webp ? 336 : 630;
      const baseline = await (webp ? sharp(original).resize(width, height).webp({ quality: 78 }) : sharp(original).jpeg({ quality: 78 })).toBuffer();
      expect((await region(output, width - 180, height - 60, 180, 60))
        .equals(await region(baseline, width - 180, height - 60, 180, 60))).toBe(false);
    });

    it("reuses one watermarked cache entry when only request thumbnail changes", async () => {
      const original = await source(1200, 630);
      mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
      const cacheGet = vi.spyOn(VariantCache.prototype, "get");
      const cacheSet = vi.spyOn(VariantCache.prototype, "set");
      const slug = `watermark-cache-${webp}`;
      // Start with the bypass attempt so a clean entry cannot be hidden by a warm cover cache.
      const first = await callOg(slug, webp, "thumbnail=default");
      const width = webp ? 640 : 1200, height = webp ? 336 : 630;
      const baseline = await (webp ? sharp(original).resize(width, height).webp({ quality: 78 }) : sharp(original).jpeg({ quality: 78 })).toBuffer();
      expect((await region(first, width - 180, height - 60, 180, 60))
        .equals(await region(baseline, width - 180, height - 60, 180, 60))).toBe(false);
      for (const query of ["", "thumbnail=site_icon", "thumbnail=github_avatar", "thumbnail=og", "thumbnail=unknown"]) {
        expect(await callOg(slug, webp, query)).toEqual(first);
      }
      expect(new Set(cacheGet.mock.calls.map(([key]) => key)).size).toBe(1);
      expect(cacheSet).toHaveBeenCalledTimes(1);
      expect(mocks.og).toHaveBeenCalledTimes(1);
    });

    it.each(["github_avatar", "site_icon", "default"])("excludes stored %s without a request thumbnail and separates a later cover", async (kind) => {
      const slug = `watermark-stored-${kind.replaceAll("_", "-")}-${webp}`;
      const original = await source(640, 336);
      mocks.identity.mockResolvedValue(identity(slug, kind));
      mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
      const avatar = await callOg(slug, webp);
      const baseline = await (webp ? sharp(original).webp({ quality: 78 }) : sharp(original).jpeg({ quality: 78 })).toBuffer();
      expect((await sharp(avatar).raw().toBuffer()).equals(await sharp(baseline).raw().toBuffer())).toBe(true);
      expect((await callOg(slug, webp, "thumbnail=og")).equals(avatar)).toBe(true);
      mocks.identity.mockResolvedValue(identity(slug));
      expect((await callOg(slug, webp)).equals(avatar)).toBe(false);
    });
  });

  it.each([64, 96, 192])("does not watermark %spx OG icons with a stored cover kind", async (width) => {
    const original = await source(width, width / 2);
    mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
    const baseline = await sharp(original).webp({ quality: 78 }).toBuffer();
    expect(await sharp(await callOg(`watermark-tiny-${width}`, true)).raw().toBuffer())
      .toEqual(await sharp(baseline).raw().toBuffer());
  });

  it.each(["web", "thumbnail"])("composites the maker %s response while preserving storage bytes and headers", async (variant) => {
    const original = await sharp(await source(640, 336)).webp({ quality: 82 }).toBuffer();
    const saved = Buffer.from(original);
    const storage: MediaStorage = { get: vi.fn(async () => ({ data: original, mimeType: "image/webp", size: original.length })), put: vi.fn(), deleteIfUnreferenced: vi.fn() };
    const response = await createMediaGet(storage)(new Request(`https://nomorevibe.com/api/media/a?variant=${variant}`), { params: Promise.resolve({ hash: "a".repeat(64) }) });
    const output = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe(String(output.length));
    expect(await region(output, 490, 290, 150, 46)).not.toEqual(await region(original, 490, 290, 150, 46));
    expect(original).toEqual(saved);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("returns no-store 422 for corrupt maker bytes without leaking the source", async () => {
    const storage: MediaStorage = { get: async () => ({ data: Buffer.from("broken"), mimeType: "image/webp", size: 6 }), put: vi.fn(), deleteIfUnreferenced: vi.fn() };
    const response = await createMediaGet(storage)(new Request("https://nomorevibe.com/api/media/a"), { params: Promise.resolve({ hash: "a".repeat(64) }) });
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("broken");
  });

  it("versions delivered cover and maker URLs so old immutable/one-day copies are bypassed", () => {
    vi.stubEnv("VISITOR_HASH_SECRET", "watermark-unit-test-secret-0123456789abcdef");
    const cover = protectedCoverUrl("/api/og-cache/qa?thumbnail=og&v=7")!;
    expect(cover).toContain(`wm=${IMAGE_WATERMARK_VERSION}`);
    expect(ogVariantSrc(cover, 640)).toContain("wm=1");
    expect(watermarkedImageUrl("/api/media/hash?variant=thumbnail")).toBe("/api/media/hash?variant=thumbnail&wm=1");
    expect(protectedCoverUrl(cover)).toBe(cover);
  });

  it("keeps the share-card URL text nomorevibe.com/p/<slug> in the bottom right", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.com");
    const card = await shareCardData("watermark-qa", "en");
    expect(card?.url).toBe("nomorevibe.com/p/watermark-qa");
    mocks.rendered.mockClear();
    const png = await shareCardPng(card!, "en");
    const markup = JSON.stringify(mocks.rendered.mock.calls.at(-1)?.[0]);
    expect(markup).toContain("nomorevibe.com/p/watermark-qa");
    expect(markup).toContain('"justifyContent":"flex-end"');
    expect(await sharp(Buffer.from(png)).metadata()).toMatchObject({ width: 1200, height: 630 });
  });

  it("includes the bundled font in both standalone image route traces", async () => {
    const config = await readFile("next.config.ts", "utf8");
    expect(config).toContain('"/api/og-cache/*": ["./assets/fonts/noto-sans-kr-400.woff"]');
    expect(config).toContain('"/api/media/*": ["./assets/fonts/noto-sans-kr-400.woff"]');
  });
});
