/**
 * 화면용 썸네일 사본 — DB 에 둔 대표 이미지를 그 자리 크기의 WebP 로 줄여 보낸다(2026-10-06).
 *
 * 원본은 PNG 평균 233KB(상위 10% 581KB)·JPEG 173KB 를 그대로 보냈다. 홈 한 번이 36장이라 수 MB 를 받았고,
 * 주소에 확장자가 없어 Cloudflare 가 캐시하지 않아(DYNAMIC) 매번 Postgres 에서 읽었다. 확장자 `.webp` 가 붙은
 * 주소는 Cloudflare 기본 캐시 대상이라 원 서버까지 오는 것이 드물어진다. 원본 주소는 그대로 둔다(OG 메타 등).
 */

/** 64 는 목록 줄의 28px 아이콘용(2026-10-11 PERF-04) — 96 도 그 자리엔 세 배가 넘었다 */
export const OG_VARIANT_SIZES = [64, 96, 192, 320, 640, 960, 1200] as const;
export type OgVariantSize = typeof OG_VARIANT_SIZES[number];
const PREFIX = "/api/og-cache/";

/** `/api/og-cache/<slug>?…` → `/api/og-cache/<slug>.webp?…&size=<n>`. 우리 사본이 아니면 그대로 */
export function ogVariantSrc(src: string | null | undefined, size: OgVariantSize): string | null {
  if (!src) return null;
  if (!src.startsWith(PREFIX)) return src;
  const [path, query = ""] = src.split("?", 2);
  const slug = path.slice(PREFIX.length);
  if (!/^[a-z0-9-]+$/.test(slug)) return src;
  const params = new URLSearchParams(query);
  params.set("size", String(size));
  return `${PREFIX}${slug}.webp?${params}`;
}

/**
 * 폭 기준 srcset — "주소 320w, 주소 640w". 우리 사본이 아니면 크기를 고를 수 없어 null(src 만 쓴다).
 * 브라우저가 칸 폭(sizes)과 화면 배율로 고른다 — 작은 칸에 640px 를 받지 않는다.
 */
export function ogVariantSrcSet(src: string | null | undefined, widths: readonly OgVariantSize[]): string | null {
  if (!src) return null;
  const urls = widths.map((width) => ({ width, url: ogVariantSrc(src, width)! }));
  if (urls.some(({ url }) => url === src)) return null;
  return urls.map(({ width, url }) => `${url} ${width}w`).join(", ");
}

/** 화면 px 를 채우는 가장 작은 사본 크기 — 그보다 큰 것이 없으면 가장 큰 것 */
export function variantAtLeast(px: number): OgVariantSize {
  return OG_VARIANT_SIZES.find((size) => size >= px) ?? OG_VARIANT_SIZES[OG_VARIANT_SIZES.length - 1];
}

/** 요청의 크기 — 정해 둔 것만(캐시 열쇠가 끝없이 늘지 않게). 모르는 값은 640 */
export function variantSize(value: string | null): OgVariantSize {
  const size = Number(value);
  return (OG_VARIANT_SIZES as readonly number[]).includes(size) ? size as OgVariantSize : 640;
}

/**
 * 메모리 사본의 수명 — 공개 읽기(public-reads.ts)와 같은 30초. 사본은 DB 를 다시 보지 않고 나가므로, 수명이 없으면
 * 내리거나 지운 제품의 그림을 원 서버가 계속 내놓아 Cloudflare 의 두 번째 지우기(60초 뒤, cdn-purge) 뒤에 다시 채워졌다.
 * 같은 slug 를 새 제품이 다시 쓰면 옛 제품의 그림이 나갔다.
 */
const VARIANT_TTL_MS = 30_000;

/** 서버 메모리의 줄인 사본 — 인스턴스마다 최근 것 몇백 장. Cloudflare 가 놓친 요청만 여기까지 온다 */
export class VariantCache {
  private entries = new Map<string, { value: Buffer; expiresAt: number }>();
  constructor(private readonly limit = 400, private readonly now: () => number = Date.now) {}
  get(key: string): Buffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: Buffer): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + VARIANT_TTL_MS });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
