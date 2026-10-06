import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ og: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ getOgImage: mocks.og }));

import { GET } from "@/app/api/og-cache/[slug]/route";
import { ogVariantSrc, VariantCache, variantSize } from "@/lib/domain/products/og-variants";

const call = (path: string) => {
  const url = new URL(path, "https://nomorevibe.test");
  const slug = decodeURIComponent(url.pathname.split("/").at(-1)!);
  return GET(new Request(url), { params: Promise.resolve({ slug }) });
};
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
  .png({ compressionLevel: 0 }).toBuffer();

describe("화면용 썸네일 주소", () => {
  it("우리 사본만 .webp 사본 주소로 바꾸고, 기존 쿼리(썸네일 종류·버전)는 그대로 싣는다", () => {
    expect(ogVariantSrc("/api/og-cache/easyread", 640)).toBe("/api/og-cache/easyread.webp?size=640");
    expect(ogVariantSrc("/api/og-cache/compass-5?thumbnail=github_avatar&w=96&h=96&v=1", 192))
      .toBe("/api/og-cache/compass-5.webp?thumbnail=github_avatar&w=96&h=96&v=1&size=192");
    expect(ogVariantSrc("https://cdn.example/x.png", 640)).toBe("https://cdn.example/x.png");
    expect(ogVariantSrc("/api/og-cache/../etc", 640)).toBe("/api/og-cache/../etc");
    expect(ogVariantSrc(null, 640)).toBeNull();
  });

  it("크기는 정해 둔 것만 — 모르면 640", () => {
    expect(variantSize("320")).toBe(320);
    expect(variantSize("333")).toBe(640);
    expect(variantSize(null)).toBe(640);
  });

  it("메모리 사본은 최근 것부터 남긴다", () => {
    const cache = new VariantCache(2);
    cache.set("a", Buffer.from("a")); cache.set("b", Buffer.from("b"));
    cache.get("a");
    cache.set("c", Buffer.from("c"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.toString()).toBe("a");
  });
});

describe("썸네일 경로", () => {
  beforeEach(() => vi.clearAllMocks());

  it(".webp 사본은 화면 크기로 줄인 WebP 를 Cloudflare 가 캐시하게 보낸다", async () => {
    const original = await png(1600, 840);
    mocks.og.mockResolvedValue({ data: original, contentType: "image/png" });
    const response = await call("/api/og-cache/big-shot.webp?size=640");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    // 제품이 내려가면 크기별 사본을 태그 하나로 지운다
    expect(response.headers.get("cache-tag")).toBe("og-big-shot");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBeLessThan(original.length / 10);
    expect((await sharp(body).metadata()).width).toBe(640);
    // 같은 사본은 두 번째부터 DB 를 읽지 않는다
    await call("/api/og-cache/big-shot.webp?size=640");
    expect(mocks.og).toHaveBeenCalledTimes(1);
  });

  it("작은 그림은 늘리지 않고, 원본 주소는 예전 그대로 원본을 보낸다", async () => {
    const icon = await png(96, 96);
    mocks.og.mockResolvedValue({ data: icon, contentType: "image/png" });
    const small = await call("/api/og-cache/tiny-icon.webp?size=1200");
    expect((await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width).toBe(96);
    const legacy = await call("/api/og-cache/tiny-icon");
    expect(legacy.headers.get("content-type")).toBe("image/png");
    expect(legacy.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(legacy.headers.get("cache-tag")).toBe("og-tiny-icon");
    expect(Buffer.from(await legacy.arrayBuffer()).equals(icon)).toBe(true);
  });

  it("줄이지 못하는 그림은 원본으로 보내고, 없는 것·잘못된 이름은 거절한다", async () => {
    mocks.og.mockResolvedValue({ data: Buffer.from("not an image"), contentType: "image/png" });
    const broken = await call("/api/og-cache/broken-one.webp?size=640");
    expect(broken.status).toBe(200);
    expect(broken.headers.get("content-type")).toBe("image/png");
    mocks.og.mockResolvedValue(null);
    expect((await call("/api/og-cache/missing.webp")).status).toBe(404);
    expect((await call("/api/og-cache/Bad_Slug.webp")).status).toBe(400);
  });
});
