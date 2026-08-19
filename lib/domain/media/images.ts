import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { fetchCapped, type CappedRequest, type CappedFetchFailure } from "@/lib/net/fetch";
import type { NormalizedImageAsset } from "./storage";

export const MAX_IMAGE_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_DIMENSION = 10_000;

const SOURCE_FORMATS = new Set(["jpeg", "png", "webp"]);

export function assertImageDimensions(input: Pick<Metadata, "width" | "height">): void {
  const width = input.width;
  const height = input.height;
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error("invalid image dimensions");
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error("image dimensions too large");
  }
  if (width * height > MAX_IMAGE_PIXELS) throw new Error("image pixel count too large");
}

function unsupported(error?: unknown): Error {
  const suffix = error instanceof Error && /pixel limit/i.test(error.message)
    ? "pixel count too large"
    : "unsupported image";
  return new Error(suffix);
}

export function hashImageVariants(web: Buffer, thumbnail: Buffer): string {
  const webLength = Buffer.allocUnsafe(4);
  const thumbnailLength = Buffer.allocUnsafe(4);
  webLength.writeUInt32BE(web.length);
  thumbnailLength.writeUInt32BE(thumbnail.length);
  return createHash("sha256")
    .update("nomorevibe-media-v1\0")
    .update("web\0")
    .update(webLength)
    .update(web)
    .update("thumbnail\0")
    .update(thumbnailLength)
    .update(thumbnail)
    .digest("hex");
}

export async function normalizeImage(source: Buffer): Promise<NormalizedImageAsset> {
  if (source.length > MAX_IMAGE_SOURCE_BYTES) throw new Error("image source too large");
  let metadata: Metadata;
  try {
    metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch (error) {
    throw unsupported(error);
  }
  if (!metadata.format || !SOURCE_FORMATS.has(metadata.format)) {
    throw new Error("unsupported image format");
  }
  assertImageDimensions(metadata);

  let webResult: Awaited<ReturnType<ReturnType<typeof sharp>["toBuffer"]>>;
  let thumbnailResult: Awaited<ReturnType<ReturnType<typeof sharp>["toBuffer"]>>;
  try {
    webResult = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .resize({ width: 1600, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    thumbnailResult = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .resize({ width: 480, height: 360, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw unsupported(error);
  }

  const hash = hashImageVariants(webResult.data, thumbnailResult.data);
  return {
    hash,
    mimeType: "image/webp",
    web: {
      data: webResult.data,
      width: webResult.info.width,
      height: webResult.info.height,
      size: webResult.data.length,
    },
    thumbnail: {
      data: thumbnailResult.data,
      width: thumbnailResult.info.width,
      height: thumbnailResult.info.height,
      size: thumbnailResult.data.length,
    },
  };
}

export type ImageFetchResult =
  | { ok: true; asset: NormalizedImageAsset; finalUrl: string }
  | CappedFetchFailure
  | { ok: false; reason: "invalid_image" };

export async function fetchAndNormalizeImage(
  url: string,
  dependencies: { request?: CappedRequest } = {},
): Promise<ImageFetchResult> {
  const fetched = await fetchCapped(url, {
    maxBytes: MAX_IMAGE_SOURCE_BYTES,
    headers: { accept: "image/jpeg, image/png, image/webp" },
    request: dependencies.request,
  });
  if (!fetched.ok) return fetched;
  try {
    return {
      ok: true,
      asset: await normalizeImage(fetched.body),
      finalUrl: fetched.finalUrl,
    };
  } catch {
    return { ok: false, reason: "invalid_image" };
  }
}
