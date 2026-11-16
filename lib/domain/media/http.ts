import sharp from "sharp";
import { watermarkLayers } from "@/lib/images/watermark";

import type { MediaStorage, MediaVariant } from "./storage";

const HASH = /^[a-f0-9]{64}$/;

export function createMediaGet(storage: MediaStorage) {
  return async function mediaGet(
    request: Request,
    context: { params: Promise<{ hash: string }> },
  ): Promise<Response> {
    const { hash } = await context.params;
    if (!HASH.test(hash)) return new Response("Not found", { status: 404 });
    const requestedVariant = new URL(request.url).searchParams.get("variant") ?? "web";
    if (requestedVariant !== "web" && requestedVariant !== "thumbnail") {
      return new Response("Invalid variant", { status: 400 });
    }
    const variant: MediaVariant = requestedVariant;
    const image = await storage.get(hash, variant);
    if (!image) return new Response("Not found", { status: 404 });
    let data = image.data;
    try {
      const imagePipeline = sharp(data, { pages: 1, limitInputPixels: 40_000_000 });
      const { width, height } = await imagePipeline.metadata();
      const layers = await watermarkLayers(width ?? 0, height ?? 0);
      if (layers.length) data = await imagePipeline.composite(layers).webp({ quality: 82 }).toBuffer();
    } catch {
      return new Response("Image unavailable", { status: 422, headers: { "Cache-Control": "private, no-store" } });
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(data.length),
      },
    });
  };
}
