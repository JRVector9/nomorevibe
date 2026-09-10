import { safeFetch, readBodyCapped, type FetchMode } from "@/lib/net/fetch";
import * as repo from "./repository";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * og:image를 우리 저장소(DB)에 복사한다.
 * 핫링크하지 않는 이유: 상대 서버 장애 시 목록이 깨지고, 이미지가 사후에 바꿔치기될 수 있다.
 * safeFetch를 쓰므로 등록자가 og:image에 내부망 주소를 심어도 차단된다.
 *
 * 누가 기다리는지를 부르는 쪽이 정한다(FetchMode). 메이커 등록은 interactive, 발행 잡은
 * background다 — 발행이 interactive로 받으면 느린 리다이렉트가 이어질 때 발행 워커를 최대 60초
 * 붙잡는다(codex가 짚음).
 */
export async function cacheOgImage(imageUrl: string, slug: string, mode: FetchMode = "interactive"): Promise<string | null> {
  try {
    const fetched = await safeFetch(imageUrl, mode);
    if (!fetched) return null;
    const type = fetched.response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!fetched.response.ok || !ALLOWED_TYPES.has(type)) {
      // 안 읽는 본문도 닫는다. 닫지 않으면 연결이 풀로 돌아가지 않고, 백그라운드에서는 그 서버의
      // 자리까지 기한(10초)이 끝날 때까지 묶인다
      await fetched.response.body?.cancel().catch(() => {});
      return null;
    }

    const buf = await readBodyCapped(fetched.response, MAX_IMAGE_BYTES + 1);
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;

    await repo.putOgImage(slug, type, buf);
    return `/api/og-cache/${slug}`;
  } catch {
    return null;
  }
}
