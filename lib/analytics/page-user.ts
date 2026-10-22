import "server-only";
import { cookies } from "next/headers";
import { PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { getMeSession } from "@/lib/me/session";
import { analyticsUserId, analyticsUserIdEnabled } from "./identity";

/**
 * 공개 화면 로더에 넘길 가명 user_id(2026-10-22, PR C) — gtag('config', …, { user_id }) 로 여러 기기의 방문을 한 사람으로 묶는다.
 *
 * - 비밀(ANALYTICS_USER_ID_SECRET)이 없거나 로그인 쿠키가 없으면 DB 를 읽지 않고 null.
 * - 로그인 쿠키(nmv_user)가 있는 응답은 Cloudflare 가 저장하지 않는다(next.config.ts) — 이 값이 남의 화면에 섞이지 않는다.
 *   거꾸로 로그인한 사람도 저장된 익명 사본을 받으면 이 값이 없다(그 화면의 이벤트는 client_id 로만 잇는다). 서버 이벤트에는 늘 붙는다.
 * - 한 요청 안의 세션 읽기는 getMeSession(React cache) 하나로 나눈다. 실패하면 null — 분석 때문에 화면이 멈추지 않는다.
 */
export async function analyticsUserIdForPage(): Promise<string | null> {
  try {
    if (!analyticsUserIdEnabled()) return null;
    if (!(await cookies()).has(PUBLIC_SESSION_COOKIE)) return null;
    const session = await getMeSession();
    return analyticsUserId(session?.user.id);
  } catch {
    return null;
  }
}
