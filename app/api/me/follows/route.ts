import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicAuthEnabled,
  requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { translatedCategory } from "@/components/home/i18n";
import { getTranslator } from "@/lib/i18n/dictionary";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { follow, listFollows, unfollow } from "@/lib/me/follows";
import { parseFollowKey } from "@/lib/me/follow-keys";
import { rateLimit } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 내 팔로 — 프로젝트·메이커·분야 묶음. 분야 이름은 ?locale= 의 말로 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const locale = new URL(request.url).searchParams.get("locale");
    const [follows, labels] = await Promise.all([listFollows(session.user.id), getTranslator(isLocale(locale) ? locale : DEFAULT_LOCALE, "labels")]);
    return Response.json({ ...follows, categories: follows.categories.map((item) => ({ ...item, label: translatedCategory(item.category, labels) })) },
      { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}

/** 팔로·풀기 — Origin·CSRF·세션을 보고, 한 계정 1분 60번까지 */
async function mutate(request: Request, change: typeof follow | typeof unfollow) {
  try {
    const user = await requirePublicMutation(request);
    if (!await rateLimit(`me-follow:${user.id}`, 60, 60_000)) throw new PublicAuthError(429, "rate_limited");
    const key = parseFollowKey(await readLoginJson(request));
    if (!key) throw new PublicAuthError(400, "invalid_request");
    await change(user.id, key);
    return Response.json({ ...key, following: change === follow }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}

export const PUT = webWriteRoute((request: Request) => mutate(request, follow), publicAuthErrorResponse);
export const DELETE = webWriteRoute((request: Request) => mutate(request, unfollow), publicAuthErrorResponse);
