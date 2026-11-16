/** Delivery revision: change this when the rendered watermark changes, never the stored asset/hash. */
export const IMAGE_WATERMARK_VERSION = "1";
/** Home covers request 320/640px; detail requests 1200px. Icon copies are 64/96/192px. */
export const WATERMARK_MIN_WIDTH = 200;
export const WATERMARK_MIN_HEIGHT = 64;

export function isWatermarkIcon(kind: string | null): boolean {
  return kind === "github_avatar" || kind === "site_icon" || kind === "default";
}

/** A fresh URL bypasses old browser/Cloudflare copies without changing the stored source. */
export function watermarkedImageUrl(src: string): string {
  const [pathname, query = ""] = src.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("wm", IMAGE_WATERMARK_VERSION);
  return `${pathname}?${params}`;
}
