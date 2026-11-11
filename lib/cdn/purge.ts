/**
 * Cloudflare 캐시 지우기 — 내려간 제품의 상세(모든 `?_rsc=` 갈래)·썸네일·목록 화면을 태그로 지운다.
 * 사람이 고친 제품의 상세와, 웹 릴리스가 바뀐 뒤의 옛 HTML 도 같은 길로 지운다.
 *
 * 태그는 원 서버가 붙인다(next.config.ts 의 html·lists·p-<slug>, 썸네일의 og-<slug>). 주소로 지우면
 * 화면 이동용 사본의 `_rsc` 주소를 알 수 없어 남는다. Free 요금제는 태그 지우기가 계정 전체 분당 5회라
 * 한 요청에 모아 보낸다(요청 하나에 태그 100개까지).
 */

const API = "https://api.cloudflare.com/client/v4";
/** 제품마다 태그 둘(p-, og-)에 목록 태그 하나 — 100개 안에 든다 */
export const PURGE_BATCH = 45;

export type PurgeConfig = { zoneId: string; token: string };
export type PurgeResult = { ok: true } | { ok: false; status: number; error: string };

/** 토큰은 지우기 권한 하나만 가진 것을 발행 워커 환경변수로만 받는다 */
export function purgeConfig(env: Record<string, string | undefined> = process.env): PurgeConfig | null {
  const zoneId = env.CLOUDFLARE_ZONE_ID?.trim();
  const token = env.CLOUDFLARE_PURGE_TOKEN?.trim();
  return zoneId && token ? { zoneId, token } : null;
}

/**
 * 상세만 새로 받게 하는 줄(cdn_purges.reason) — 목록에서 빠지는 것이 아니다(2026-11-11 상세 엣지 캐시).
 * 상세는 엣지가 사본을 최대 5분(next.config.ts) 들고 있다. 사람이 고친 것은 그 5분을 기다리지 않고 1~2분 안에 보이게
 * 여기서 지운다. 목록(lists)은 지우지 않는다 — 목록은 늦어도 2분이면 스스로 새로 받고, 목록을 지우면
 * 홈의 지난 사본까지 사라져 다음 방문이 원 서버를 기다린다. 팔로 알림(lib/jobs/me/notifications.ts)도 이 줄을 읽지 않는다.
 * edited: 메이커·관리자의 제품 수정, 소개·이름 고치기. status: 트리거(0057)가 적지 않는 상태 바뀜(차단 해제·검증·비공개였던 것의 차단).
 */
export const DETAIL_EDIT_PURGE = "edited";
export const DETAIL_STATUS_PURGE = "status";
export const DETAIL_REFRESH_PURGES: ReadonlySet<string> = new Set([DETAIL_EDIT_PURGE, DETAIL_STATUS_PURGE]);

/** 모든 HTML·RSC 사본의 태그(next.config.ts) — 웹 릴리스가 바뀌면 한 번 지운다(lib/jobs/products/cdn-purge.ts) */
export const HTML_TAG = "html";

/** 이 줄들을 지우며 목록도 지워야 하는가 — 상세만 새로 받는 줄뿐이면 아니다 */
export function purgesLists(reasons: readonly string[]): boolean {
  return reasons.some((reason) => !DETAIL_REFRESH_PURGES.has(reason));
}

/**
 * 빈 slug 의 줄은 목록(lists)만 지운다 — 감사 보류를 한꺼번에 풀 때 제품마다 줄을 적지 않는다(lib/crawl/product-audit-hold.ts).
 * 제품마다 p-(상세 HTML·RSC·공유 카드·배지)와 og-(썸네일 변형) 둘이다.
 */
export function purgeTags(slugs: string[], options: { lists?: boolean } = {}): string[] {
  const tags = [...new Set(slugs.filter(Boolean).flatMap((slug) => [`p-${slug}`, `og-${slug}`]))];
  return options.lists === false ? tags : [...tags, "lists"];
}

export async function purgeByTags(config: PurgeConfig, tags: string[], fetchImpl: typeof fetch = fetch): Promise<PurgeResult> {
  try {
    const response = await fetchImpl(`${API}/zones/${config.zoneId}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; errors?: { message?: string }[] } | null;
    if (response.ok && body?.success) return { ok: true };
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `http ${response.status}`;
    return { ok: false, status: response.status, error: message.slice(0, 300) };
  } catch (error) {
    return { ok: false, status: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}
