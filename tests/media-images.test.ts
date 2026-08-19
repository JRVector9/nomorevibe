import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  MAX_IMAGE_SOURCE_BYTES,
  assertImageDimensions,
  fetchAndNormalizeImage,
  hashImageVariants,
  normalizeImage,
} from "@/lib/domain/media/images";

async function source(format: "jpeg" | "png" | "webp", color = "#7755ee") {
  return sharp({
    create: { width: 640, height: 360, channels: 4, background: color },
  })[format]().toBuffer();
}

describe("image normalization", () => {
  it.each(["jpeg", "png", "webp"] as const)("accepts real %s bytes and emits deterministic WebP variants", async (format) => {
    const input = await source(format);
    const first = await normalizeImage(input);
    const second = await normalizeImage(input);
    expect(first).toMatchObject({
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      mimeType: "image/webp",
      web: { width: 640, height: 360, size: expect.any(Number) },
      thumbnail: { width: 480, height: 270, size: expect.any(Number) },
    });
    expect(first.hash).toBe(second.hash);
    expect(first.web.data.equals(second.web.data)).toBe(true);
    expect((await sharp(first.web.data).metadata()).format).toBe("webp");
  });

  it("rejects disguised or unsupported content even when a caller claims it is an image", async () => {
    await expect(normalizeImage(Buffer.from("<html>not an image</html>"))).rejects.toThrow("unsupported image");
    const gif = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    }).gif().toBuffer();
    await expect(normalizeImage(gif)).rejects.toThrow("unsupported image format");
  });

  it("strips EXIF/orientation metadata from normalized variants", async () => {
    const input = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "blue" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const asset = await normalizeImage(input);
    const metadata = await sharp(asset.web.data).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect([asset.web.width, asset.web.height]).toEqual([80, 120]);
  });

  it("rejects source bytes, decoded pixels, and dimensions above their limits", async () => {
    await expect(normalizeImage(Buffer.alloc(MAX_IMAGE_SOURCE_BYTES + 1))).rejects.toThrow("source too large");
    expect(() => assertImageDimensions({ width: 10_001, height: 1 })).toThrow("dimensions too large");
    expect(() => assertImageDimensions({ width: 8_000, height: 6_000 })).toThrow("pixel count too large");
  });

  it("rejects a redirect to a private address before decoding bytes", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private.png" },
    }));
    await expect(fetchAndNormalizeImage("https://example.com/gallery.png", { request })).resolves.toEqual({
      ok: false,
      reason: "unsafe_url",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("changes immutable identity when either normalized variant changes", () => {
    const web = Buffer.from("normalized-web");
    expect(hashImageVariants(web, Buffer.from("thumbnail-a"))).not.toBe(
      hashImageVariants(web, Buffer.from("thumbnail-b")),
    );
    expect(hashImageVariants(Buffer.from("other-web"), Buffer.from("thumbnail-a"))).not.toBe(
      hashImageVariants(web, Buffer.from("thumbnail-a")),
    );
  });
});
