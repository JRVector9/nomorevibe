import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { ImageResponse } from "next/og";
import type { OverlayOptions } from "sharp";
import { isWatermarkIcon, WATERMARK_MIN_HEIGHT, WATERMARK_MIN_WIDTH } from "./watermark-policy";

let font: Promise<ArrayBuffer> | undefined;
function watermarkFont(): Promise<ArrayBuffer> {
  if (!font) {
    // Same bundled face as the share card. Satori turns glyphs into paths: no system fonts or network.
    font = readFile(path.join(process.cwd(), "assets/fonts/noto-sans-kr-400.woff"))
      .then((data) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      .catch((error) => { font = undefined; throw error; });
  }
  return font;
}

// Only the small transparent label is rasterized. Bound the cache even for arbitrary maker image widths.
const labels = new Map<number, Promise<Buffer>>();
async function label(width: number, height: number, fontSize: number): Promise<Buffer> {
  let rendered = labels.get(width);
  if (!rendered) {
    rendered = (async () => Buffer.from(await new ImageResponse(createElement("div", { style: {
      display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center",
      fontFamily: "Watermark", fontSize, color: "rgba(255,255,255,0.78)",
      WebkitTextStrokeWidth: Math.max(0.5, fontSize * 0.04), WebkitTextStrokeColor: "rgba(0,0,0,0.28)",
      textShadow: "0px 1px 1px rgba(0,0,0,0.65)", whiteSpace: "nowrap",
    } }, "nomorevibe.com"), {
      width, height, fonts: [{ name: "Watermark", data: await watermarkFont(), weight: 400, style: "normal" }],
    }).arrayBuffer()))();
    rendered.catch(() => labels.delete(width));
    labels.set(width, rendered);
    if (labels.size > 64) labels.delete(labels.keys().next().value!);
  }
  return rendered;
}

/** Composite after orientation/resize, so the label follows the delivered image, never the stored original. */
export async function watermarkLayers(width: number, height: number, kind: string | null = null): Promise<OverlayOptions[]> {
  if (width < WATERMARK_MIN_WIDTH || height < WATERMARK_MIN_HEIGHT || isWatermarkIcon(kind)) return [];
  const fontSize = Math.max(9, Math.round(width * 0.024));
  const margin = Math.max(4, Math.round(width * 0.012));
  const labelWidth = Math.ceil(fontSize * 8.5);
  const labelHeight = fontSize * 2;
  if (height < labelHeight + margin * 2) return []; // very wide, short wordmarks cannot fit legible text
  return [{ input: await label(labelWidth, labelHeight, fontSize),
    left: width - labelWidth - margin, top: height - labelHeight - margin }];
}
