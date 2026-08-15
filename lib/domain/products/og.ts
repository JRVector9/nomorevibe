import { safeFetch, readBodyCapped } from "@/lib/net/fetch";
import * as repo from "./repository";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * og:image를 우리 저장소(DB)에 복사한다.
 * 핫링크하지 않는 이유: 상대 서버 장애 시 목록이 깨지고, 이미지가 사후에 바꿔치기될 수 있다.
 * safeFetch를 쓰므로 등록자가 og:image에 내부망 주소를 심어도 차단된다.
 */
export async function cacheOgImage(imageUrl: string, slug: string): Promise<string | null> {
  try {
    const fetched = await safeFetch(imageUrl);
    if (!fetched || !fetched.response.ok) return null;

    const type = fetched.response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!ALLOWED_TYPES.has(type)) return null;

    const buf = await readBodyCapped(fetched.response, MAX_IMAGE_BYTES + 1);
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;

    await repo.putOgImage(slug, type, buf);
    return `/api/og-cache/${slug}`;
  } catch {
    return null;
  }
}
