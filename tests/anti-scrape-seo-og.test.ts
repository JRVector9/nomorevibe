import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ og: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ getOgImage: mocks.og }));
import { GET } from "@/app/api/og-cache/[slug]/route";

let sequence = 0;
const call = (suffix = "", query = "", slug = `seo-${++sequence}`) => GET(
  new Request(`https://nomorevibe.test/api/og-cache/${slug}${suffix}${query}`),
  { params: Promise.resolve({ slug: `${slug}${suffix}` }) },
);
const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#ce4721" } }).png({ compressionLevel: 0 }).toBuffer();
beforeEach(() => vi.clearAllMocks());

describe("anti-scrape SEO OG response", () => {
  it("replaces a multi-megabyte original with a decodable social-preview JPEG", async () => {
    const source = await image(1600, 840);
    mocks.og.mockResolvedValue({ data: source, contentType: "image/png" });
    const response = await call();
    const body = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(body).metadata();
    console.info(JSON.stringify({ sourceBytes: source.length, responseBytes: body.length, width: meta.width, height: meta.height, format: meta.format }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(630);
    expect(body.length).toBeLessThanOrEqual(512 * 1024);
    expect(body.equals(source)).toBe(false);
  });
  it.each(["", ".webp"])("bounds tall images, bypass query sizes, and repeat cached requests for %s", async suffix => {
    const source = await image(100, 4000);
    mocks.og.mockResolvedValue({ data: source, contentType: "image/png" });
    const slug = `seo-tall-${++sequence}`;
    const first = await call(suffix, "?size=999999&raw=1&original=1", slug);
    const body = Buffer.from(await first.arrayBuffer());
    const meta = await sharp(body).metadata();
    expect(first.status).toBe(200);
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(630);
    const second = await call(suffix, "?size=999999&raw=1&original=1", slug);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(body);
    expect(mocks.og).toHaveBeenCalledTimes(1);
    expect(second.headers.get("cache-tag")).toBe(`og-${slug}`);
  });
  it.each(["", ".webp"])("never falls back to original bytes after decoder failure for %s", async suffix => {
    const source = Buffer.from("private-original-not-an-image");
    mocks.og.mockResolvedValue({ data: source, contentType: "image/png" });
    const response = await call(suffix);
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain(source.toString());
  });
  it("limits high-entropy WebP responses and never enlarges small images", async () => {
    const source = await sharp(randomBytes(1400 * 800 * 3), { raw: { width: 1400, height: 800, channels: 3 } }).png().toBuffer();
    mocks.og.mockResolvedValue({ data: source, contentType: "image/png" });
    const response = await call(".webp", "?size=1200");
    const body = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(630);
    expect(body.length).toBeLessThanOrEqual(512 * 1024);
    mocks.og.mockResolvedValue({ data: await image(32, 32), contentType: "image/png" });
    const icon = await call();
    expect(await sharp(Buffer.from(await icon.arrayBuffer())).metadata()).toMatchObject({ width: 32, height: 32 });
  });
  it("uses only the first animation frame and refuses pixel bombs without leaking originals", async () => {
    const gif = await sharp({ create: { width: 100, height: 200, channels: 3, background: "red", pageHeight: 100 } }).gif({ keepDuplicateFrames: true, delay: [100, 100] }).toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    mocks.og.mockResolvedValue({ data: gif, contentType: "image/gif" });
    const response = await call(".webp");
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(meta.pages ?? 1).toBe(1);
    const bomb = await image(4100, 4000);
    mocks.og.mockResolvedValue({ data: bomb, contentType: "image/png" });
    const refused = await call();
    expect(refused.status).toBe(422);
    expect(refused.headers.get("cache-control")).toContain("no-store");
  });
});
